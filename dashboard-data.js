(() => {
  'use strict';

  const utcStamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const filePattern = /^([A-Z0-9]{10}) (System|Meter) Data (\d{4}-\d{2})\.csv$/;
  const lineWindow = 4096;
  const chunkSize = 1024 * 1024;
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

  function forecastBatteryTarget(plan, now, power) {
    if (!Number.isFinite(power) || power === 0 || plan?.ok !== true || !Array.isArray(plan.forecast)) return null;
    const charging = power < 0;
    const target = charging ? 100 : plan.reserve;
    if (!Number.isFinite(target) || target < 0 || target > 100) return null;

    let at = Infinity;
    for (const { time, end, soc, end_soc } of plan.forecast) {
      if (![time, end, soc, end_soc].every(Number.isFinite) || end <= time || end < now ||
          soc < 0 || soc > 100 || end_soc < 0 || end_soc > 100) continue;
      const reachesTarget = charging ? soc < target && end_soc >= target : soc > target && end_soc <= target;
      if (!reachesTarget) continue;

      const crossing = time + (target - soc) * (end - time) / (end_soc - soc);
      if (crossing >= now) at = Math.min(at, crossing);
    }
    return Number.isFinite(at) ? { at, target, charging } : null;
  }

  function batteryPlanForecast(root, readPlan) {
    const status = root.querySelector('#solar-battery-reserve-forecast');
    const label = status.querySelector('span');
    const time = status.querySelector('time');
    let plan, request, batteryPower;
    let lastCheck = 0;

    function render(now) {
      const prediction = forecastBatteryTarget(plan, now, batteryPower);
      status.hidden = prediction === null;
      if (!prediction) return;

      const { at, target, charging } = prediction;
      const text = 'Estimated SoC ' + target + '% at ';
      if (label.textContent !== text) label.textContent = text;
      status.classList.toggle('is-low', !charging);

      const date = new Date(at * 1000);
      const timeZone = plan.timezone || 'UTC';
      const clock = date.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const day = date.toLocaleDateString('en-GB', { timeZone, day: 'numeric', month: 'short' });
      const formatted = clock + ' on ' + day;
      time.dateTime = date.toISOString();
      if (time.textContent !== formatted) time.textContent = formatted;
    }

    function refresh(power = batteryPower) {
      batteryPower = power;
      if (document.hidden || root.querySelector('#solar-overview').hidden) return;
      const now = Date.now();
      if (Number.isFinite(power) && power !== 0 && !request && now - lastCheck >= 60000) {
        lastCheck = now;
        const pending = request = Promise.resolve().then(readPlan);
        pending.then(snapshot => {
          if (request === pending) plan = snapshot;
        }).catch(() => {
          if (request === pending) plan = null;
        }).finally(() => {
          if (request !== pending) return;
          request = undefined;
          render(Date.now() / 1000);
        });
      }
      render(now / 1000);
    }

    function reset() {
      plan = request = batteryPower = undefined;
      lastCheck = 0;
      status.hidden = true;
    }

    root.querySelector('[aria-controls="solar-overview"], [data-solar-panel="overview"]')
      ?.addEventListener('click', () => setTimeout(refresh, 0));
    return { refresh, reset };
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

  const figureLayout = { left: 76, right: 40, plotHeight: 240, title: 17, label: 12, value: 14 };
  const figureWidths = new WeakMap();

  function responsiveFigureWidth(svg, redraw) {
    let layout = figureWidths.get(svg);
    if (!layout) {
      layout = {};
      figureWidths.set(svg, layout);
      new ResizeObserver(() => {
        if (svg.clientWidth && svg.clientWidth !== layout.width) layout.redraw();
      }).observe(svg);
    }
    layout.width = svg.clientWidth || 900;
    layout.redraw = redraw;
    return layout.width;
  }

  window.solarDashboardData = { filePairs, latest, history, points, batteryPlanForecast, figureLayout, responsiveFigureWidth };
})();

(() => {
  'use strict';

  const tooltip = document.getElementById('solar-chart-tooltip');
  const charts = new WeakMap();
  let active;

  function hide(state) {
    state.point = null;
    state.guide.setAttribute('visibility', 'hidden');
    if (active === state) {
      tooltip.hidden = true;
      active = null;
    }
  }

  function show(chart, state, point) {
    const matrix = chart.getScreenCTM();
    if (!state.lookup || !matrix || !chart.getClientRects().length) {
      hide(state);
      return;
    }
    const { x, y } = new DOMPoint(point.x, point.y).matrixTransform(matrix.inverse());
    const result = state.lookup(x, y);
    if (!result?.rows.length) {
      hide(state);
      return;
    }

    if (active && active !== state) hide(active);
    active = state;
    state.point = point;
    if (result.guide) {
      const { x: guideX, top, bottom } = result.guide;
      state.guide.setAttribute('x1', guideX);
      state.guide.setAttribute('x2', guideX);
      state.guide.setAttribute('y1', top);
      state.guide.setAttribute('y2', bottom);
      state.guide.setAttribute('visibility', 'visible');
      if (state.guide.parentNode !== chart) chart.append(state.guide);
    } else {
      state.guide.setAttribute('visibility', 'hidden');
    }

    const title = document.createElement('strong');
    title.textContent = result.title;
    const rows = result.rows.map(({ label, value, color }) => {
      const row = document.createElement('div');
      const name = document.createElement('span');
      name.textContent = label;
      if (color) {
        const swatch = document.createElement('i');
        swatch.style.backgroundColor = color;
        name.prepend(swatch);
      }
      const reading = document.createElement('b');
      reading.textContent = value;
      row.append(name, reading);
      return row;
    });
    tooltip.replaceChildren(title, ...rows);
    tooltip.hidden = false;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const viewport = document.documentElement;
    const left = point.x + width + 20 <= viewport.clientWidth ? point.x + 12 : point.x - width - 12;
    const top = point.y + height + 20 <= viewport.clientHeight ? point.y + 12 : point.y - height - 12;
    tooltip.style.left = Math.max(8, Math.min(left, viewport.clientWidth - width - 8)) + 'px';
    tooltip.style.top = Math.max(8, Math.min(top, viewport.clientHeight - height - 8)) + 'px';
  }

  function attach(chart, lookup) {
    if (!tooltip) return;
    let state = charts.get(chart);
    if (!state) {
      const guide = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      guide.setAttribute('class', 'solar-chart-guide');
      guide.setAttribute('vector-effect', 'non-scaling-stroke');
      guide.setAttribute('aria-hidden', 'true');
      state = { guide, point: null };
      charts.set(chart, state);
      chart.addEventListener('pointermove', event => {
        if (event.pointerType !== 'touch') show(chart, state, { x: event.clientX, y: event.clientY });
      });
      for (const type of ['pointerleave', 'pointerdown', 'pointercancel']) {
        chart.addEventListener(type, () => hide(state));
      }
    }
    state.lookup = lookup;
    if (state.point) show(chart, state, state.point);
  }

  function clear(chart) {
    const state = charts.get(chart);
    if (!state) return;
    hide(state);
    state.lookup = null;
  }

  for (const type of ['scroll', 'resize', 'blur']) {
    window.addEventListener(type, () => { if (active) hide(active); }, { capture: true, passive: true });
  }
  window.SolarLoggerChartHover = { attach, clear };
})();

(() => {
  'use strict';

  const namespace = 'http://www.w3.org/2000/svg';
  const width = 64, height = 34, gap = 6;
  function append(parent, tag, attributes, content) {
    const node = document.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (content !== undefined) node.textContent = content;
    parent.append(node);
    return node;
  }

  function draw(svg, { time, timeZone, x, top, left, right, before = x, after = x }) {
    if (!Number.isFinite(time) || !Number.isFinite(x) || x < left || x > right || right - left < width) return;
    const timestamp = time * 1000;
    const date = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short' });
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = date.formatToParts(timestamp);
    const day = parts.find(part => part.type === 'day').value;
    const month = parts.find(part => part.type === 'month').value.slice(0, 3);
    const leftOption = Math.min(x, before) - gap - width;
    const rightOption = Math.max(x, after) + gap;
    const boxX = leftOption >= left ? leftOption : rightOption + width <= right ? rightOption
      : Math.max(left, Math.min(x - width / 2, right - width));
    const badge = append(svg, 'g', { class: 'solar-cursor-label', 'pointer-events': 'none' });
    append(badge, 'rect', { x: boxX, y: top, width, height, fill: '#fff', opacity: 0.95 });
    const style = { x: boxX + width - 5, 'text-anchor': 'end',
      'font-size': 12, 'font-weight': 650, fill: '#34465A' };
    append(badge, 'text', { ...style, y: top + 15 }, day + month);
    append(badge, 'text', { ...style, y: top + 30 }, clock.format(timestamp) + ':');
  }

  window.SolarLoggerCursor = { draw, height };
})();
