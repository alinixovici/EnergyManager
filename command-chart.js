'use strict';

(() => {
  const panel = document.getElementById('solar-control');
  const cloud = window.energyCloud;
  if (!panel || !cloud) return;

  const get = name => document.getElementById('solar-command-' + name);
  const button = get('refresh');
  const status = get('status');
  const figure = get('figure');
  const chart = get('chart');
  const legend = get('legend');
  const asOf = get('as-of');
  const windows = get('windows');
  const strategy = get('strategy');
  const schedule = get('schedule');
  const defaults = get('defaults');
  const sources = get('sources');
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
    reserve: { label: 'Battery reserve', color: '#ac233b', dash: '8 3 2 3' },
    gridTarget: { label: 'Grid charge cap', color: '#905600', dash: '3 4' },
    measuredDemand: { label: 'Demand measured', color: '#0072b2' },
    estimatedDemand: { label: 'Demand estimated', color: '#c34c12', dash: '6 4' },
    forecastDemand: { label: 'Demand forecast', color: '#6235a7' },
    measuredSolar: { label: 'Solar measured', color: '#008043' },
    estimatedSolar: { label: 'Solar estimated', color: '#b02a72', dash: '6 4' },
    forecastSolar: { label: 'Solar forecast', color: '#996500' },
    recordedGrid: { label: 'Recorded grid charge', color: '#8999ae', bar: true },
    proposedGrid: { label: 'Proposed grid charge', color: '#29364f', bar: true },
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
      localMinute: format({ ...day, ...time, timeZoneName: 'short' }),
      full: format({ ...day, ...time, second: '2-digit', timeZoneName: 'short' }),
    };
  }

  function draw(data, formatters) {
    const history = Array.isArray(data.history) ? data.history : [];
    const forecast = Array.isArray(data.forecast) ? data.forecast : [];
    const minuteHistory = Array.isArray(data.history_soc) && data.history_soc.length;
    const socHistory = minuteHistory ? data.history_soc : history;
    chart.replaceChildren();
    legend.replaceChildren();
    if (!formatters || (!socHistory.length && !history.length && !forecast.length)) return false;

    const timestamps = [...history, ...forecast, ...socHistory]
      .flatMap(row => [row.time, row.end]).filter(Number.isFinite);
    if (!timestamps.length) return false;
    const hasWindow = Number.isFinite(data.start) && Number.isFinite(data.end) && data.end > data.start;
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
    const asOf = Number.isFinite(data.as_of) ? data.as_of : Date.now() / 1000;
    const today = formatters.date.format(asOf * 1000);
    const dateLabelStep = Math.max(1, Math.ceil(days.length / 15));
    const labelledDays = new Set(days.filter((_, index) => index % dateLabelStep === 0));
    const left = 76, right = 1156, top = 43;
    const socBottom = top + 204;
    const energyTop = socBottom + 76, energyPlotTop = energyTop + 75, energyBottom = energyPlotTop + 213;
    const plotBottoms = [socBottom, energyBottom];
    const x = stamp => left + (stamp - start) / (end - start) * (right - left);
    const socY = value => socBottom - value / 100 * (socBottom - top);

    const positive = [...history, ...forecast].flatMap(row => [row.solar_kwh, row.estimated_solar_kwh, row.grid_kwh]);
    const negative = [...history, ...forecast].flatMap(row => [row.demand_kwh, row.estimated_demand_kwh]);
    const peak = positive.reduce((value, next) => Number.isFinite(next) ? Math.max(value, next) : value, 0.1);
    const trough = negative.reduce((value, next) => Number.isFinite(next) ? Math.max(value, next) : value, 0.1);
    const rawStep = (peak + trough) / 7;
    const scale = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].find(value => value * scale >= rawStep) * scale;
    const upperTicks = Math.ceil(peak / step), lowerTicks = Math.ceil(trough / step);
    const energyY = value => energyBottom - (value + lowerTicks * step) / ((upperTicks + lowerTicks) * step) *
      (energyBottom - energyPlotTop);
    const visibleLines = [];
    const limits = [[data.reserve, lines.reserve], [data.target, lines.gridTarget]]
      .filter(([value]) => Number.isFinite(value));
    const limitLabel = ([value, appearance]) => appearance.label + ' ' + value + '%';

    chart.setAttribute('viewBox', '0 0 1176 ' + (energyBottom + 54));
    svg('title', { id: 'solar-command-chart-title' }, 'Battery SOC and energy forecast');
    svg('desc', { id: 'solar-command-chart-desc' },
      ['Measured and estimated history appears before the forecast cutoff. Solar and grid charge are positive and household demand is negative.',
        ...limits.map(limitLabel)].join(' '));

    const line = (x1, y1, x2, y2, stroke = '#d5ddd8', weight = 1, dash) => {
      svg('line', { x1, y1, x2, y2, stroke, 'stroke-width': weight, ...(dash ? { 'stroke-dasharray': dash } : {}) });
    };
    const label = (x, y, text, anchor = 'start', size = 13, weight = 400, fill = '#33443e') =>
      svg('text', { x, y, 'text-anchor': anchor, 'font-size': size, 'font-weight': weight, fill }, text);

    function dailyEnergyCard(center, span, rows) {
      const baseWidth = 248;
      const width = Math.min(baseWidth, span - 10);
      const scale = width / baseWidth;
      const cardX = center - width / 2;
      const y = energyTop + 5;
      const valueX = [cardX + 173 * scale, cardX + width - 10 * scale];
      svg('rect', { x: cardX, y, width, height: (26 + 20 * rows.length) * scale,
        rx: 7 * scale, fill: '#fff', stroke: '#cbd8e2' });
      ['Demand (kWh)', 'Solar (kWh)'].forEach((heading, i) =>
        label(valueX[i], y + 15 * scale, heading, 'end', 11 * scale, 650));
      rows.forEach(({ name, color, values }, i) => {
        const rowY = y + (34 + 20 * i) * scale;
        label(cardX + 10 * scale, rowY, name, 'start', 12 * scale, 400, color);
        values.forEach((value, j) => label(valueX[j], rowY, value, 'end', 15 * scale, 700, color));
      });
    }

    label(left, 27, 'Battery state of charge (%)', 'start', 17, 650);
    if (limits.length) {
      const boxX = 354, columnWidth = 204;
      svg('rect', { x: boxX, y: 7, width: columnWidth * limits.length, height: 28,
        rx: 5, fill: '#fff', stroke: '#c4cfc8' });
      limits.forEach((limit, index) => {
        const [, appearance] = limit;
        const start = boxX + 12 + columnWidth * index;
        line(start, 21, start + 26, 21, appearance.color, 2, appearance.dash);
        label(start + 34, 26, limitLabel(limit), 'start', 14, 650, appearance.color);
      });
    }
    label(left, energyTop - 16, 'Solar, demand and grid charging', 'start', 17, 650);
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
        for (const bottom of plotBottoms) label(center, bottom + 37, date, 'middle', 13, 650);
      }
      if (span < 135) continue;

      const inDay = rows => rows.filter(row => row.time >= day && row.time < next);
      const actual = inDay(history), projected = inDay(forecast);
      const isToday = formatters.date.format(day * 1000) === today;
      const isFuture = day > asOf;
      const rowNames = isFuture ? ['Forecast'] : ['Estimated', isToday ? 'Measured so far' : 'Measured'];
      const rowColors = isFuture ? ['#26384d'] : ['#a3431b', '#16736e'];

      const sum = values => values.reduce((total, value) => Number.isFinite(value) ? (total ?? 0) + value : total, null);
      const energyKeys = ['demand_kwh', 'solar_kwh'];
      const forecastTotals = energyKeys.map(key => sum(projected.map(row => row[key])));
      const measuredTotals = energyKeys.map(key => sum(actual.map(row => row[key])));
      const estimatedTotals = energyKeys.map((key, i) => sum([
        ...actual.map(row => row['estimated_' + key]), isToday ? forecastTotals[i] : null,
      ]));
      const energyValues = isFuture ? [forecastTotals] : [estimatedTotals, measuredTotals];
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

    function drawPath(path, appearance) {
      if (!path) return;
      svg('path', { d: path, fill: 'none', stroke: appearance.color, 'stroke-width': appearance.weight ?? 2,
        'stroke-linejoin': 'round', ...(appearance.dash ? { 'stroke-dasharray': appearance.dash } : {}) });
      visibleLines.push(appearance);
    }

    function socPath(rows, key, appearance, maximumGap) {
      let path = '', previous = null;
      for (const { time, [key]: value } of rows) {
        if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
        path += (previous !== null && time - previous <= maximumGap ? 'L' : 'M') + x(time) + ' ' + socY(value);
        previous = time;
      }
      drawPath(path, appearance);
    }

    function forecastSocPath(key, endKey, appearance) {
      let path = '', previous = null;
      for (const row of forecast) {
        if (![row.time, row.end, row[key], row[endKey]].every(Number.isFinite)) continue;
        if (row.time !== previous) path += 'M' + x(row.time) + ' ' + socY(row[key]);
        path += 'L' + x(row.end) + ' ' + socY(row[endKey]);
        previous = row.end;
      }
      drawPath(path, appearance);
    }

    function intervalPath(rows, key, appearance, sign) {
      let path = '', previous = null;
      for (const row of rows) {
        if (![row.time, row.end, row[key]].every(Number.isFinite) || row.end <= row.time) continue;
        path += (row.time === previous ? 'L' : 'M') + x(row.time) + ' ' + energyY(sign * row[key]) + 'H' + x(row.end);
        previous = row.end;
      }
      drawPath(path, appearance);
    }

    function gridBars(rows, appearance, showInLegend) {
      const bars = rows.filter(row => Number.isFinite(row.grid_kwh) && row.grid_kwh > 0 && row.end > row.time);
      for (const row of bars) {
        const y = energyY(row.grid_kwh);
        svg('rect', { x: x(row.time) + 1, y, width: Math.max(1, x(row.end) - x(row.time) - 2),
          height: energyY(0) - y, fill: appearance.color, opacity: 0.8 });
      }
      if (bars.length || showInLegend) visibleLines.push(appearance);
    }

    for (const [value, appearance] of limits) {
      const weight = data.reserve === data.target && appearance === lines.reserve ? 3 : 1.6;
      line(left, socY(value), right, socY(value), appearance.color, weight, appearance.dash);
    }
    const historyGap = minuteHistory ? 300 : 3601;
    socPath(socHistory, 'soc', lines.measuredSoc, historyGap);
    socPath(socHistory, 'estimated_soc', lines.estimatedSoc, historyGap);
    forecastSocPath('soc', 'end_soc', lines.forecastSoc);
    forecastSocPath('no_charge_soc', 'end_no_charge_soc', lines.unchargedSoc);

    gridBars(history, lines.recordedGrid, false);
    gridBars(forecast, lines.proposedGrid, forecast.length > 0);
    intervalPath(history, 'demand_kwh', lines.measuredDemand, -1);
    intervalPath(history, 'estimated_demand_kwh', lines.estimatedDemand, -1);
    intervalPath(forecast, 'demand_kwh', lines.forecastDemand, -1);
    intervalPath(history, 'solar_kwh', lines.measuredSolar, 1);
    intervalPath(history, 'estimated_solar_kwh', lines.estimatedSolar, 1);
    intervalPath(forecast, 'solar_kwh', lines.forecastSolar, 1);

    if (Number.isFinite(data.cutoff)) {
      const divider = x(data.cutoff);
      for (const [y, bottom] of [[top, socBottom], [energyPlotTop, energyBottom]]) {
        line(divider, y, divider, bottom, '#34465a', 2, '3 4');
      }
      const boxWidth = 48;
      const boxX = divider + 7 + boxWidth <= right ? divider + 7 : divider - 7 - boxWidth;
      svg('rect', { x: boxX, y: top + 3, width: boxWidth, height: 21, rx: 3, fill: '#fff' });
      const cutoffTime = formatters.clock.format(data.cutoff * 1000);
      label(boxX + boxWidth / 2, top + 17, cutoffTime, 'middle', 12, 650, '#34465a');
    }

    for (const { label: title, color, dash, bar } of visibleLines) {
      const item = html('span');
      const swatch = html('i');
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.setProperty('--series-color', color);
      if (dash) swatch.classList.add('is-dashed');
      if (bar) swatch.classList.add('is-bar');
      item.append(swatch, title);
      legend.append(item);
    }
    return true;
  }

  function drawSchedule(slots, formatters) {
    schedule.replaceChildren();
    schedule.hidden = !formatters || !Array.isArray(slots) || !slots.length;
    if (schedule.hidden) return;
    const table = html('table');
    table.className = 'solar-command-table';
    const header = html('tr');
    for (const name of ['Start', 'End', 'Energy', 'Power', 'Target SOC']) {
      const heading = html('th', name);
      heading.scope = 'col';
      header.append(heading);
    }
    table.append(html('thead'));
    table.tHead.append(header);
    const body = html('tbody');
    for (const slot of slots) {
      const row = html('tr');
      const stamp = time => Number.isFinite(time) ? formatters.full.format(time * 1000) : '—';
      const value = (number, unit) => Number.isFinite(number) ? number.toFixed(2) + unit : '—';
      row.append(...[stamp(slot.start), stamp(slot.end), value(slot.kwh, ' kWh'), value(slot.kw, ' kW'),
        value(slot.target_soc, '%')].map(text => html('td', text)));
      body.append(row);
    }
    table.append(body);
    schedule.append(table);
  }

  function render(data) {
    const formatters = timestampFormatters(data.timezone);
    const windowLabel = values => Array.isArray(values) ? values.join(', ') || 'None' : null;
    const operatingRange = Number.isFinite(data.minimum_operating_soc) && Number.isFinite(data.maximum_operating_soc)
      ? data.minimum_operating_soc + '%–' + data.maximum_operating_soc + '%' : null;
    figure.hidden = !draw(data, formatters);
    const limits = [
      Number.isFinite(data.reserve) ? 'Reserve ' + data.reserve + '%' : null,
      Number.isFinite(data.target) ? 'Grid charge cap ' + data.target + '%' : null,
    ].filter(Boolean).join(' · ');
    asOf.textContent = formatters && Number.isFinite(data.as_of)
      ? 'NAS time · ' + formatters.full.format(data.as_of * 1000) + ' (' + data.timezone + ')' : '';
    const minimumTime = formatters && Number.isFinite(data.minimum_soc_time)
      ? ' · ' + formatters.localMinute.format(data.minimum_soc_time * 1000) : '';
    const entries = [
      ['Allowed grid charging (local time)', windowLabel(data.allowed)],
      ['Blocked grid charging (local time)', windowLabel(data.blocked)],
      ['Battery operating range', operatingRange],
      ['Battery SOC limits', figure.hidden && limits ? limits : null],
      ['Forecast minimum SOC', Number.isFinite(data.minimum_soc) ? data.minimum_soc.toFixed(1) + '%' + minimumTime : null],
    ].filter(([, value]) => value !== null);
    windows.replaceChildren(...entries.map(([name, value]) => {
      const card = html('div');
      card.append(html('dt', name), html('dd', value));
      return card;
    }));
    windows.hidden = !entries.length;

    const planned = Number.isFinite(data.total_grid_kwh) ? data.total_grid_kwh.toFixed(2) + ' kWh' : '';
    const headlines = {
      planned: 'Grid charging proposed' + (planned ? ' · ' + planned : ''),
      'no-charge': 'No grid charging proposed.',
      infeasible: 'The forecast cannot maintain the reserve within the allowed charging windows.',
      unavailable: 'Charge plan unavailable.',
    };
    status.dataset.state = Object.hasOwn(headlines, data.status) ? data.status : 'unavailable';
    status.textContent = headlines[status.dataset.state];

    const explanations = [data.strategy, data.message, ...(Array.isArray(data.warnings) ? data.warnings : [])]
      .filter(text => typeof text === 'string' && text && text !== status.textContent);
    get('decision').textContent = [...new Set(explanations)].join(' ');
    drawSchedule(data.schedule, formatters);
    strategy.hidden = !explanations.length && schedule.hidden;

    const used = Array.isArray(data.defaults) ? data.defaults : null;
    const defaultList = get('default-list');
    defaultList.replaceChildren();
    defaults.hidden = used === null;
    if (used?.length) {
      const list = html('ul');
      list.append(...used.map(item => html('li', item)));
      defaultList.append(list);
    } else if (used && data.defaults_complete !== false) {
      defaultList.append(html('p', status.dataset.state === 'unavailable'
        ? 'No defaults were reported for this request.' : 'No defaults were used.'));
    }
    if (used && data.defaults_complete === false) {
      defaultList.append(html('p', status.dataset.state === 'unavailable'
        ? 'The charge plan could not complete the defaults audit.'
        : 'Some NAS forecast data did not report whether its source used defaults.'));
    }
    const provenance = Array.isArray(data.provenance) ? data.provenance : [];
    get('source-list').replaceChildren(...provenance.map(item => html('li', item)));
    sources.hidden = !provenance.length;
  }

  async function refresh() {
    if (panel.hidden || document.hidden) return;
    if (loading) { pending = true; return; }
    const connection = generation;
    loading = true;
    button.disabled = true;
    panel.setAttribute('aria-busy', 'true');
    try {
      const data = await cloud.readControl();
      if (connection !== generation) return;
      render(data ? {
        strategy: 'Plan backwards to protect the battery reserve. Schedule only the grid energy needed during the allowed hours, up to the grid charge target cap. Solar charges the battery first and can raise SOC above the grid charge cap up to the operating maximum.',
        ...data,
      } : { status: 'unavailable', message: 'No Control plan has arrived from the NAS.' });
      status.hidden = false;
    } catch (error) {
      if (connection === generation) {
        const message = error.code === '42501'
          ? 'Run control-read.sql in Supabase to enable Control reads.'
          : error.message || 'Could not read the Control plan from Supabase.';
        render({ status: 'unavailable', message });
        status.hidden = false;
      }
    } finally {
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
    render({});
    status.hidden = true;
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
