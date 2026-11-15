'use strict';

const SolarGeneration = (() => {
  const frame = { width: 1200, left: 108, right: 1176, top: 82 };
  const plotColors = { day: '#EEF2F5', grid: '#DDE3E7', axis: '#BBC4CB', boundary: '#BCC7CE' };

  function svgElement(parent, tag, attributes, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }

  function chartElements(svg, height) {
    const { width } = frame;
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('font-family', 'DejaVu Sans, Verdana, sans-serif');
    const element = (tag, attributes, text) => svgElement(svg, tag, attributes, text);
    function line(x1, y1, x2, y2, stroke, size = 1, dash = '') {
      element('line', { x1, y1, x2, y2, stroke, 'stroke-width': size, 'stroke-dasharray': dash });
    }
    function label(x, y, text, anchor = 'start', size = 13, weight = 400, extra = {}) {
      element('text', { x, y, 'text-anchor': anchor, 'font-size': size, 'font-weight': weight, fill: '#000', ...extra }, text);
    }
    element('rect', { width, height, fill: '#fff' });
    return { element, line, label };
  }

  function draw(svg, data, cursorTime) {
    const demand = data.kind === 'demand';
    let warning = [...new Set([data.run_warning, data.model_warning].filter(Boolean))].join(' ');
    const { start: dataStart, end: dataEnd } = data;
    svg.replaceChildren();
    if (!Number.isFinite(dataStart) || !Number.isFinite(dataEnd) || dataEnd <= dataStart) {
      return { hasData: false, warning: 'The NAS did not provide a valid forecast chart window.' };
    }
    const withinWindow = points => points.filter(point => Array.isArray(point)
      && Number.isFinite(point[0]) && Number.isFinite(point[1])
      && (demand ? point[0] >= dataStart && point[0] < dataEnd : point[0] > dataStart && point[0] <= dataEnd));
    const measured = withinWindow(data.measured);
    const past = withinWindow(data.past);
    const forecast = withinWindow(data.forecast);
    const series = [
      { values: measured, color: '#238783', label: demand ? 'Measured' : 'Measured inverter', fill: true },
      { values: past, color: '#BA4A18', label: demand ? 'Estimated' : 'AI past estimate' },
      { values: forecast, color: '#000000', label: demand ? 'Forecast' : 'AI forecast (ensemble median)' },
    ].filter(line => line.values.length);

    if (!series.length) {
      warning = [warning, 'No measured inverter data is available.'].filter(Boolean).join(' ');
      return { hasData: false, warning };
    }
    const cutoff = demand && Number.isFinite(data.latest_reading) ? data.latest_reading : data.download;
    const download = Number.isFinite(cutoff) && cutoff >= dataStart && cutoff < dataEnd ? cutoff : null;
    const centered = Number.isFinite(cursorTime) && cursorTime >= dataStart && cursorTime < dataEnd;
    const cursor = centered ? cursorTime : download;
    // Pan the display window independently of the dates used for the series and daily totals.
    const span = dataEnd - dataStart;
    const start = centered ? cursor - span / 2 : dataStart;
    const end = start + span;
    const { width, left, right, top } = frame;
    const height = 522, bottom = 387;
    const timezone = { timeZone: data.timezone };
    const calendar = new Intl.DateTimeFormat('en-GB', { ...timezone, day: 'numeric', month: 'short' });
    const clock = new Intl.DateTimeFormat('en-GB', { ...timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const all = series.flatMap(line => line.values);
    const calendarStart = Math.min(start, dataStart);
    const calendarEnd = Math.max(end, dataEnd);
    const midnights = [calendarStart], ticks = [];
    for (let time = Math.ceil(calendarStart / 900) * 900; time < calendarEnd; time += 900) {
      const tick = clock.format(time * 1000);
      if (tick === '00:00' && time > calendarStart) midnights.push(time);
      if (time >= start && time < end && ['00:00', '06:00', '12:00', '18:00'].includes(tick)) ticks.push([time, tick]);
    }
    midnights.push(calendarEnd);
    const ceiling = Math.max(0.05, ...all.map(point => point[1])) * 1.29;
    const spacing = ceiling / 9;
    const magnitude = 10 ** Math.floor(Math.log10(spacing));
    const step = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= spacing) * magnitude;
    const decimals = Math.max(2, Number(step.toPrecision(8)).toString().split('.')[1]?.length ?? 0);
    const x = time => left + (time - start) / (end - start) * (right - left);
    const y = power => bottom - power / ceiling * (bottom - top);

    const { element, line, label } = chartElements(svg, height);
    const title = demand ? 'Home demand forecast' : 'Solar generation forecast';
    const modelFile = typeof data.model_name === 'string' ? data.model_name.trim() : '';
    const modelLabel = typeof data.model_label === 'string' ? data.model_label.trim() : '';
    const model = modelLabel && modelFile && modelLabel !== modelFile
      ? `${modelLabel} (${modelFile})` : modelFile || modelLabel || 'unavailable';
    function forecastTime(timestamp) {
      if (!Number.isFinite(timestamp)) return 'unavailable';
      const time = timestamp * 1000;
      const [day, month] = calendar.format(time).split(' ');
      return `${day.padStart(2, '0')}:${month.slice(0, 3)}, ${clock.format(time)}`;
    }
    const hasLastRun = Number.isInteger(data.last_run_at);
    const hasCutoff = demand && Number.isFinite(data.inputs_through);
    const lastForecast = forecastTime(hasLastRun ? data.last_run_at : hasCutoff ? null : data.forecast_issued_at);
    const inputIssue = hasCutoff ? ' · Inputs through ' + forecastTime(data.inputs_through)
      : demand && hasLastRun && Number.isFinite(data.forecast_issued_at)
      && data.last_run_at !== data.forecast_issued_at ? ` · Input issue ${forecastTime(data.forecast_issued_at)}` : '';
    const subtitle = `Model ${model} · Last forecast ${lastForecast}${inputIssue}`;
    svg.setAttribute('aria-label', `${title}. ${subtitle}`);
    label(left, 42, title, 'start', 24, 700);
    label(left, 65, subtitle, 'start', 14, 400, { fill: '#34465A' });
    const intervalSeconds = demand ? (data.interval_minutes || 60) * 60 : 3600;
    const axisMiddle = (top + bottom) / 2;
    label(61, axisMiddle, demand ? ((data.interval_minutes || 60) === 60 ? 'Hourly home demand (kWh)' : 'Home demand per ' + (data.interval_minutes || 60) + ' min (kWh)') : 'Hourly mean DC power (kW)', 'middle', 14, 400, {
      transform: 'rotate(-90 61 ' + axisMiddle + ')',
    });
    const dayKey = new Intl.DateTimeFormat('en-CA', { ...timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const today = dayKey.format(Number.isFinite(data.as_of) ? data.as_of * 1000 : Date.now());
    const days = midnights.slice(0, -1).map((time, i) => ({
      time, until: midnights[i + 1], key: dayKey.format(time * 1000),
      visibleStart: Math.max(time, start), visibleEnd: Math.min(midnights[i + 1], end),
    })).filter(day => day.visibleStart < day.visibleEnd);
    for (const { visibleStart, visibleEnd, key } of days) {
      if (key !== today) element('rect', {
        x: x(visibleStart), y: top, width: x(visibleEnd) - x(visibleStart), height: bottom - top, fill: plotColors.day,
      });
    }
    for (let power = 0; power <= ceiling + 1e-9; power += step) {
      line(left, y(power), right, y(power), plotColors.grid, 0.8);
      label(left - 10, y(power) + 4, power.toFixed(decimals), 'end');
    }
    for (const [time, tick] of ticks) label(x(time), bottom + 19, tick, 'middle', 13);
    for (const { time, visibleStart, visibleEnd } of days) {
      if (time > start) line(x(time), top, x(time), bottom, plotColors.boundary);
      const [day, month] = calendar.format(time * 1000).split(' ');
      const number = Number(day);
      const suffix = number % 100 >= 11 && number % 100 <= 13
        ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th');
      const dayLabelWidth = x(visibleEnd) - x(visibleStart);
      if (dayLabelWidth >= 65) label(x((visibleStart + visibleEnd) / 2), bottom + 52,
        day + suffix + ' ' + month, 'middle', 14, 700);
    }
    line(left, top, left, bottom, plotColors.axis);
    line(left, bottom, right, bottom, plotColors.axis);
    const clipId = svg.id + '-plot';
    const clip = svgElement(element('defs', {}), 'clipPath', { id: clipId });
    svgElement(clip, 'rect', { x: left, y: top, width: right - left, height: bottom - top });
    const plot = element('g', { 'clip-path': 'url(#' + clipId + ')' });
    for (const { values, color, fill } of series) {
      const firstTime = demand && color === '#000000' ? download ?? dataStart : dataStart;
      let segment = [];
      for (const point of values) {
        if (segment.length && point[0] - segment[segment.length - 1][0] > intervalSeconds) {
          drawSegment(segment, color, fill, firstTime);
          segment = [];
        }
        segment.push(point);
      }
      drawSegment(segment, color, fill, firstTime);
    }
    function drawSegment(points, color, fill, firstTime) {
      const xy = points.map(([time, power]) => [x(Math.max(time, firstTime)), y(power)]);
      if (demand) {
        let path = 'M' + xy[0].join(',');
        for (let i = 1; i < xy.length; i++) path += ' H' + xy[i][0] + ' V' + xy[i][1];
        path += ' H' + x(Math.min(dataEnd, points[points.length - 1][0] + intervalSeconds));
        if (fill) svgElement(plot, 'path', { d: path + ' V' + bottom + ' H' + xy[0][0] + ' Z', fill: color, opacity: 0.22 });
        svgElement(plot, 'path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2.4 });
        return;
      }
      if (xy.length === 1) {
        svgElement(plot, 'circle', { cx: xy[0][0], cy: xy[0][1], r: 2.5, fill: color });
        return;
      }
      const intervals = xy.slice(1).map(([nextX], i) => nextX - xy[i][0]);
      const secants = intervals.map((width, i) => (xy[i + 1][1] - xy[i][1]) / width);
      function edgeSlope(h0, h1, d0, d1) {
        const slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if (Math.sign(slope) !== Math.sign(d0)) return 0;
        return Math.sign(d0) !== Math.sign(d1) && Math.abs(slope) > 3 * Math.abs(d0)
          ? 3 * d0 : slope;
      }
      const last = secants.length - 1;
      const slopes = last === 0 ? [secants[0], secants[0]] : [
        edgeSlope(intervals[0], intervals[1], secants[0], secants[1]),
        ...secants.slice(1).map((next, i) => {
          const previous = secants[i];
          if (previous * next <= 0) return 0;
          const w1 = 2 * intervals[i + 1] + intervals[i];
          const w2 = intervals[i + 1] + 2 * intervals[i];
          return (w1 + w2) / (w1 / previous + w2 / next);
        }),
        edgeSlope(intervals[last], intervals[last - 1], secants[last], secants[last - 1]),
      ];
      let path = 'M' + xy[0].join(',');
      for (let i = 1; i < xy.length; i++) {
        const [x0, y0] = xy[i - 1], [x1, y1] = xy[i];
        const third = (x1 - x0) / 3;
        path += ' C' + [x0 + third, y0 + third * slopes[i - 1], x1 - third, y1 - third * slopes[i], x1, y1].join(',');
      }
      if (fill) svgElement(plot, 'path', { d: path + ' V' + bottom + ' H' + xy[0][0] + ' Z', fill: color, opacity: 0.22 });
      svgElement(plot, 'path', { d: path, fill: 'none', stroke: color, 'stroke-width': color === '#000000' ? 2.8 : 2.4, 'stroke-linejoin': 'round' });
    }
    if (cursor !== null) {
      const divider = x(cursor);
      line(divider, top, divider, bottom, '#34465a', 2.5, '2 5');
      const [day, month] = calendar.format(cursor * 1000).split(' ');
      const cursorClock = centered ? new Intl.DateTimeFormat('en-GB', {
        ...timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }) : clock;
      const color = { fill: '#34465A' };
      const labelX = divider - 11;
      const labelWidth = centered ? 72 : 53;
      element('rect', { x: labelX + 5 - labelWidth, y: top + 63, width: labelWidth, height: 34, fill: '#fff', opacity: 0.95 });
      label(labelX, top + 78, day.padStart(2, '0') + month.toLowerCase(), 'end', 13, 700, color);
      label(labelX, top + 93, cursorClock.format(cursor * 1000), 'end', 13, 700, color);
    }
    const actualHours = new Map(measured);
    const estimateHours = new Map(past);
    const sum = (points, time, until, match) => {
      const values = points.filter(([hour]) => (demand ? hour >= time && hour < until : hour > time && hour <= until) && (!match || match.has(hour)));
      return values.length ? values.reduce((total, [, power]) => total + power, 0) : null;
    };
    for (const { time, until, key, visibleStart, visibleEnd } of days) {
      if (until <= dataStart || time >= dataEnd) continue;
      const isToday = key === today;
      const estimated = isToday ? [...past, ...forecast] : past;
      const rawToday = demand && isToday && Object.prototype.hasOwnProperty.call(data, 'measured_today_kwh');
      const measuredTotal = rawToday
        ? (Number.isFinite(data.measured_today_kwh) ? data.measured_today_kwh : null)
        : sum(measured, time, until, isToday ? null : estimateHours);
      const metrics = key > today
        ? [['Forecast', sum(forecast, time, until), '#26384D']]
        : [
          ['Estimated', sum(estimated, time, until, isToday ? null : actualHours), '#A3431B'],
          [isToday ? 'Measured so far' : 'Measured', measuredTotal, '#16736E'],
        ];
      const center = x((visibleStart + visibleEnd) / 2);
      const cardWidth = Math.min(202, x(visibleEnd) - x(visibleStart) - 10);
      if (cardWidth < 104) continue;
      const scale = Math.min(1, cardWidth / 202);
      const cardX = center - cardWidth / 2;
      element('rect', { x: cardX, y: top + 5, width: cardWidth,
        height: (12 + metrics.length * 20) * scale, rx: 7 * scale,
        fill: '#fff', stroke: '#CBD8E2', 'stroke-width': 1 });
      metrics.forEach(([name, amount, color], i) => {
        const rowY = top + 5 + (20 + i * 20) * scale;
        const liveMeasured = rawToday && name === 'Measured so far';
        label(cardX + 10 * scale, rowY, name, 'start', 12 * scale, 400, { fill: color });
        label(cardX + cardWidth - 10 * scale, rowY,
          amount === null ? '—' : amount.toFixed(liveMeasured ? 4 : 2) + ' kWh',
          'end', (liveMeasured ? 12.5 : 15) * scale, 700, { fill: color });
      });
    }
    label((left + right) / 2, bottom + 72, data.timezone === 'Europe/London'
      ? 'UK local time' : data.timezone + ' local time', 'middle', 14);
    const widths = { 'Measured inverter': 178, 'AI past estimate': 167, 'AI forecast (ensemble median)': 238, Measured: 132, Estimated: 135, Forecast: 120 };
    const total = series.reduce((sum, item) => sum + widths[item.label], 0) - 20;
    let position = (width - total) / 2;
    for (const { color, label: title } of series) {
      line(position, height - 31, position + 27, height - 31, color, color === '#000000' ? 2.8 : 2.4);
      label(position + 36, height - 27, title, 'start', 13);
      position += widths[title];
    }
    return { hasData: true, warning };
  }

  function drawErrors(svg, data) {
    svg.replaceChildren();
    if (!Array.isArray(data.error_blocks) || !data.error_blocks.length) return false;

    const days = ['previous', 'current', 'next'];
    const periods = ['02:00–08:00', '08:00–14:00', '14:00–20:00', '20:00–02:00'];
    const blocks = new Map(data.error_blocks.map(block => [block.day + block.period, block]));
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });
    const { left, right, top } = frame;
    const height = 390, bottom = 286, columnGap = 26;
    const columnWidth = (right - left - 2 * columnGap) / days.length;
    const rowHeight = (bottom - top) / periods.length;
    const minimum = -4, maximum = 2;
    const rangeColor = plotColors.boundary, measuredColor = '#6942A0', errorColor = '#238783';
    let hasRanges = false;
    const format = number => number.toFixed(2) + ' kWh';
    const { element, line, label } = chartElements(svg, height);

    svg.setAttribute('aria-label', 'Six-hour home demand forecast errors. Forecast minus measured energy in kilowatt-hours.');
    label(left, 42, 'Six-hour home demand forecast errors', 'start', 24, 700);

    periods.forEach((period, row) => label(left - 10, top + (row + 0.5) * rowHeight + 4, period, 'end'));
    for (const [column, day] of days.entries()) {
      const columnLeft = left + column * (columnWidth + columnGap);
      const x = value => columnLeft + (value - minimum) / (maximum - minimum) * columnWidth;
      const firstBlock = blocks.get(day + '02:00');
      const dayName = day[0].toUpperCase() + day.slice(1);
      const heading = Number.isFinite(firstBlock?.start) ? dayName + ' · ' + date.format(firstBlock.start * 1000) : dayName;
      label(columnLeft + columnWidth / 2, top - 13, heading, 'middle', 14, 700);
      element('rect', { x: columnLeft, y: top, width: columnWidth, height: bottom - top,
        fill: day === 'current' ? '#fff' : plotColors.day });
      for (let tick = minimum; tick <= maximum; tick++) {
        line(x(tick), top, x(tick), bottom, tick === 0 ? plotColors.boundary : plotColors.grid, 0.8);
        label(x(tick), bottom + 19, String(tick).replace('-', '−'), 'middle');
      }
      line(columnLeft, bottom, columnLeft + columnWidth, bottom, plotColors.axis);

      for (const [row, period] of periods.entries()) {
        const block = blocks.get(day + period.slice(0, 5));
        const y = top + (row + 0.5) * rowHeight;
        const range = block?.range_kwh;
        const hasRange = Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] <= range[1];
        const hasMeasured = Number.isFinite(block?.measured_kwh);
        const hasError = hasMeasured && Number.isFinite(block.error_kwh);
        const group = element('g', {});
        const details = [heading + ', ' + period];
        if (hasRange) {
          hasRanges = true;
          details.push('Error range ' + format(range[0]) + ' to ' + format(range[1]));
          const start = Math.max(minimum, range[0]), end = Math.min(maximum, range[1]);
          if (start <= end) {
            svgElement(group, 'line', { x1: x(start), x2: x(end), y1: y, y2: y,
              stroke: rangeColor, 'stroke-width': 9, 'stroke-linecap': 'round' });
          }
        }
        if (hasMeasured) {
          details.push('Measured ' + format(block.measured_kwh));
          svgElement(group, 'circle', { cx: x(0), cy: y, r: 6,
            fill: '#fff', stroke: measuredColor, 'stroke-width': 2.5 });
        }
        if (hasError) {
          const error = block.error_kwh;
          details.push('Forecast error ' + format(error));
          if (error < minimum || error > maximum) {
            const edge = x(error < minimum ? minimum : maximum);
            const inside = edge + (error < minimum ? 9 : -9);
            svgElement(group, 'polygon', { points: `${edge},${y} ${inside},${y - 6} ${inside},${y + 6}`, fill: errorColor });
          } else {
            svgElement(group, 'circle', { cx: x(error), cy: y, r: 4, fill: errorColor });
          }
        }
        svgElement(group, 'title', {}, details.join('. '));
      }
    }

    const middle = (left + right) / 2;
    label(middle, bottom + 45, 'Forecast − measured (kWh)', 'middle', 14);
    const legendY = height - 31;
    const legendStart = frame.width / 2 - 300;
    if (hasRanges) {
      element('line', { x1: legendStart, y1: legendY, x2: legendStart + 27, y2: legendY,
        stroke: rangeColor, 'stroke-width': 7, 'stroke-linecap': 'round' });
    }
    label(legendStart + 36, legendY + 4, hasRanges ? '02:00 study 90% range' : 'Study range unavailable');
    element('circle', { cx: legendStart + 221, cy: legendY, r: 6, fill: '#fff', stroke: measuredColor, 'stroke-width': 2.5 });
    label(legendStart + 237, legendY + 4, 'Measured (zero reference)');
    element('circle', { cx: legendStart + 458, cy: legendY, r: 4, fill: errorColor });
    label(legendStart + 474, legendY + 4, 'Saved forecast error');
    return true;
  }

  return { draw, drawErrors };
})();
