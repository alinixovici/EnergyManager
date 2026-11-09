(() => {
  'use strict';

  const utcStamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const filePattern = /^([A-Z0-9]{10}) (System|Meter) Data (\d{4}-\d{2})\.csv$/;
  const lineWindow = 4096;
  const chunkSize = 1024 * 1024;
  const forecastWindow = 15 * 60 * 1000;
  const maxSampleGap = 6 * 60 * 1000;
  const idleWatts = 25;
  const decoder = new TextDecoder();

  function filePairs(files) {
    const pairs = new Map();
    for (const file of files) {
      const match = file.name.match(filePattern);
      if (!match) continue;
      const [, serial, type, month] = match;
      const key = `${serial}/${month}`;
      if (!pairs.has(key)) pairs.set(key, { key, serial, month });
      pairs.get(key)[type.toLowerCase()] = file;
    }
    return [...pairs.values()].filter(pair => pair.system).sort((a, b) => b.month.localeCompare(a.month));
  }

  async function csvHeader(file) {
    const prefix = await file.slice(0, lineWindow).text();
    const end = prefix.indexOf('\n');
    if (end < 0) throw new Error('Waiting for the logger to write the CSV header.');
    const names = prefix.slice(0, end).trimEnd().split(',');
    if (names[0] !== 'Time' || !names.includes('PPV') && !names.includes('PV Gen Today')) {
      throw new Error('This file does not have a Solar Logger CSV header.');
    }
    return { end: end + 1, names, columns: new Map(names.map((name, index) => [name, index])) };
  }

  function cells(line, header) {
    const values = line.trimEnd().split(',');
    return values.length === header.names.length && utcStamp.test(values[0]) ? values : null;
  }

  function numeric(value) {
    return value && Number.isFinite(Number(value)) ? Number(value) : null;
  }

  async function tail(file, limit = 16384) {
    if (!file || !file.size) return [];
    const header = await csvHeader(file);
    const start = Math.max(header.end, file.size - limit);
    const chunks = [];
    for (let offset = start; offset < file.size; offset += chunkSize) {
      chunks.push(await file.slice(offset, Math.min(offset + chunkSize, file.size)).text());
    }
    let text = chunks.join('');
    if (start > header.end) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').slice(0, -1).map(line => cells(line, header)).filter(Boolean).map(values => ({
      stamp: values[0],
      number: field => numeric(values[header.columns.get(field)]),
    }));
  }

  async function latest(systemFile, meterFile) {
    const [system, meter] = await Promise.all([tail(systemFile), tail(meterFile)]);
    const newest = system.at(-1);
    return { system: newest, meter: newest ? meter.findLast(row => row.stamp === newest.stamp) : undefined };
  }

  function forecastStart(stamp, windowMs = forecastWindow) {
    return new Date(stamp).getTime() - windowMs;
  }

  async function batteryForecast(file, precedingFile, latestRow, now = Date.now(), windowMs = forecastWindow, history) {
    if (!latestRow) return { state: 'missing' };
    const end = new Date(latestRow.stamp).getTime();
    if (!Number.isFinite(end) || now - end > maxSampleGap) return { state: 'stale' };
    const current = latestRow.number('SOC%');
    const power = latestRow.number('PBat');
    if (current == null || current < 0 || current > 100 || power == null) return { state: 'missing' };
    if (Math.abs(power) < idleWatts) return { state: 'idle' };
    const target = power > 0 ? 20 : 100;
    if (power < 0 && current >= target) return { state: 'reached', target };

    const start = forecastStart(latestRow.stamp, windowMs);
    // A bounded read covers the window even at the one-second sampling rate.
    const readSize = 256 * 1024 * Math.ceil(windowMs / forecastWindow);
    const recent = history ?? await tail(file, readSize);
    const rows = !history && precedingFile && (!recent.length || Date.parse(recent[0].stamp) > start)
      ? [...await tail(precedingFile, readSize), ...recent] : recent;
    const samples = new Map();
    for (const row of [...rows, latestRow]) {
      const at = new Date(row.stamp).getTime();
      const watts = row.number('PBat');
      const soc = row.number('SOC%');
      if (at >= start - maxSampleGap && at <= end && watts != null && soc != null && soc >= 0 && soc <= 100) {
        samples.set(at, { at, watts, soc });
      }
    }
    const sorted = [...samples.values()].sort((a, b) => a.at - b.at);
    const first = sorted.findLastIndex(sample => sample.at <= start);
    const window = first < 0 ? [] : sorted.slice(first);
    const minimumSamples = windowMs === 10 * 60000 ? 3 : 4;
    if (window.length < minimumSamples || window.some((sample, i) => i > 0 && sample.at - window[i - 1].at > maxSampleGap)) {
      if (!history) {
        // Try older complete windows at one-minute steps, up to three hours back.
        const direction = Math.sign(power);
        const historySize = 4 * chunkSize;
        const older = [...await tail(precedingFile, historySize), ...await tail(file, historySize)];
        let next = end - 60000;
        for (let i = older.length - 1; i >= 0; i--) {
          const row = older[i];
          const at = Date.parse(row.stamp);
          if (at < end - 3 * 3600000) break;
          if (at > next || Math.sign(row.number('PBat')) !== direction) continue;
          next = at - 60000;
          const prior = await batteryForecast(file, precedingFile, row, at, windowMs, older);
          if (!Number.isFinite(prior.socPerHour) || Math.sign(prior.socPerHour) !== -direction) continue;
          const hours = (target - current) / prior.socPerHour;
          return { ...prior, current, target, hours, historyEnd: row.stamp,
            state: hours > 0 ? 'ready' : 'reached' };
        }
      }
      return { state: 'short' };
    }
    if (window[0].at < start) {
      const [before, after] = window;
      const fraction = (start - before.at) / (after.at - before.at);
      window[0] = {
        at: start,
        watts: before.watts + fraction * (after.watts - before.watts),
        soc: before.soc + fraction * (after.soc - before.soc),
      };
    }

    let net = 0;
    let gross = 0;
    const energy = [0];
    for (let i = 1; i < window.length; i++) {
      const before = window[i - 1];
      const after = window[i];
      const duration = (after.at - before.at) / 2;
      net += (before.watts + after.watts) * duration;
      gross += (Math.abs(before.watts) + Math.abs(after.watts)) * duration;
      energy.push(net / 3600000000); // Watt-milliseconds to kWh.
    }
    const average = net / windowMs;
    if (Math.abs(average) < idleWatts || Math.sign(average) !== Math.sign(power) || Math.abs(net) < gross / 2) {
      return { state: 'mixed', average };
    }
    if ((window[0].soc - current) * Math.sign(average) < 1) return { state: 'flat', average };

    // Fit measured SoC against cumulative battery energy, then project at the recent average power.
    const meanEnergy = energy.reduce((sum, value) => sum + value, 0) / energy.length;
    const meanSoc = window.reduce((sum, sample) => sum + sample.soc, 0) / window.length;
    let covariance = 0;
    let variance = 0;
    for (let i = 0; i < window.length; i++) {
      const difference = energy[i] - meanEnergy;
      covariance += difference * (window[i].soc - meanSoc);
      variance += difference ** 2;
    }
    const slope = covariance / variance;
    const socPerHour = slope * average / 1000;
    if (slope < 0 && power > 0 && current <= target) {
      return { state: 'reached', current, target, socPerHour };
    }
    const hours = (target - current) / socPerHour;
    if (!(slope < 0 && Number.isFinite(hours) && hours > 0)) return { state: 'flat', average };
    return { state: 'ready', current, target, average, hours, socPerHour };
  }

  // Search by byte offset, moving each boundary to a complete CSV row.
  async function lowerBound(file, headerEnd, target) {
    let low = headerEnd;
    let high = file.size;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const base = Math.max(0, mid - lineWindow);
      const bytes = new Uint8Array(await file.slice(base, mid + lineWindow).arrayBuffer());
      const local = mid - base;
      const left = local > 0 ? bytes.lastIndexOf(10, local - 1) + 1 : 0;
      const right = bytes.indexOf(10, local);
      const rowStart = Math.max(headerEnd, base + left);
      const stamp = decoder.decode(bytes.subarray(rowStart - base, rowStart - base + 20));
      if (!utcStamp.test(stamp) && right >= 0) throw new Error('Unexpected timestamp in the System Data CSV.');
      if (right < 0 || stamp >= target) high = rowStart;
      else low = base + right + 1;
    }
    return low;
  }

  function chartValues(values, columns) {
    const battery = numeric(values[columns.get('PBat')]);
    const grid = numeric(values[columns.get('PAC')]);
    return [
      battery === null ? null : Math.min(0, battery), battery === null ? null : Math.max(0, battery),
      grid === null ? null : Math.max(0, grid), grid === null ? null : Math.min(0, grid),
      numeric(values[columns.get('Load')]), numeric(values[columns.get('PPV')]), numeric(values[columns.get('SOC%')]),
    ];
  }

  async function history(file, date, previous) {
    const from = `${date}T00:00:00Z`;
    // WD's dashboard replaces Date.parse with a function that returns Date objects.
    const dayStart = new Date(from).getTime();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dayStart)) throw new Error('Choose a valid chart date.');
    const to = new Date(dayStart + 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
    const header = await csvHeader(file);
    const resume = previous && previous.date === date && previous.name === file.name && previous.size <= file.size &&
      previous.identity === file.identity && previous.modified <= file.lastModified;
    if (resume && (previous.finished || previous.size === file.size && previous.modified === file.lastModified)) return previous;
    const state = resume ? previous : { date, name: file.name, minutes: new Map(), cursor: await lowerBound(file, header.end, from) };
    const end = await lowerBound(file, Math.max(header.end, state.cursor), to);
    for (let at = state.cursor; at < end;) {
      const text = await file.slice(at, Math.min(end, at + chunkSize)).text();
      const newline = text.lastIndexOf('\n');
      if (newline < 0) break;
      for (const line of text.slice(0, newline).split('\n')) {
        const values = cells(line, header);
        if (!values || values[0] < from || values[0] >= to) continue;
        const minute = Number(values[0].slice(11, 13)) * 60 + Number(values[0].slice(14, 16));
        if (!state.minutes.has(minute)) state.minutes.set(minute, { sums: Array(7).fill(0), counts: Array(7).fill(0) });
        const bucket = state.minutes.get(minute);
        chartValues(values, header.columns).forEach((value, index) => {
          if (value === null) return;
          bucket.sums[index] += value;
          bucket.counts[index]++;
        });
      }
      at += newline + 1; // Solar Logger CSV rows use ASCII fields.
      state.cursor = at;
    }
    const nextStamp = end < file.size && end === state.cursor ? await file.slice(end, end + 20).text() : '';
    state.finished = utcStamp.test(nextStamp) && nextStamp >= to;
    state.identity = file.identity;
    state.size = file.size;
    state.modified = file.lastModified;
    return state;
  }

  function points(state) {
    return state ? [...state.minutes].sort((a, b) => a[0] - b[0]).map(([minute, bucket]) => ({
      minute, values: bucket.sums.map((sum, index) => bucket.counts[index] ? sum / bucket.counts[index] : null),
    })) : [];
  }

  window.solarDashboardData = { filePairs, latest, history, points, batteryForecast, forecastStart };
})();
