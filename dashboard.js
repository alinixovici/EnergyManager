(() => {
  'use strict';

  const root = document.getElementById('solar-console');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = 'true';
  const data = window.solarDashboardData;
  const id = name => root.querySelector(`#solar-${name}`);
  const dateInput = id('history-date');
  const dateText = id('history-date-text');
  const chart = id('power-chart');
  const empty = id('chart-empty');
  const tooltip = id('chart-tooltip');
  const gauge = id('soc-gauge');
  const forecastChart = id('battery-forecast-chart');
  const zoomIn = id('chart-zoom-in');
  const zoomOut = id('chart-zoom-out');
  const handTool = id('chart-hand');
  const autoFit = id('chart-auto-fit');
  const xRangeButtons = [...root.querySelectorAll('.solar-x-range')];
  const minPowerSpan = 50;
  const forecastMaxAge = 6 * 60000;
  const manageButton = id('manage-logs');
  const logManager = id('log-manager');
  const logMonth = id('log-month');
  const recycleButton = id('recycle-month');
  const series = [
    ['Battery charge', '#7256a1'], ['Battery discharge', '#1a6194'], ['Grid export', '#FFC000', true],
    ['Grid import', '#FF0000', true], ['Home demand', '#4EA72E', true], ['PV power', '#8b590b'], ['Battery SoC', '#37404a'],
  ];
  const checks = [];
  let sourceSerial;
  let sourcePath;
  let nasSource;
  let managedFiles = [];
  let recycling = false;
  let cache;
  let drawn;
  let powerRange;
  let timeRange;
  let chartDrag;
  let busy = false;
  let pendingDateRefresh = false;
  let forecast = { state: 'missing' };
  let forecastRequest;
  let forecastStamp;
  let forecastChecked = 0;

  const utcDate = () => new Date().toISOString().slice(0, 10);
  const displayDate = value => value.split('-').reverse().join('-');
  const monthOf = file => file.name.slice(-11, -4);
  const monthLabel = month => new Date(month + '-01T00:00:00Z')
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const write = (name, value) => { id(name).textContent = value; };
  const kilowatts = value => ((Math.abs(value) < 5 ? 0 : value) / 1000)
    .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const flowPower = value => value == null ? '—' : `${kilowatts(Math.abs(value))} kW`;
  const energy = (value, unit = '') => value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + unit;
  const timeOf = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const stateOf = (value, positive, negative) => value == null ? '' : value > 0 ? positive : value < 0 ? negative : 'Idle';

  function arrow(name, direction) {
    const line = id(`flow-${name}`);
    if (direction) line.dataset.direction = direction > 0 ? 'right' : 'left';
    else delete line.dataset.direction;
  }

  function showCurrent(serial, system, meter) {
    const pv = system?.number('PPV');
    const load = system?.number('Load');
    const battery = system?.number('PBat');
    const grid = system?.number('PAC');
    const soc = system?.number('SOC%');
    const validSoc = soc != null && soc >= 0 && soc <= 100;
    write('battery-soc', validSoc ? `${Math.round(soc)}%` : '—');
    gauge.setAttribute('aria-hidden', String(!validSoc));
    gauge.setAttribute('aria-valuenow', validSoc ? soc : 0);
    gauge.style.setProperty('--solar-soc-level', `${validSoc ? soc : 0}%`);
    write('pv-state', stateOf(pv, 'Generating', 'Idle'));
    write('battery-state', stateOf(battery, 'Discharging', 'Charging'));
    write('grid-state', stateOf(grid, 'Exporting', 'Importing'));
    write('pv-today', energy(meter?.number('PV Gen Today'), '\u00a0kWh'));
    write('home-today', energy(meter?.number('Consumption Today'), '\u00a0kWh'));
    write('battery-energy-label', battery > 0 ? 'discharged today' : 'charged today');
    write('battery-today', energy(meter?.number(battery > 0 ? 'Batt Discharge Today' : 'Batt Charge Today'), ' kWh'));
    write('inverter-serial', serial ?? '—');
    write('inverter-today', energy(meter?.number('Combined Gen Today'), '\u00a0kWh'));
    write('inverter-total', energy(meter?.number('Combined Gen Total'), '\u00a0kWh'));
    write('inverter-import-total', energy(meter?.number('Import Total'), '\u00a0kWh'));
    write('inverter-export-total', energy(meter?.number('Export Total'), '\u00a0kWh'));
    write('inverter-import-today', energy(meter?.number('Import Today'), '\u00a0kWh'));
    write('inverter-export-today', energy(meter?.number('Export Today'), '\u00a0kWh'));
    write('inverter-import-now', flowPower(grid == null ? null : Math.max(0, -grid)));
    write('inverter-export-now', flowPower(grid == null ? null : Math.max(0, grid)));
    write('flow-pv-power', flowPower(pv));
    write('flow-home-power', flowPower(load));
    write('flow-battery-power', flowPower(battery));
    write('flow-grid-power', flowPower(grid));
    arrow('pv', pv > 0 ? 1 : 0);
    arrow('home', load > 0 ? 1 : 0);
    arrow('battery', battery ? -Math.sign(battery) : 0);
    arrow('grid', grid ? Math.sign(grid) : 0);
  }

  function svg(tag, attrs, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function forecastDuration(hours) {
    const minutes = Math.max(1, Math.round(hours * 60));
    const wholeHours = Math.floor(minutes / 60);
    return wholeHours ? `${wholeHours} h ${minutes % 60} min` : `${minutes} min`;
  }

  function drawForecast() {
    const width = forecastChart.clientWidth;
    if (forecast.state !== 'ready' || !width) return;
    const { current, target, hours } = forecast;
    const height = 96;
    const left = 40, right = width - 14;
    const y = percent => 71 - percent * .57;
    const label = (x, at, text, anchor) => svg('text', { x, y: at, 'text-anchor': anchor }, text);
    forecastChart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    forecastChart.replaceChildren();
    for (const tick of [...new Set([0, 100, target])]) {
      forecastChart.append(svg('line', { x1: left, x2: right, y1: y(tick), y2: y(tick),
        class: tick === target ? 'solar-forecast-target' : 'solar-forecast-gridline' }),
        label(left - 6, y(tick) + 4, `${tick}%`, 'end'));
    }
    forecastChart.append(svg('line', { x1: left, x2: right, y1: y(current), y2: y(target), class: 'solar-forecast-line' }),
      svg('circle', { cx: left, cy: y(current), r: 3.5 }), svg('circle', { cx: right, cy: y(target), r: 3.5 }),
      label(left, 89, 'Now', 'start'), label(right, 89, `In ${forecastDuration(hours)}`, 'end'));
    forecastChart.setAttribute('aria-label', `Linear battery forecast from ${Math.round(current)}% to ${target}% in ${forecastDuration(hours)}.`);
  }

  function showForecast(result) {
    forecast = result;
    const ready = result.state === 'ready';
    const messages = {
      missing: 'Waiting for battery readings.',
      stale: 'The latest battery reading is too old for a live estimate.',
      idle: 'Battery idle. The forecast appears when charging or discharging resumes and there is a clear trend.',
      reached: `Battery is already at or beyond ${result.target}%.`,
      short: 'Waiting for 15 minutes of readings at 5-minute intervals or faster.',
      mixed: 'Recent battery power changed direction or is too low for an estimate.',
      flat: 'Recent SoC readings don’t show a clear trend yet.',
      unavailable: 'Could not read recent battery data.',
    };
    const summary = id('battery-forecast-status');
    const title = ready ? `Estimated time to ${result.target}%` : messages[result.state];
    if (summary.textContent !== title) summary.textContent = title;
    id('battery-forecast-time').hidden = !ready;
    write('battery-forecast-time', ready ? forecastDuration(result.hours) : '');
    write('battery-forecast-rate', ready ? `${flowPower(result.average)} avg · Last 15 min` : '');
    if (ready) forecastChart.removeAttribute('hidden');
    else forecastChart.setAttribute('hidden', '');
    if (ready) drawForecast();
  }

  function resetForecast(state = 'missing') {
    forecastRequest = forecastStamp = undefined;
    forecastChecked = 0;
    showForecast({ state });
  }

  function refreshForecast(system, latestFile, pairs, serial) {
    if (!system) { resetForecast(); return; }
    const now = Date.now();
    const start = data.forecastStart(system.stamp);
    if (!Number.isFinite(start)) { resetForecast(); return; }
    if (now - new Date(system.stamp).getTime() > forecastMaxAge) {
      if (forecast.state !== 'stale') resetForecast('stale');
      return;
    }
    if (forecastRequest || forecastStamp === system.stamp || now - forecastChecked < 15000) return;
    forecastChecked = now;
    const startMonth = new Date(start).toISOString().slice(0, 7);
    const preceding = startMonth !== system.stamp.slice(0, 7)
      ? pairs.find(pair => pair.serial === serial && pair.month === startMonth)?.system : undefined;
    const request = getFile(preceding).then(file => data.batteryForecast(latestFile, file, system, now));
    forecastRequest = request;
    request.then(result => {
      if (forecastRequest !== request) return;
      forecastStamp = system.stamp;
      showForecast(result);
    }).catch(() => {
      if (forecastRequest === request) showForecast({ state: 'unavailable' });
    }).finally(() => {
      if (forecastRequest === request) forecastRequest = undefined;
    });
  }

  function powerTick(span) {
    const rough = Math.max(10, span / 5);
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    return ([1, 2, 5, 10].find(value => value * magnitude >= rough) ?? 10) * magnitude;
  }

  function drawChart(force = false) {
    const { clientWidth: width, clientHeight: height } = chart;
    if (!width || !height) return;
    const key = `${cache?.name}/${cache?.date}/${cache?.cursor}/${cache?.modified}/${width}/${height}/${checks.map(c => c.checked).join()}`;
    if (!force && drawn?.key === key) return;
    const rows = data.points(cache);
    if (!rows.length || drawn?.date !== cache?.date) {
      endChartDrag();
      powerRange = undefined;
      timeRange = undefined;
    }
    drawn = { key, rows, date: cache?.date };
    tooltip.hidden = true;
    chart.replaceChildren();
    empty.hidden = rows.length > 0;
    zoomIn.disabled = zoomOut.disabled = handTool.disabled = autoFit.disabled = !rows.length;
    for (const button of xRangeButtons) button.disabled = !rows.length;
    const selectedHours = timeRange?.span / 60;
    for (const button of xRangeButtons) button.setAttribute('aria-pressed', String(Number(button.dataset.hours) === selectedHours));
    autoFit.setAttribute('aria-pressed', String(!powerRange && !timeRange));
    chart.classList.toggle('is-pannable', Boolean(rows.length) && handTool.getAttribute('aria-pressed') === 'true');
    if (!rows.length) return;

    const left = 56, right = width - 42, top = 20, bottom = height - 34;
    const first = rows[0].minute;
    const duration = rows.at(-1).minute - first;
    const padding = Math.max(5, Math.ceil(duration * 0.03));
    const fitTimeSpan = Math.min(1440, duration + 2 * padding);
    const fitStart = Math.max(0, Math.min(first - padding, 1440 - fitTimeSpan));
    const { start: startMinute, span: timeSpan } = timeRange ?? { start: fitStart, span: fitTimeSpan };
    const yValues = rows.flatMap(row => row.values.slice(0, 6).filter((v, i) => v !== null && checks[i].checked));
    const max = Math.max(0, ...yValues);
    const min = Math.min(0, ...yValues);
    const autoStep = powerTick(max - min);
    const autoMin = Math.floor(min / autoStep) * autoStep;
    const autoMax = Math.max(autoMin + minPowerSpan, Math.ceil(max / autoStep) * autoStep);
    const { min: minY, max: maxY } = powerRange ?? { min: autoMin, max: autoMax };
    const span = maxY - minY;
    const maxPowerSpan = (autoMax - autoMin) * 8;
    zoomIn.disabled = span <= minPowerSpan + 0.001;
    zoomOut.disabled = span >= maxPowerSpan - 0.001;
    const step = powerRange ? powerTick(span) : autoStep;
    const x = minute => left + (minute - startMinute) / timeSpan * (right - left);
    const y = (value, i) => bottom - (i === 6 ? value / 100 : (value - minY) / (maxY - minY)) * (bottom - top);
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    for (let value = Math.ceil(minY / step) * step; value <= maxY; value += step) {
      const at = y(value, 0);
      chart.append(svg('line', { x1: left, x2: right, y1: at, y2: at, class: value === 0 ? 'solar-zero' : 'solar-gridline' }),
        svg('text', { x: left - 5, y: at + 4, 'text-anchor': 'end' }, kilowatts(value)));
    }
    for (let value = 0; value <= 100; value += 20) chart.append(svg('text', { x: right + 6, y: y(value, 6) + 4 }, `${value}%`));
    chart.append(svg('text', { x: left, y: 11, 'text-anchor': 'end' }, 'kW'));
    chart.append(svg('text', { x: right + 6, y: 11 }, 'SoC'));
    const tick = ([1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720].find(value => value >= timeSpan / (width < 500 ? 4 : 8)) ?? 720);
    const firstTick = Math.max(0, Math.ceil(startMinute / tick) * tick);
    const lastMinute = Math.min(1440, startMinute + timeSpan);
    for (let minute = firstTick; minute <= lastMinute; minute += tick) chart.append(svg('text', {
      x: x(minute), y: bottom + 18, 'text-anchor': 'middle',
    }, timeOf(minute)));

    const clip = svg('clipPath', { id: 'solar-chart-clip' });
    clip.append(svg('rect', { x: left, y: top, width: right - left, height: bottom - top }));
    const plot = svg('g', { 'clip-path': 'url(#solar-chart-clip)' });
    const areas = svg('g', { 'aria-hidden': 'true', 'pointer-events': 'none' });
    plot.append(areas);
    chart.append(clip, plot);
    const gaps = rows.slice(1).map((row, index) => row.minute - rows[index].minute).sort((a, b) => a - b);
    const gapLimit = Math.max(2, (gaps[Math.floor(gaps.length / 2)] ?? 1) * 3);
    for (const [index, [, colour, shaded]] of series.entries()) {
      if (!checks[index].checked) continue;
      const segments = [];
      let segment = [];
      for (const row of rows) {
        if (row.values[index] === null || segment.length && row.minute - segment.at(-1).minute > gapLimit) {
          if (segment.length) segments.push(segment);
          segment = [];
        }
        if (row.values[index] !== null) segment.push(row);
      }
      if (segment.length) segments.push(segment);
      for (const group of segments) {
        const path = group.map(row => `${x(row.minute).toFixed(1)} ${y(row.values[index], index).toFixed(1)}`).join(' L');
        if (group.length === 1) {
          plot.append(svg('circle', { cx: x(group[0].minute), cy: y(group[0].values[index], index), r: 2.5, fill: colour }));
        } else {
          if (shaded) {
            const baseline = y(0, index).toFixed(1);
            const firstX = x(group[0].minute).toFixed(1);
            const lastX = x(group.at(-1).minute).toFixed(1);
            areas.append(svg('path', { d: `M${firstX} ${baseline} L${path} L${lastX} ${baseline} Z`,
              fill: colour, 'fill-opacity': .32, class: 'solar-power-area' }));
          }
          plot.append(svg('path', { d: `M${path}`, fill: 'none', stroke: colour, 'stroke-width': 1.8,
            class: index === 6 ? 'solar-soc-line' : 'solar-power-line' }));
        }
      }
    }
    Object.assign(drawn, { left, right, top, bottom, startMinute, timeSpan, fitStart, minY, maxY, autoMin, autoMax, maxPowerSpan, width, height });
  }

  async function files() {
    const manifest = await (await readNas()).json();
    if (nasSource !== manifest.source) {
      cache = undefined;
      resetForecast();
      showCurrent();
      drawChart(true);
      nasSource = manifest.source;
    }
    sourcePath = manifest.path;
    sourceSerial = manifest.serial;
    updateLogMonths(manifest.files);
    write('source-note', '');
    return manifest.files.map(file => ({
      ...file,
      slice(start, end = file.size) {
        const length = Math.min(end, file.size) - start;
        const parameters = { file: file.name, source: manifest.source, identity: file.identity, start, length };
        const slice = () => length > 0 ? readNas(parameters) : Promise.resolve(new Response());
        return {
          async text() { return (await slice()).text(); },
          async arrayBuffer() { return (await slice()).arrayBuffer(); },
        };
      },
    }));
  }

  const getFile = async entry => entry?.kind === 'file' ? entry.getFile() : entry;

  async function readNas(parameters, recycleRequest) {
    const url = new URL('readings.php', document.location.href);
    if (parameters) url.search = new URLSearchParams(parameters);
    const headers = { 'X-Solar-Logger': recycleRequest ? 'logs' : 'readings' };
    if (recycleRequest) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method: recycleRequest ? 'POST' : 'GET', headers, cache: 'no-store', redirect: 'error',
      body: recycleRequest ? JSON.stringify(recycleRequest) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) throw new Error('Sign in to WD Apps, then reopen the dashboard.');
      throw new Error(detail?.error ?? 'The NAS dashboard reader is unavailable.');
    }
    return response;
  }

  async function refreshCloudStatus() {
    const messages = {
      off: 'Cloud saving is off.',
      setup: 'Cloud is not saving. Check the Supabase settings.',
      unavailable: 'Cloud is not saving. The NAS upload service is unavailable.',
      idle: 'Cloud is not saving. No recent upload activity.',
      stopped: 'Cloud is not saving. Energy Manager is stopped.',
      restart: 'Cloud settings changed. Restart Energy Manager to apply them.',
      waiting: 'Cloud is waiting for the first reading.',
      connection: 'Cloud is not saving. Supabase is unreachable or temporarily unavailable.',
      auth: 'Cloud is not saving. Check the Supabase uploader login and publishable key.',
      access: 'Cloud is not saving. Check the uploader’s table permissions.',
      types: 'Cloud is not saving. Check the column types in energy_readings.',
      table: 'Cloud is not saving. Supabase rejected the readings. Check the table and its unique time key.',
    };
    try {
      const response = await fetch(new URL('readings.php', document.location.href), {
        headers: { 'X-Solar-Logger': 'cloud' }, cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error();
      const { state, checked } = await response.json();
      if (state === 'saving' && Number.isInteger(checked)) {
        const iso = new Date(checked * 1000).toISOString();
        write('cloud-status', 'Cloud is saving to Supabase. Last confirmed ' +
          displayDate(iso.slice(0, 10)) + ' ' + iso.slice(11, 19) + ' UTC.');
      } else {
        write('cloud-status', Object.hasOwn(messages, state) ? messages[state] : 'Cloud status unavailable.');
      }
    } catch {
      write('cloud-status', 'Cloud status unavailable.');
    }
  }

  function updateLogControls() {
    manageButton.disabled = !nasSource;
    logMonth.disabled = recycling || !managedFiles.length;
    recycleButton.disabled = recycling || !logMonth.value;
  }

  function updateLogMonths(entries) {
    managedFiles = entries;
    const months = [...new Set(entries.map(monthOf))].sort().reverse();
    const selected = logMonth.value;
    const previous = [...logMonth.options].slice(1).map(option => option.value);
    if (!logMonth.options.length || months.join(',') !== previous.join(',')) {
      logMonth.replaceChildren(new Option(months.length ? 'Select a month' : 'No monthly CSVs', ''),
        ...months.map(month => new Option(monthLabel(month), month)));
      if (months.includes(selected)) logMonth.value = selected;
    }
    write('log-folder', sourcePath || '');
    updateLogControls();
  }

  manageButton.addEventListener('click', () => {
    logManager.hidden = !logManager.hidden;
    manageButton.setAttribute('aria-expanded', String(!logManager.hidden));
  });
  logMonth.addEventListener('change', updateLogControls);
  recycleButton.addEventListener('click', async () => {
    const month = logMonth.value;
    const selected = managedFiles.filter(file => monthOf(file) === month);
    if (recycling || !nasSource || !selected.length) return;
    const nextSample = month === utcDate().slice(0, 7) ? '\n\nLogging will start fresh CSVs for this month on the next sample.' : '';
    if (!window.confirm('Move the ' + monthLabel(month) + ' CSVs from ' + sourcePath +
        ' to the WD Recycle Bin?' + nextSample)) return;
    const files = Object.fromEntries(selected.map(file => [file.name, file.identity]));
    recycling = true;
    updateLogControls();
    try {
      const result = await (await readNas(undefined, { month, files, source: nasSource })).json();
      write('log-message', 'Moved to ' + result.archive + '. Open that share as ' + result.account + ' in File Explorer to recover the files.');
      logMonth.value = '';
      cache = undefined;
      resetForecast();
      refresh(true);
    } catch (error) {
      write('log-message', error.message);
    } finally {
      recycling = false;
      updateLogControls();
    }
  });

  function updateSourceButtons() {
  }

  async function refresh(dateChanged = false) {
    if (busy) {
      pendingDateRefresh ||= dateChanged;
      return;
    }
    if (!data) return;
    busy = true;
    updateSourceButtons();
    try {

      const result = await window.energyCloud.read(dateInput.value);
      if (!result) return;
      const { system, meter, latestFile, previousFile, selectedFile, date } = result;
      showCurrent('FD2324F695', system, meter);
      showForecast(await data.batteryForecast(latestFile, previousFile, system));
      dateInput.max = system?.stamp.slice(0, 10) ?? utcDate();
      if (!dateInput.value || dateInput.value > dateInput.max) setChartDate(date);
      if (dateInput.value !== date) return;
      id('next-day').disabled = date >= dateInput.max;
      cache = selectedFile ? await data.history(selectedFile, date) : undefined;
      empty.textContent = 'No readings for this date.';
      drawChart(true);
      write('data-status', system ? 'Supabase · Latest sample ' + displayDate(system.stamp.slice(0, 10)) + ' ' + system.stamp.slice(11, 19) + ' UTC' : 'No cloud readings yet.');
      write('cloud-status', 'Connected to Supabase · Read-only dashboard');
    } catch (error) {
      if (!forecastStamp || Date.now() - new Date(forecastStamp).getTime() > forecastMaxAge) resetForecast('unavailable');
      write('data-status', `Could not load cloud readings. ${error.message || 'Reopen it to try again.'}`);
    } finally {
      busy = false;
      updateSourceButtons();
      if (pendingDateRefresh) {
        pendingDateRefresh = false;
        refresh();
      }
    }
  }

  for (const [name, colour] of series) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.style.accentColor = colour;
    input.addEventListener('change', () => drawChart(true));
    label.append(input, document.createTextNode(name));
    id('chart-series').append(label);
    checks.push(input);
  }

  function zoomPower(factor) {
    if (!drawn?.rows.length) return;
    const { minY, maxY, maxPowerSpan } = drawn;
    const half = Math.max(minPowerSpan, Math.min(maxPowerSpan, (maxY - minY) * factor)) / 2;
    const center = (minY + maxY) / 2;
    powerRange = { min: center - half, max: center + half };
    drawChart(true);
  }

  function endChartDrag() {
    if (!chartDrag) return;
    const { pointerId } = chartDrag;
    chartDrag = undefined;
    chart.classList.remove('is-dragging');
    if (chart.hasPointerCapture(pointerId)) chart.releasePointerCapture(pointerId);
  }

  zoomIn.addEventListener('click', () => zoomPower(2 / 3));
  zoomOut.addEventListener('click', () => zoomPower(3 / 2));
  autoFit.addEventListener('click', () => {
    endChartDrag();
    powerRange = undefined;
    timeRange = undefined;
    drawChart(true);
  });
  for (const button of xRangeButtons) button.addEventListener('click', () => {
    if (!drawn?.rows.length) return;
    endChartDrag();
    const span = Number(button.dataset.hours) * 60;
    const latestMinute = drawn.rows.at(-1).minute;
    const start = Math.max(0, Math.min(1440 - span, latestMinute - span));
    timeRange = { start, span };
    drawChart(true);
  });
  handTool.addEventListener('click', () => {
    endChartDrag();
    const active = chart.classList.toggle('is-pannable');
    handTool.setAttribute('aria-pressed', String(active));
    tooltip.hidden = true;
  });
  chart.addEventListener('pointerdown', event => {
    if (!drawn?.rows.length || !chart.classList.contains('is-pannable') || !event.isPrimary || event.button !== 0) return;
    chartDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view: drawn, powerRange, timeRange };
    chart.setPointerCapture(event.pointerId);
    chart.classList.add('is-dragging');
    tooltip.hidden = true;
    event.preventDefault();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    chart.addEventListener(type, event => { if (chartDrag?.pointerId === event.pointerId) endChartDrag(); });
  }

  chart.addEventListener('pointermove', event => {
    if (!drawn?.rows.length) return;
    const rect = chart.getBoundingClientRect();
    if (chartDrag) {
      if (chartDrag.pointerId !== event.pointerId) return;
      const { view } = chartDrag;
      const dx = (event.clientX - chartDrag.x) * view.width / rect.width;
      const dy = (event.clientY - chartDrag.y) * view.height / rect.height;
      const shiftedStart = view.startMinute - dx * view.timeSpan / (view.right - view.left);
      const start = Math.max(0, Math.min(1440 - view.timeSpan, shiftedStart));
      timeRange = dx ? { start, span: view.timeSpan } : chartDrag.timeRange;
      const span = view.maxY - view.minY;
      const shifted = view.minY + dy * span / (view.bottom - view.top);
      const min = Math.max(view.autoMin - span * 0.75, Math.min(view.autoMax - span * 0.25, shifted));
      powerRange = dy ? { min, max: min + span } : chartDrag.powerRange;
      drawChart(true);
      return;
    }
    const { width, height, left, right, top, bottom, startMinute, timeSpan } = drawn;
    const at = (event.clientX - rect.left) * width / rect.width;
    const vertical = (event.clientY - rect.top) * height / rect.height;
    const minute = startMinute + (at - left) / (right - left) * timeSpan;
    if (at < left || at > right || vertical < top || vertical > bottom || minute < 0 || minute > 1440) {
      tooltip.hidden = true;
      return;
    }
    const nearest = drawn.rows.reduce((a, b) => Math.abs(a.minute - minute) <= Math.abs(b.minute - minute) ? a : b);
    tooltip.textContent = [`${timeOf(nearest.minute)} UTC`, ...series.map(([name], i) => checks[i].checked && nearest.values[i] !== null
      ? `${name}  ${i === 6 ? `${nearest.values[i].toFixed(1)}%` : `${kilowatts(nearest.values[i])} kW`}` : null).filter(Boolean)].join('\n');
    tooltip.style.left = `${Math.max(4, Math.min(rect.width - 174, event.clientX - rect.left + 12))}px`;
    tooltip.hidden = false;
  });
  chart.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  const chartObserver = new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (target === chart && cache) drawChart();
      if (target === forecastChart) drawForecast();
    }
  });
  chartObserver.observe(chart);
  chartObserver.observe(forecastChart);

  function setChartDate(value) {
    dateInput.value = value;
    dateText.value = displayDate(dateInput.value);
    dateText.removeAttribute('aria-invalid');
    write('date-error', '');
  }

  function readTypedDate() {
    const value = dateText.value.trim();
    const iso = displayDate(value);
    const parsed = new Date(iso + 'T00:00:00Z');
    if (!/^\d{2}-\d{2}-\d{4}$/.test(value) || iso < dateInput.min ||
        !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso || iso > dateInput.max) {
      dateText.setAttribute('aria-invalid', 'true');
      write('date-error', 'Enter a valid date in dd-mm-yyyy, up to ' + displayDate(dateInput.max) + '.');
      return;
    }
    const changed = iso !== dateInput.value;
    setChartDate(iso);
    if (changed) refresh(true);
  }

  function changeDate(days) {
    const time = new Date(`${dateInput.value || utcDate()}T00:00:00Z`).getTime();
    const next = new Date(time + days * 86400000).toISOString().slice(0, 10);
    if (next >= dateInput.min && next <= dateInput.max) {
      setChartDate(next);
      refresh(true);
    }
  }
  dateInput.max = utcDate();
  id('back').addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (new URLSearchParams(window.location.search).get('from') !== 'wd-apps') return;
    // Keep the original Apps tab in place when the launcher opened a new tab.
    window.close();
    if (window.closed) event.preventDefault();
  });
  const calendar = id('calendar');
  calendar.hidden = typeof dateInput.showPicker !== 'function';
  calendar.addEventListener('click', () => dateInput.showPicker());
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    setChartDate(dateInput.value);
    refresh(true);
  });
  dateText.addEventListener('change', readTypedDate);
  dateText.addEventListener('keydown', event => {
    if (event.key === 'Enter') readTypedDate();
  });
  id('previous-day').addEventListener('click', () => changeDate(-1));
  id('next-day').addEventListener('click', () => changeDate(1));

  window.energyCloud.start(() => refresh(true));
  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); chartObserver.disconnect(); }
    else if (!document.hidden) refresh();
  }, 60000);
  if (!window.energyCloud && id('cloud-status')) {
    refreshCloudStatus();
    const cloudTimer = setInterval(() => {
      if (!root.isConnected) clearInterval(cloudTimer);
      else if (!document.hidden) refreshCloudStatus();
    }, 15000);
  }
})();
