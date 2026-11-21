'use strict';

(() => {
  const panel = document.getElementById('solar-control');
  const cloud = window.energyCloud;
  if (!panel || !cloud) return;

  const get = name => document.getElementById('solar-command-' + name);
  const button = get('refresh');
  const summary = get('summary');
  const status = get('status');
  const dailyCharge = get('daily-charge');
  const figure = get('figure');
  const chart = get('chart');
  const { figureLayout, responsiveFigureWidth } = window.solarDashboardData;
  const asOf = get('as-of');
  const windows = get('windows');
  const defaults = get('defaults');
  const sources = get('sources');
  const buttonStatusMessage = get('button-status-message');
  const buttonSwitches = get('button-switches');
  const buttonSlots = get('button-slots');
  const buttonTimestamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  });
  const namespace = 'http://www.w3.org/2000/svg';
  let loading = false;
  let pending = false;
  let generation = 0;
  let updateTimer;
  let stopWatching;

  const lines = {
    measuredSoc: { label: 'Realised SOC', color: '#0072b2' },
    estimatedSoc: { label: 'Historical SOC estimate', color: '#c34c12', dash: '6 4' },
    forecastSoc: { label: 'SOC with proposed grid charge', color: '#6235a7', weight: 3 },
    unchargedSoc: { label: 'SOC without proposed grid charge', color: '#087f57', dash: '7 5' },
    reserve: { label: 'Battery reserve', color: '#8b949c', dash: '3 4' },
    gridTarget: { label: 'Grid charge cap', color: '#8b949c', dash: '3 4' },
    measuredDemand: { label: 'Demand measured', color: '#526b16', weight: 2.2, shade: true },
    estimatedDemand: { label: 'Demand estimated', color: '#b4491c' },
    forecastDemand: { label: 'Demand forecast', color: '#41474d' },
    measuredSolar: { label: 'Solar measured', color: '#008454', weight: 2.2, shade: true },
    estimatedSolar: { label: 'Solar estimated', color: '#b4491c', weight: 2.5 },
    forecastSolar: { label: 'Solar forecast', color: '#101417', weight: 2.5 },
    recordedGrid: { label: 'Recorded grid charge', color: '#8999ae', bar: true },
    automaticGrid: { label: 'Automatic grid charge', color: '#6da9d6', bar: true },
    manualGrid: { label: 'Manual grid charge', color: '#bd5814', bar: true },
  };

  function html(tag, content) {
    const element = document.createElement(tag);
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function svg(tag, attributes = {}, content) {
    const element = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (content !== undefined) element.textContent = content;
    chart.append(element);
    return element;
  }

  function timestampFormatters(timeZone) {
    if (typeof timeZone !== 'string' || !timeZone) return null;
    const day = { weekday: 'short', day: 'numeric', month: 'short' };
    const time = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    const format = options => new Intl.DateTimeFormat('en-GB', { timeZone, ...options });
    return {
      day: format(day),
      date: format({ year: 'numeric', month: '2-digit', day: '2-digit' }),
      clock: format(time),
      zonedClock: format({ ...time, timeZoneName: 'short' }),
      localMinute: format({ ...day, ...time, timeZoneName: 'short' }),
      full: format({ ...day, ...time, second: '2-digit', timeZoneName: 'short' }),
    };
  }

  function chartValueAt(segments, time, interval) {
    let lo = 0, hi = segments.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (segments[mid][0] <= time) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return null;
    const [start, end, value, endValue] = segments[lo - 1];
    if (time > end || (interval && time === end)) return null;
    if (interval) return { value, minutes: (end - start) / 60 };
    return { value: start === end ? value : value + (endValue - value) * (time - start) / (end - start) };
  }

  function draw(data, formatters) {
    const history = Array.isArray(data.history) ? data.history : [];
    const forecast = Array.isArray(data.forecast) ? data.forecast : [];
    const gridPlan = Array.isArray(data.schedule)
      ? data.schedule.map(slot => ({ time: slot.start, end: slot.end, grid_kwh: slot.kwh, source: slot.source })) : forecast;
    const { demand, solar } = data.energy_plots ?? {};
    const recordedGrid = Array.isArray(data.history_grid) ? data.history_grid : history;
    const minuteHistory = Array.isArray(data.history_soc) && data.history_soc.length;
    const socHistory = minuteHistory ? data.history_soc : history;
    // Saved plans may predate the operating floor in the historical calculation.
    const minimumSoc = Number.isFinite(data.minimum_operating_soc) ? data.minimum_operating_soc : 0;
    const modelledSoc = value => Math.max(minimumSoc, value);
    chart.replaceChildren();
    const hover = window.SolarLoggerChartHover;
    if (!formatters) {
      hover?.clear(chart);
      return false;
    }

    const timestamps = [...history, ...forecast, ...socHistory, ...gridPlan]
      .flatMap(row => [row.time, row.end]).filter(Number.isFinite);
    const hasWindow = Number.isFinite(data.start) && Number.isFinite(data.end) && data.end > data.start;
    if (!hasWindow && !timestamps.length) {
      hover?.clear(chart);
      return false;
    }
    const bounds = hasWindow ? [data.start, data.end] : timestamps.reduce(
      ([low, high], value) => [Math.min(low, value), Math.max(high, value)],
      [Number.isFinite(data.cutoff) ? data.cutoff : Infinity, Number.isFinite(data.cutoff) ? data.cutoff : -Infinity]);
    const midnights = [], ticks = [];
    const shortRange = bounds[1] - bounds[0] <= 5 * 86400;
    for (let stamp = Math.floor((bounds[0] - 90000) / 900) * 900; stamp <= bounds[1] + 90000; stamp += 900) {
      const clock = formatters.clock.format(stamp * 1000);
      if (clock === '00:00') midnights.push(stamp);
      if (clock === '00:00' || (shortRange && ['06:00', '12:00', '18:00'].includes(clock))) {
        ticks.push([stamp, clock]);
      }
    }
    const start = hasWindow ? data.start : midnights.filter(stamp => stamp <= bounds[0]).pop() ?? bounds[0];
    const end = hasWindow ? data.end : midnights.find(stamp => stamp >= bounds[1] && stamp > start) ?? Math.max(bounds[1], start + 3600);
    const days = midnights.filter(stamp => stamp >= start && stamp < end);
    const asOf = data.display_as_of ?? data.as_of ?? Date.now() / 1000;
    const today = formatters.date.format(asOf * 1000);
    const dateLabelStep = Math.max(1, Math.ceil(days.length / 15));
    const labelledDays = new Set(days.filter((_, index) => index % dateLabelStep === 0));
    const hasCursor = Number.isFinite(data.cutoff) && data.cutoff >= start && data.cutoff <= end;
    const cursor = window.SolarLoggerCursor;
    const cursorSpace = hasCursor && cursor ? cursor.height + 4 : 0;
    const width = responsiveFigureWidth(chart, () => draw(data, formatters));
    const left = figureLayout.left, right = width - figureLayout.right, socHeader = 43, top = socHeader + cursorSpace;
    const socBottom = top + figureLayout.plotHeight;
    const energyTop = socBottom + 98, energyHeader = energyTop + 75;
    const energyPlotTop = energyHeader + cursorSpace, energyBottom = energyPlotTop + figureLayout.plotHeight;
    const plotBottoms = [socBottom, energyBottom];
    const x = stamp => left + (stamp - start) / (end - start) * (right - left);
    const socY = value => socBottom - value / 110 * (socBottom - top);

    const plotValues = source => source ? [...source.measured, ...source.past, ...source.forecast].map(([, value]) => value) : [];
    const positive = plotValues(solar);
    positive.push(...[...recordedGrid, ...gridPlan].map(row => row.grid_kwh));
    const negative = plotValues(demand);
    const peak = positive.reduce((value, next) => Number.isFinite(next) ? Math.max(value, next) : value, 0.1);
    const trough = negative.reduce((value, next) => Number.isFinite(next) ? Math.max(value, next) : value, 0.1);
    const rawStep = (peak + trough) / 7;
    const scale = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].find(value => value * scale >= rawStep) * scale;
    const upperTicks = Math.ceil(peak / step), lowerTicks = Math.ceil(trough / step);
    const energyY = value => energyBottom - (value + lowerTicks * step) / ((upperTicks + lowerTicks) * step) *
      (energyBottom - energyPlotTop);
    const socSeries = [], energySeries = [];
    const limits = [[data.reserve, lines.reserve], [data.target, lines.gridTarget]]
      .filter(([value]) => Number.isFinite(value));
    const limitLabel = ([value, appearance]) => appearance.label + ' ' + value + '%';

    svg('title', { id: 'solar-command-chart-title' }, 'Battery SOC and energy forecast');
    svg('desc', { id: 'solar-command-chart-desc' },
      ['The dotted vertical line marks the latest battery SOC reading. Solar and grid charge are positive and household demand is negative.',
        ...limits.map(limitLabel)].join(' '));

    const line = (x1, y1, x2, y2, stroke = '#d5ddd8', weight = 1, dash) => {
      svg('line', { x1, y1, x2, y2, stroke, 'stroke-width': weight, ...(dash ? { 'stroke-dasharray': dash } : {}) });
    };
    const label = (x, y, text, anchor = 'start', size = figureLayout.label, weight = 400, fill = '#33443e') =>
      svg('text', { x, y, 'text-anchor': anchor, 'font-size': size, 'font-weight': weight, fill }, text);

    function dailyEnergyCard(center, span, rows) {
      const baseWidth = 248;
      const width = Math.min(baseWidth, span - 10);
      const scale = width / baseWidth;
      const textScale = Math.min(1, width / 182);
      const cardX = center - width / 2;
      const y = energyTop + 5;
      const valueX = [cardX + 173 * scale, cardX + width - 10 * scale];
      svg('rect', { x: cardX, y, width, height: (26 + 20 * rows.length) * scale,
        rx: 7 * scale, fill: '#fff', stroke: '#cbd8e2' });
      ['Demand (kWh)', 'Solar (kWh)'].forEach((heading, i) =>
        label(valueX[i], y + 15 * scale, heading, 'end', figureLayout.label * textScale, 650));
      rows.forEach(({ name, color, values }, i) => {
        const rowY = y + (34 + 20 * i) * scale;
        label(cardX + 10 * scale, rowY, name, 'start', figureLayout.label * textScale, 400, color);
        values.forEach((value, j) => label(valueX[j], rowY, value, 'end', figureLayout.value * textScale, 650, color));
      });
    }

    label(left, 27, 'Battery state of charge (%)', 'start', figureLayout.title, 650);
    label(left, energyTop - 16, 'Solar, demand and grid charging', 'start', figureLayout.title, 650);
    label(right, energyTop - 16, 'Today’s estimate includes the remaining forecast', 'end', 12);
    for (const [index, day] of days.entries()) {
      const next = days[index + 1] ?? end;
      if (formatters.date.format(day * 1000) !== today) {
        for (const [y, bottom] of [[top, socBottom], [energyTop, energyBottom]]) {
          svg('rect', { x: x(day), y, width: x(next) - x(day), height: bottom - y, fill: '#eef0f2' });
        }
      }
    }
    for (let value = 0; value <= 100; value += 20) {
      line(left, socY(value), right, socY(value));
      label(left - 8, socY(value) + 4, value + '%', 'end');
    }
    line(left, top, right, top);
    for (let index = -lowerTicks; index <= upperTicks; index++) {
      const value = index * step;
      line(left, energyY(value), right, energyY(value), index === 0 ? '#77857d' : '#d5ddd8', index === 0 ? 1.5 : 1);
      label(left - 8, energyY(value) + 4, Number(value.toPrecision(7)).toString(), 'end');
    }
    const energyMid = (energyPlotTop + energyBottom) / 2;
    const axis = label(19, energyMid, 'Energy per interval (kWh)', 'middle');
    axis.setAttribute('transform', 'rotate(-90 19 ' + energyMid + ')');

    for (const [index, day] of days.entries()) {
      const next = days[index + 1] ?? end;
      if (day > start) {
        line(x(day), top, x(day), socBottom, '#b8c3bc');
        line(x(day), energyTop, x(day), energyBottom, '#b8c3bc');
      }
      const center = (x(day) + x(next)) / 2;
      const span = x(next) - x(day);
      if (labelledDays.has(day)) {
        const date = formatters.day.format(day * 1000);
        for (const bottom of plotBottoms) label(center, bottom + 37, date, 'middle', figureLayout.label, 650);
      }
      if (span < 135) continue;

      const isToday = formatters.date.format(day * 1000) === today;
      const isFuture = day > asOf;
      const period = isFuture ? 'future' : isToday ? 'today' : 'past';
      const rowNames = isFuture ? ['Forecast'] : ['Estimated', isToday ? 'Measured so far' : 'Measured'];
      const rowColors = isFuture ? ['#26384d'] : ['#a3431b', '#16736e'];
      const totals = [demand, solar].map(source => SolarGeneration.dailyTotals(source, day, next, period));
      const keys = isFuture ? ['forecast'] : ['estimated', 'measured'];
      const energyValues = keys.map(key => totals.map(total => total[key]));
      if (isToday || energyValues.some(values => values.some(Number.isFinite))) {
        dailyEnergyCard(center, span, energyValues.map((cells, i) => ({
          name: rowNames[i], color: rowColors[i],
          values: cells.map(value => Number.isFinite(value) ? value.toFixed(2) : '—'),
        })));
      }
    }
    for (const [stamp, time] of ticks) {
      if (stamp < start || stamp >= end || (!shortRange && !labelledDays.has(stamp))) continue;
      const tickX = x(stamp);
      for (const bottom of plotBottoms) {
        line(tickX, bottom, tickX, bottom + 4, '#aab8af');
        label(tickX, bottom + 17, time, 'middle', 12);
      }
    }
    for (const [y, bottom] of [[top, socBottom], [energyTop, energyBottom]]) {
      line(left, y, left, bottom, '#aab8af');
      line(left, bottom, right, bottom, '#aab8af');
    }

    function drawPath(path, appearance, stroke = appearance.color) {
      if (!path) return;
      svg('path', { d: path, fill: 'none', stroke, 'stroke-width': appearance.weight ?? 2,
        'stroke-linejoin': 'round', ...(appearance.dash ? { 'stroke-dasharray': appearance.dash } : {}) });
    }

    function socPath(rows, key, appearance, maximumGap, resets) {
      let path = '', previous = null;
      const segments = [];
      for (const { time, [key]: reading } of rows) {
        if (!Number.isFinite(time) || !Number.isFinite(reading)) continue;
        const value = key === 'estimated_soc' ? modelledSoc(reading) : reading;
        const continuous = previous !== null && time - previous[0] <= maximumGap;
        const reset = resets?.get(time);
        const hasPrior = reset && Number.isFinite(reset.prior_soc);
        const prior = hasPrior ? modelledSoc(reset.prior_soc) : null;
        if (hasPrior && continuous) {
          path += 'L' + x(time) + ' ' + socY(prior);
        }
        if (continuous && (!reset || hasPrior)) {
          segments.push([previous[0], time, previous[1], hasPrior ? prior : value]);
        }
        path += (continuous && !reset ? 'L' : 'M') + x(time) + ' ' + socY(value);
        previous = [time, value];
        segments.push([time, time, value, value]);
      }
      drawPath(path, appearance);
      if (segments.length) socSeries.push({ appearance, segments });
    }

    function forecastSocPath(key, endKey, appearance) {
      let path = '', previous = null;
      const segments = [];
      for (const row of forecast) {
        if (![row.time, row.end, row[key], row[endKey]].every(Number.isFinite)) continue;
        const value = modelledSoc(row[key]), endValue = modelledSoc(row[endKey]);
        if (row.time !== previous) path += 'M' + x(row.time) + ' ' + socY(value);
        path += 'L' + x(row.end) + ' ' + socY(endValue);
        previous = row.end;
        segments.push([row.time, row.end, value, endValue]);
      }
      drawPath(path, appearance);
      if (segments.length) socSeries.push({ appearance, segments });
    }

    function intervalSegments(source, key) {
      if (!source) return [];
      const isDemand = source.kind === 'demand';
      const seconds = source.interval_minutes * 60;
      const segments = [];
      const values = key === 'measured' && !isDemand ? source.measured_energy ?? source[key] : source[key];
      for (const [stamp, value] of values) {
        if (!Number.isFinite(stamp) || !Number.isFinite(value)) continue;
        const from = Math.max(start, isDemand ? stamp : stamp - seconds);
        const until = Math.min(end, isDemand ? stamp + seconds : stamp,
          key === 'measured' ? source.measured_through ?? (hasCursor ? data.cutoff : Infinity) : Infinity);
        if (until <= from) continue;
        segments.push([from, until, isDemand ? -value : value]);
      }
      return segments;
    }

    function energyPath(segments, shade) {
      let path = '', area = '', section = '', sectionStart, previous;
      function finishSection() {
        if (!section) return;
        path += section;
        if (shade) area += section + 'V' + energyY(0) + 'H' + x(sectionStart) + 'Z';
      }
      for (const [from, until, value] of segments) {
        if (from === previous) {
          section += 'V' + energyY(value);
        } else {
          finishSection();
          sectionStart = from;
          section = 'M' + x(from) + ' ' + energyY(value);
        }
        section += 'H' + x(until);
        previous = until;
      }
      finishSection();
      if (area) svg('path', { d: area, fill: shade, opacity: 0.19 });
      return path;
    }

    function energyLine(segments, minutes, appearance, path, forecastAppearance, stroke) {
      if (!segments.length) return;
      drawPath(path ?? energyPath(segments), appearance, stroke);
      energySeries.push({ appearance, segments, minutes, forecastAppearance });
    }

    function modeledEnergy(source, estimate, prediction) {
      if (!source) return;
      const past = intervalSegments(source, 'past');
      const future = intervalSegments(source, 'forecast');
      const minutes = source.interval_minutes;
      if (!hasCursor) {
        energyLine(past, minutes, estimate);
        energyLine(future, minutes, prediction);
        return;
      }
      const byStart = new Map([...past, ...future].map(segment => [segment[0], segment]));
      const segments = [...byStart.values()].sort((a, b) => a[0] - b[0]);
      const before = segments.some(([from]) => from < data.cutoff);
      const after = segments.some(([, until]) => until > data.cutoff);
      if (!before || !after) {
        energyLine(segments, minutes, before ? estimate : prediction);
        return;
      }

      const id = chart.id + '-' + source.kind + '-cutoff';
      const gradient = svg('linearGradient', { id, gradientUnits: 'userSpaceOnUse',
        x1: left, x2: right, y1: energyPlotTop, y2: energyPlotTop });
      svg('defs').append(gradient);
      const offset = (data.cutoff - start) / (end - start);
      for (const { color } of [estimate, prediction]) {
        gradient.append(svg('stop', { offset, 'stop-color': color }));
      }
      // A shared stop changes colour at the cursor without breaking the interval step.
      energyLine(segments, minutes, estimate, undefined, prediction, 'url(#' + id + ')');
    }

    function gridBars(rows, appearance) {
      const bars = rows.filter(row => Number.isFinite(row.grid_kwh) && row.grid_kwh > 0 && row.end > row.time);
      for (const row of bars) {
        const y = energyY(row.grid_kwh);
        svg('rect', { x: x(row.time) + 1, y, width: Math.max(1, x(row.end) - x(row.time) - 2),
          height: energyY(0) - y, fill: appearance.color, opacity: 0.8 });
      }
      if (bars.length) energySeries.push({ appearance, segments: bars.map(row => [row.time, row.end, row.grid_kwh]) });
    }

    for (const [value, appearance] of limits) {

      line(left, socY(value), right, socY(value), appearance.color, 1.6, appearance.dash);
    }
    const historyGap = minuteHistory ? 300 : 3601;
    const replayResets = new Map((data.soc_replay_resets ?? []).map(reset => [reset.time, reset]));
    socPath(socHistory, 'soc', lines.measuredSoc, data.measurement_gap ?? historyGap);
    socPath(socHistory, 'estimated_soc', lines.estimatedSoc, historyGap, replayResets);
    forecastSocPath('soc', 'end_soc', lines.forecastSoc);
    forecastSocPath('no_charge_soc', 'end_no_charge_soc', lines.unchargedSoc);

    const measuredEnergy = [
      [solar, lines.measuredSolar],
      [demand, lines.measuredDemand],
    ].map(([source, appearance]) => {
      const segments = intervalSegments(source, 'measured');
      return { segments, minutes: source?.interval_minutes, appearance, path: energyPath(segments, appearance.color) };
    });
    gridBars(recordedGrid, lines.recordedGrid);
    gridBars(gridPlan.filter(row => row.source !== 'manual'), lines.automaticGrid);
    gridBars(gridPlan.filter(row => row.source === 'manual'), lines.manualGrid);
    modeledEnergy(solar, lines.estimatedSolar, lines.forecastSolar);
    modeledEnergy(demand, lines.estimatedDemand, lines.forecastDemand);
    for (const { segments, minutes, appearance, path } of measuredEnergy) energyLine(segments, minutes, appearance, path);

    if (hasCursor) {
      const divider = x(data.cutoff);
      for (const [y, bottom] of [[top, socBottom], [energyPlotTop, energyBottom]]) {
        line(divider, y, divider, bottom, '#34465a', 2, '3 4');
      }
      for (const labelTop of [socHeader, energyHeader]) {
        cursor?.draw(chart, { time: data.cutoff, timeZone: data.timezone, x: divider, top: labelTop, left, right });
      }
    }

    function drawLegend(series, entries, baseline, name) {
      const visible = new Set(series.flatMap(({ appearance, forecastAppearance }) => [appearance, forecastAppearance]));
      const group = svg('g', { role: 'group', 'aria-label': name });
      let position = left;
      for (const [appearance, title, equivalent] of entries) {
        if (!visible.has(appearance) && (!equivalent || !visible.has(equivalent))) continue;
        const caption = label(position + 20, baseline, title, 'start', figureLayout.label);
        group.append(caption);
        const itemWidth = 30 + (caption.getComputedTextLength?.() || title.length * 7);
        if (position > left && position + itemWidth > right) {
          position = left;
          baseline += 17;
          caption.setAttribute('x', position + 20);
          caption.setAttribute('y', baseline);
        }
        const center = baseline - 4;
        if (appearance.bar || appearance.shade) {
          group.append(svg('rect', { x: position, y: center - 3, width: 15, height: 6,
            fill: appearance.color, opacity: appearance.bar ? 0.8 : 0.19 }));
        }
        if (!appearance.bar) {
          const keyY = center - (appearance.shade ? 3 : 0);
          group.append(svg('line', { x1: position, y1: keyY, x2: position + 15, y2: keyY, stroke: appearance.color,
            'stroke-width': 2, ...(appearance.dash ? { 'stroke-dasharray': appearance.dash } : {}) }));
        }
        position += itemWidth;
      }
      return baseline;
    }
    drawLegend(socSeries, [
      [lines.measuredSoc, 'Measured'],
      [lines.estimatedSoc, 'Past estimate'],
      [lines.forecastSoc, 'With grid charge'],
      [lines.unchargedSoc, 'Without grid charge'],
    ], socBottom + 57, 'Battery legend');
    const legendEnd = drawLegend(energySeries, [
      [lines.measuredSolar, 'Solar measured'],
      [lines.measuredDemand, 'Demand measured'],
      [lines.estimatedSolar, 'Past estimates', lines.estimatedDemand],
      [lines.forecastSolar, 'Solar forecast'],
      [lines.forecastDemand, 'Demand forecast'],
      [lines.recordedGrid, 'Recorded charge'],
      [lines.automaticGrid, 'Automatic charge'],
      [lines.manualGrid, 'Manual charge'],
    ], energyBottom + 57, 'Energy legend');
    chart.setAttribute('viewBox', '0 0 ' + width + ' ' + (legendEnd + 13));
    hover?.attach(chart, (px, py) => {
      if (px < left || px > right) return null;
      const isSoc = py >= top && py <= socBottom;
      if (!isSoc && (py < energyPlotTop || py > energyBottom)) return null;
      const time = Math.round(start + (px - left) * (end - start) / (right - left));
      const rows = [];
      for (const { appearance, segments, minutes, forecastAppearance } of isSoc ? socSeries : energySeries) {
        const point = chartValueAt(segments, time, !isSoc);
        if (!Number.isFinite(point?.value)) continue;
        const value = isSoc
          ? point.value.toFixed(1) + '%'
          : `${point.value.toFixed(2)} kWh · ${Number((minutes ?? point.minutes).toFixed(2))} min`;
        const style = forecastAppearance && time >= data.cutoff ? forecastAppearance : appearance;
        rows.push({ label: style.label, color: style.color, value });
      }
      if (!rows.length) return null;
      if (isSoc) {
        for (const [value, appearance] of limits) {
          rows.push({ label: appearance.label, color: appearance.color, value: value.toFixed(1) + '%' });
        }
      }
      return {
        title: (isSoc ? formatters.full : formatters.localMinute).format(time * 1000), rows,
        guide: { x: x(time), top: isSoc ? top : energyPlotTop, bottom: isSoc ? socBottom : energyBottom },
      };
    });
    return days;
  }

  function renderDailyCharging(data, formatters, days) {
    const slots = (data.schedule ?? []).filter(slot =>
      [slot.start, slot.end, slot.kwh].every(Number.isFinite) && slot.end > slot.start && slot.kwh > 0);
    const entries = data.ok || slots.length ? days.flatMap((start, i) => {
      const end = days[i + 1] ?? data.end;
      if (end <= data.as_of) return [];
      const energy = slots.reduce((total, slot) => {
        const overlap = Math.max(0, Math.min(end, slot.end) - Math.max(start, slot.start));
        return total + slot.kwh * overlap / (slot.end - slot.start);
      }, 0);
      const entry = html('div');
      if (energy > 0) entry.className = 'solar-command-charge-day';
      entry.append(html('dt', formatters.day.format(start * 1000)), html('dd', energy.toFixed(2) + ' kWh'));
      return [entry];
    }) : [];
    dailyCharge.replaceChildren(...entries);
    dailyCharge.hidden = !entries.length;
  }

  function renderSocReplayErrors(errors) {
    const details = get('soc-errors');
    const format = timestampFormatters('Europe/London');
    const rows = (errors ?? []).map(block => {
      const start = block.start * 1000, end = block.end * 1000;
      const error = `${block.error_pp >= 0 ? '+' : ''}${block.error_pp.toFixed(1)} pp`;
      return html('li', `${format.day.format(start)}, ${format.clock.format(start)}–${format.clock.format(end)} · ${error} (${block.estimated_soc.toFixed(1)}% estimated, ${block.measured_soc.toFixed(1)}% measured)`);
    });
    get('soc-error-list').replaceChildren(...rows);
    details.hidden = !rows.length;
  }

  function render(data) {
    const formatters = timestampFormatters(data.timezone);
    const windowLabel = values => Array.isArray(values) ? values.join(', ') || 'None' : null;
    const operatingRange = Number.isFinite(data.minimum_operating_soc) && Number.isFinite(data.maximum_operating_soc)
      ? data.minimum_operating_soc + '%–' + data.maximum_operating_soc + '%' : null;
    const days = draw(data, formatters);
    figure.hidden = !days;
    renderDailyCharging(data, formatters, days || []);
    renderSocReplayErrors(data.soc_replay_errors);
    const limits = [
      Number.isFinite(data.reserve) ? 'Reserve ' + data.reserve + '%' : null,
      Number.isFinite(data.target) ? 'Grid charge cap ' + data.target + '%' : null,
    ].filter(Boolean).join(' · ');
    asOf.textContent = formatters && Number.isFinite(data.as_of)
      ? 'NAS time · ' + formatters.full.format(data.as_of * 1000) + ' (' + data.timezone + ')' : '';
    const minimumTime = formatters && Number.isFinite(data.minimum_soc_time)
      ? ' · ' + formatters.localMinute.format(data.minimum_soc_time * 1000) : '';
    const entries = [
      ['Auto charging (local time)', windowLabel(data.allowed)],
      ['Auto blocked (local time)', windowLabel(data.blocked)],
      ['Battery range', operatingRange],
      ['Battery SOC limits', figure.hidden && limits ? limits : null],
      ['Forecast minimum SOC', Number.isFinite(data.minimum_soc) ? data.minimum_soc.toFixed(1) + '%' + minimumTime : null],
    ].filter(([, value]) => value !== null);
    windows.replaceChildren(...entries.map(([name, value]) => {
      const card = html('dl');
      card.append(html('dt', name), html('dd', value));
      return card;
    }));
    windows.hidden = !entries.length;

    const headlines = {
      planned: 'Grid charging proposed',
      'no-charge': 'No grid charging proposed.',
      infeasible: 'The forecast cannot maintain the reserve within the allowed charging windows.',
      unavailable: 'Charge plan unavailable.',
    };
    summary.dataset.state = Object.hasOwn(headlines, data.status) ? data.status : 'unavailable';
    status.textContent = [headlines[summary.dataset.state], !data.ok ? data.message : null].filter(Boolean).join(' ');

    const used = Array.isArray(data.defaults) ? data.defaults : null;
    const defaultList = get('default-list');
    defaultList.replaceChildren();
    defaults.hidden = used === null;
    if (used?.length) {
      const list = html('ul');
      list.append(...used.map(item => html('li', item)));
      defaultList.append(list);
    } else if (used && data.defaults_complete !== false) {
      defaultList.append(html('p', summary.dataset.state === 'unavailable'
        ? 'No defaults were reported for this request.' : 'No defaults were used.'));
    }
    if (used && data.defaults_complete === false) {
      defaultList.append(html('p', summary.dataset.state === 'unavailable'
        ? 'The charge plan could not complete the defaults audit.'
        : 'Some NAS forecast data did not report whether its source used defaults.'));
    }
    const provenance = Array.isArray(data.provenance) ? data.provenance : [];
    get('source-list').replaceChildren(...provenance.map(item => html('li', item)));
    sources.hidden = !provenance.length;
  }

  function showButtonStatus(snapshot, unavailable = 'Waiting for the NAS button status.') {
    const timestamp = Date.parse(snapshot?.updated_at);
    const valid = Number.isFinite(timestamp) && Array.isArray(snapshot?.charge_slots)
      && snapshot.charge_slots.every(index => Number.isInteger(index) && index >= 0 && index < 48)
      && ['automatic', 'inverter_control', 'direct_charge', 'direct_discharge']
        .every(key => typeof snapshot[key] === 'boolean');
    buttonSwitches.hidden = buttonSlots.hidden = !valid;
    buttonSwitches.replaceChildren();
    buttonSlots.replaceChildren();
    if (!valid) {
      buttonStatusMessage.textContent = snapshot ? 'The NAS button snapshot is incomplete.' : unavailable;
      return;
    }

    const stale = Date.now() - timestamp > 5 * 60 * 1000;
    buttonStatusMessage.textContent = (stale ? 'Last known state · ' : 'NAS snapshot · ') + buttonTimestamp.format(timestamp);
    const switches = [
      ['Mode', snapshot.automatic ? 'Automatic' : 'Manual', snapshot.automatic],
      ['Inverter control', snapshot.inverter_control ? 'On' : 'Off', snapshot.inverter_control],
      ['Battery charging', snapshot.direct_charge ? 'On' : 'Off'],
      ['Discharge to grid', snapshot.direct_discharge ? 'On' : 'Off'],
    ];
    for (const [name, value, on] of switches) {
      const pair = html('div');
      const readout = html('dd', value);
      if (typeof on === 'boolean') {
        const toggle = html('span');
        toggle.className = 'solar-command-switch';
        toggle.dataset.on = String(on);
        toggle.setAttribute('aria-hidden', 'true');
        readout.className = 'solar-command-switch-readout';
        readout.prepend(toggle);
      }
      pair.append(html('dt', name), readout);
      buttonSwitches.append(pair);
    }

    const selected = new Set(snapshot.charge_slots);
    for (let index = 0; index < 48; index++) {
      const minutes = (120 + index * 30) % 1440;
      const clock = String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
      const charge = selected.has(index);
      const state = charge ? 'Selected for charging' : 'Unselected';
      const slot = html('li', clock);
      slot.dataset.state = charge ? 'charge' : 'normal';
      slot.title = clock + ' · ' + state;
      slot.setAttribute('aria-label', clock + ', ' + state);
      buttonSlots.append(slot);
    }
  }

  async function refreshButtonStatus(connection) {
    try {
      const snapshot = await cloud.readControlButtonStatus();
      if (connection === generation) showButtonStatus(snapshot);
    } catch {
      if (connection === generation) showButtonStatus(null, 'NAS button status is unavailable.');
    }
  }

  const livePlan = SolarGeneration.liveView(start => cloud.readMeasured(start),
    () => !panel.hidden && !document.hidden, data => {
      figure.hidden = !draw(data, timestampFormatters(data.timezone));
    }, SolarGeneration.withLiveControl);

  async function refresh() {
    if (panel.hidden || document.hidden) return;
    if (loading) { pending = true; return; }
    const connection = generation;
    loading = true;
    button.disabled = true;
    panel.setAttribute('aria-busy', 'true');
    const buttonStatus = refreshButtonStatus(connection);
    try {
      const data = await cloud.readControl();
      if (connection !== generation) return;
      let energyPlots = data?.energy_plots;
      if (data && !energyPlots) {
        const [demand, solar] = await Promise.allSettled([cloud.readDemandForecast(), cloud.readForecast()]);
        if (connection !== generation) return;
        energyPlots = {
          demand: demand.status === 'fulfilled' ? publishedForecastData(demand.value, 'demand') : null,
          solar: solar.status === 'fulfilled' ? publishedForecastData(solar.value, 'solar') : null,
        };
      }
      const snapshot = data ? { ...data, energy_plots: energyPlots }
        : { status: 'unavailable', message: 'No Control plan has arrived from the NAS.' };
      render(snapshot);
      livePlan.show(snapshot);
      summary.hidden = false;
    } catch (error) {
      if (connection === generation) {
        const message = error.code === '42501'
          ? 'Run control-read.sql in Supabase to enable Control reads.'
          : error.message || 'Could not read the Control plan from Supabase.';
        livePlan.reset();
        render({ status: 'unavailable', message });
        summary.hidden = false;
      }
    } finally {
      await buttonStatus;
      loading = false;
      button.disabled = false;
      panel.removeAttribute('aria-busy');
      if (pending) { pending = false; refresh(); }
    }
  }

  button.addEventListener('click', refresh);
  document.querySelector('[aria-controls="solar-control"]').addEventListener('click', refresh);
  window.addEventListener('energy-cloud-connected', () => {
    generation++;
    clearTimeout(updateTimer);
    stopWatching?.();
    livePlan.reset();
    render({});
    showButtonStatus(null);
    summary.hidden = true;
    stopWatching = cloud.watchControl(() => {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(refresh, 250);
    });
    refresh();
  });
  document.addEventListener('visibilitychange', refresh);
  const timer = setInterval(() => {
    if (panel.isConnected) refresh();
    else clearInterval(timer);
  }, 60000);
})();
