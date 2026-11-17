'use strict';

const SolarGeneration = (() => {
  const { figureLayout, responsiveFigureWidth } = window.solarDashboardData;
  const plotColors = { day: '#EEF2F5', grid: '#DDE3E7', axis: '#BBC4CB', boundary: '#BCC7CE' };

  function svgElement(parent, tag, attributes, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }

  function chartElements(svg, height, width) {
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    const element = (tag, attributes, text) => svgElement(svg, tag, attributes, text);
    function line(x1, y1, x2, y2, stroke, size = 1, dash = '') {
      element('line', { x1, y1, x2, y2, stroke, 'stroke-width': size, 'stroke-dasharray': dash });
    }
    function label(x, y, text, anchor = 'start', size = figureLayout.label, weight = 400, extra = {}) {
      element('text', { x, y, 'text-anchor': anchor, 'font-size': size, 'font-weight': weight, fill: '#000', ...extra }, text);
    }
    element('rect', { width, height, fill: '#fff' });
    return { element, line, label };
  }

  function dailyTotals(data, start, end, period) {
    if (!data) return {};
    const demand = data.kind === 'demand';
    const { measured, past, forecast } = data;
    const sum = (points, match = null) => {
      let total = null;
      for (const [time, value] of points) {
        const inDay = demand ? time >= start && time < end : time > start && time <= end;
        if (inDay && (!match || match.has(time))) total = (total ?? 0) + value;
      }
      return total;
    };
    if (period === 'future') return { forecast: sum(forecast) };
    if (period === 'today') {
      return {
        estimated: sum([...past, ...forecast]),
        measured: demand && Object.prototype.hasOwnProperty.call(data, 'measured_today_kwh')
          ? data.measured_today_kwh : sum(measured),
      };
    }
    return {
      estimated: sum(past, new Map(measured)),
      measured: sum(measured, new Map(past)),
    };
  }

  function intervalTitle(timeZone) {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
    const clock = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    });
    return (start, end) => {
      const firstDay = day.format(start * 1000);
      const lastDay = day.format(end * 1000);
      const endDay = firstDay === lastDay ? '' : lastDay + ', ';
      return firstDay + ', ' + clock.format(start * 1000) + ' – ' + endDay + clock.format(end * 1000);
    };
  }

  function draw(svg, data, cursorTime) {
    const demand = data.kind === 'demand';
    let warning = [...new Set([data.run_warning, data.model_warning].filter(Boolean))].join(' ');
    const { start, end } = data;
    svg.replaceChildren();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      window.SolarLoggerChartHover.clear(svg);
      return { hasData: false, warning: 'The NAS did not provide a valid forecast chart window.' };
    }
    const withinWindow = points => points.filter(point => Array.isArray(point)
      && Number.isFinite(point[0]) && Number.isFinite(point[1])
      && (demand ? point[0] >= start && point[0] < end : point[0] > start && point[0] <= end));
    const measured = withinWindow(data.measured);
    const past = withinWindow(data.past);
    const forecast = withinWindow(data.forecast);
    const series = [
      { values: measured, color: '#238783', label: demand ? 'Measured' : 'Measured inverter', fill: true },
      { values: past, color: '#BA4A18', label: demand ? 'Estimated' : 'AI past estimate' },
      { values: forecast, color: '#000000', label: demand ? 'Forecast' : 'AI forecast (ensemble median)' },
    ].filter(line => line.values.length);

    if (!series.length) {
      warning = [warning, 'No saved forecast or measured values are available in this date range.'].filter(Boolean).join(' ');
    }
    const cutoff = demand && Number.isFinite(data.latest_reading) ? data.latest_reading : data.download;
    const inWindow = time => Number.isFinite(time) && time >= start && time < end;
    const liveCursor = inWindow(cursorTime);
    const cursor = liveCursor ? cursorTime : inWindow(cutoff) ? cutoff : null;
    const width = responsiveFigureWidth(svg, () => draw(svg, data, cursorTime));
    const left = figureLayout.left, right = width - figureLayout.right, top = 82;
    const bottom = top + figureLayout.plotHeight, height = bottom + 135;
    const timezone = { timeZone: data.timezone };
    const calendar = new Intl.DateTimeFormat('en-GB', { ...timezone, day: 'numeric', month: 'short' });
    const clock = new Intl.DateTimeFormat('en-GB', { ...timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const all = series.flatMap(line => line.values);
    const midnights = [start], ticks = [];
    for (let time = Math.ceil(start / 900) * 900; time < end; time += 900) {
      const tick = clock.format(time * 1000);
      if (tick === '00:00' && time > start) midnights.push(time);
      if (['00:00', '06:00', '12:00', '18:00'].includes(tick)) ticks.push([time, tick]);
    }
    midnights.push(end);
    const ceiling = Math.max(0.05, ...all.map(point => point[1])) * 1.29;
    const spacing = ceiling / 9;
    const magnitude = 10 ** Math.floor(Math.log10(spacing));
    const niceStep = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= spacing) * magnitude;
    const step = demand ? Math.ceil(niceStep * 100 - 1e-9) / 100 : niceStep;
    const decimals = demand ? 2 : Math.max(2, Number(step.toPrecision(8)).toString().split('.')[1]?.length ?? 0);
    const x = time => left + (time - start) / (end - start) * (right - left);
    const y = power => bottom - power / ceiling * (bottom - top);

    const { element, line, label } = chartElements(svg, height, width);
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
    label(left, 42, title, 'start', figureLayout.title, 650);
    label(left, 65, subtitle, 'start', figureLayout.label, 400, { fill: '#34465A' });
    const intervalSeconds = demand ? (data.interval_minutes || 60) * 60 : 3600;
    const axisMiddle = (top + bottom) / 2;
    label(19, axisMiddle, demand ? ((data.interval_minutes || 60) === 60 ? 'Hourly home demand (kWh)' : 'Home demand per ' + (data.interval_minutes || 60) + ' min (kWh)') : 'Hourly mean DC power (kW)', 'middle', figureLayout.label, 400, {
      transform: 'rotate(-90 19 ' + axisMiddle + ')',
    });
    const dayKey = new Intl.DateTimeFormat('en-CA', { ...timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const today = dayKey.format(Number.isFinite(data.as_of) ? data.as_of * 1000 : Date.now());
    const days = midnights.slice(0, -1).map((time, i) => ({
      time, until: midnights[i + 1], key: dayKey.format(time * 1000),
    }));
    for (const { time, until, key } of days) {
      if (key !== today) element('rect', {
        x: x(time), y: top, width: x(until) - x(time), height: bottom - top, fill: plotColors.day,
      });
    }
    for (let power = 0; power <= ceiling + 1e-9; power += step) {
      line(left, y(power), right, y(power), plotColors.grid, 0.8);
      label(left - 10, y(power) + 4, power.toFixed(decimals), 'end');
    }
    for (const [time, tick] of ticks) label(x(time), bottom + 19, tick, 'middle', figureLayout.label);
    for (const { time, until } of days) {
      if (time > start) line(x(time), top, x(time), bottom, plotColors.boundary);
      const [day, month] = calendar.format(time * 1000).split(' ');
      const number = Number(day);
      const suffix = number % 100 >= 11 && number % 100 <= 13
        ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th');
      const dayLabelWidth = x(until) - x(time);
      if (dayLabelWidth >= 65) label(x((time + until) / 2), bottom + 52,
        day + suffix + ' ' + month, 'middle', figureLayout.label, 650);
    }
    line(left, top, left, bottom, plotColors.axis);
    line(left, bottom, right, bottom, plotColors.axis);
    const clipId = svg.id + '-plot';
    const clip = svgElement(element('defs', {}), 'clipPath', { id: clipId });
    svgElement(clip, 'rect', { x: left, y: top, width: right - left, height: bottom - top });
    const plot = element('g', { 'clip-path': 'url(#' + clipId + ')' });
    const runs = series.map(item => {
      const segments = [];
      let segment = [];
      for (const point of item.values) {
        if (segment.length && point[0] - segment[segment.length - 1][0] > intervalSeconds) {
          segments.push(segment);
          segment = [];
        }
        segment.push(point);
      }
      segments.push(segment);
      return { ...item, segments };
    });
    const historyRun = runs.find(run => run.values === past);
    const forecastRun = runs.find(run => run.values === forecast);
    const lastPast = historyRun?.segments.at(-1);
    const firstForecast = forecastRun?.segments[0];
    const pastHour = lastPast?.at(-1)[0];
    const forecastHour = firstForecast?.[0][0];
    const joinSolar = !demand && forecastHour - pastHour === intervalSeconds;
    for (const { segments, color, fill } of runs) {
      for (const segment of segments) {
        if (joinSolar && segment === lastPast) continue;
        if (joinSolar && segment === firstForecast) {
          // Compute the join from both sets of hourly points and change colour at the last past estimate.
          drawSegment([...lastPast, ...firstForecast], historyRun.color, false,
            { index: lastPast.length, color });
        } else {
          drawSegment(segment, color, fill);
        }
      }
    }
    function strokeSolarPath(path, color) {
      svgElement(plot, 'path', { d: path, fill: 'none', stroke: color,
        'stroke-width': color === '#000000' ? 2.8 : 2.4, 'stroke-linejoin': 'round' });
    }
    function drawSegment(points, color, fill, continuation) {
      const xy = points.map(([time, power]) => [x(time), y(power)]);
      if (demand) {
        let path = 'M' + xy[0].join(',');
        for (let i = 1; i < xy.length; i++) path += ' H' + xy[i][0] + ' V' + xy[i][1];
        path += ' H' + x(Math.min(end, points[points.length - 1][0] + intervalSeconds));
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
        if (i === continuation?.index) {
          if (i === 1) svgElement(plot, 'circle', { cx: x0, cy: y0, r: 2.5, fill: color });
          else strokeSolarPath(path, color);
          color = continuation.color;
          path = 'M' + [x0, y0].join(',');
        }
        const third = (x1 - x0) / 3;
        path += ' C' + [x0 + third, y0 + third * slopes[i - 1], x1 - third, y1 - third * slopes[i], x1, y1].join(',');
      }
      if (fill) svgElement(plot, 'path', { d: path + ' V' + bottom + ' H' + xy[0][0] + ' Z', fill: color, opacity: 0.22 });
      strokeSolarPath(path, color);
    }
    if (cursor !== null) {
      const divider = x(cursor);
      line(divider, top, divider, bottom, '#34465a', 2.5, '2 5');
      const atHandoff = joinSolar && cursor >= pastHour && cursor <= forecastHour;
      window.SolarLoggerCursor.draw(svg, {
        time: cursor, timeZone: data.timezone, x: divider, top: top + 63, left, right,
        ...(atHandoff ? { before: x(pastHour), after: x(forecastHour) } : {}),
      });
    }
    const totalData = { ...data, measured, past, forecast };
    for (const { time, until, key } of days) {
      const isToday = key === today;
      const totals = dailyTotals(totalData, time, until,
        key > today ? 'future' : isToday ? 'today' : 'past');
      const metrics = key > today
        ? [['Forecast', totals.forecast, '#26384D']]
        : [
          ['Estimated', totals.estimated, '#A3431B'],
          [isToday ? 'Measured so far' : 'Measured', totals.measured, '#16736E'],
        ];
      const center = x((time + until) / 2);
      const cardWidth = Math.min(202, x(until) - x(time) - 10);
      if (cardWidth < 104) continue;
      const scale = Math.min(1, cardWidth / 202);
      const textScale = Math.min(1, cardWidth / 160);
      const cardX = center - cardWidth / 2;
      element('rect', { x: cardX, y: top + 5, width: cardWidth,
        height: (12 + metrics.length * 20) * scale, rx: 7 * scale,
        fill: '#fff', stroke: '#CBD8E2', 'stroke-width': 1 });
      metrics.forEach(([name, amount, color], i) => {
        const rowY = top + 5 + (20 + i * 20) * scale;
        label(cardX + 10 * scale, rowY, name, 'start', figureLayout.label * textScale, 400, { fill: color });
        label(cardX + cardWidth - 10 * scale, rowY,
          Number.isFinite(amount) ? amount.toFixed(2) + ' kWh' : '—',
          'end', figureLayout.value * textScale, 650, { fill: color });
      });
    }
    label((left + right) / 2, bottom + 72, data.timezone === 'Europe/London'
      ? 'UK local time' : data.timezone + ' local time', 'middle', figureLayout.label);
    const widths = { 'Measured inverter': 178, 'AI past estimate': 167, 'AI forecast (ensemble median)': 238, Measured: 132, Estimated: 135, Forecast: 120 };
    let position = left;
    for (const { color, label: title } of series) {
      line(position, height - 31, position + 27, height - 31, color, color === '#000000' ? 2.8 : 2.4);
      label(position + 36, height - 27, title, 'start', figureLayout.label);
      position += widths[title];
    }
    const formatInterval = intervalTitle(data.timezone);
    const hoverSeries = series.map(item => ({ ...item, values: new Map(item.values) }));
    const unit = demand ? ' kWh' : ' kW';
    window.SolarLoggerChartHover.attach(svg, (pointerX, pointerY) => {
      if (pointerX < left || pointerX > right || pointerY < top || pointerY > bottom) return null;
      const time = start + (pointerX - left) / (right - left) * (end - start);
      // Demand is plotted as interval steps. Solar values are plotted at the end of each hour.
      const sample = demand
        ? Math.floor(Math.min(time, end - 1) / intervalSeconds) * intervalSeconds
        : Math.round(time / intervalSeconds) * intervalSeconds;
      const rows = [];
      for (const { values, label, color } of hoverSeries) {
        const value = values.get(sample);
        if (Number.isFinite(value)) rows.push({ label, value: value.toFixed(2) + unit, color });
      }
      if (!rows.length) return null;
      const first = demand ? sample : sample - intervalSeconds;
      return {
        title: formatInterval(first, first + intervalSeconds),
        rows,
        guide: { x: demand ? pointerX : x(sample), top, bottom },
      };
    });
    return { hasData: true, warning };
  }

  function drawErrors(svg, data) {
    svg.replaceChildren();
    const days = ['previous', 'current', 'next', 'next2'];
    const rangeBlocks = Array.isArray(data.demand_range_blocks)
      ? data.demand_range_blocks.filter(block => days.includes(block?.day)) : [];
    if (!rangeBlocks.length) {
      window.SolarLoggerChartHover.clear(svg);
      return false;
    }

    const periods = ['02:00–08:00', '08:00–14:00', '14:00–20:00', '20:00–02:00'];
    const blocks = new Map(rangeBlocks.map(block => {
      const measured = Number.isFinite(block.measured_kwh) ? block.measured_kwh : null;
      const savedEstimate = Number.isFinite(block.forecast_kwh) ? block.forecast_kwh : null;
      const historicalEstimate = Number.isFinite(block.historical_estimate_kwh) ? block.historical_estimate_kwh : null;
      const estimate = savedEstimate ?? historicalEstimate;
      const estimateLabel = savedEstimate === null && historicalEstimate !== null ? 'Historical demand estimate' : 'Estimated demand';
      const reference = measured ?? (Number.isFinite(block.forecast_average_kwh) ? block.forecast_average_kwh : null);
      const offsets = block.range_kwh;
      const bounds = reference !== null && Array.isArray(offsets) && offsets.length === 2 &&
        offsets.every(Number.isFinite) && offsets[0] <= offsets[1]
        ? offsets.map(offset => Math.max(0, reference + offset)) : null;
      return [block.day + block.period, { ...block, measured, estimate, estimateLabel, reference, bounds }];
    }));
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: data.timezone, day: 'numeric', month: 'short' });
    const clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const formatInterval = intervalTitle(data.timezone);
    const width = Math.max(1000, svg.clientWidth);
    const left = 100, right = width - 12, columnGap = 12;
    const columnWidth = (right - left - (days.length - 1) * columnGap) / days.length;
    const rowHeight = 76, panelHeight = rowHeight * periods.length;
    const top = 44, bottom = top + panelHeight;
    const height = bottom + 108;
    const rangeColor = '#a4b0aa', measuredColor = '#6942a0', forecastColor = '#255d52';
    const colorForError = error => error < 0 ? '#216987' : error > 0 ? '#9a4a24' : forecastColor;
    const format = (number, signed = false, decimals = 2) =>
      (signed && number > 0 ? '+' : '') + number.toFixed(decimals).replace('-', '−') + ' kWh';
    const extents = [...blocks.values()].flatMap(({ reference, measured, estimate, bounds }) =>
      [reference, measured !== null ? estimate : null, ...(bounds ?? [])]).filter(Number.isFinite);
    const minimum = Math.min(0, ...extents), maximum = Math.max(5, ...extents);
    const step = Math.max(1, Math.ceil((maximum - minimum) / 8));
    const low = Math.floor(minimum / step) * step, high = Math.ceil(maximum / step) * step;
    const fraction = value => (value - low) / (high - low);
    const ticks = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, i) => low + i * step);
    const fontSize = figureLayout.label, limitGap = 8;
    // Includes enough room for the sign and unit in the SVG chart's font.
    const textWidth = text => text.length * 7;
    const requiredGutter = (distance, room) => distance < 0.5
      ? (room - distance * columnWidth) / (1 - 2 * distance) : 0;
    const centerGutter = (value, text) => requiredGutter(Math.min(fraction(value), 1 - fraction(value)), textWidth(text) / 2 + 2);
    const gutters = [...blocks.values()].flatMap(({ bounds, reference, measured, estimate }) => {
      return [
        ...(bounds ? [
          requiredGutter(fraction(bounds[0]), textWidth(format(bounds[0])) + limitGap),
          requiredGutter(1 - fraction(bounds[1]), textWidth(format(bounds[1])) + limitGap),
        ] : []),
        ...(reference !== null ? [centerGutter(reference, format(reference))] : []),
        ...(measured !== null && estimate !== null ? [centerGutter(estimate, format(estimate))] : []),
      ];
    });
    const gutter = Math.ceil(Math.max(16, ...gutters));
    const hoverBlocks = [];
    const { element, line, label } = chartElements(svg, height, width);
    const arrow = (x, tip, color) => {
      line(x, tip - 11, x, tip - 4, color, 1.3);
      element('polygon', { points: `${x},${tip} ${x - 4},${tip - 6} ${x + 4},${tip - 6}`, fill: color });
    };
    const marker = (x, y, opacity = 1) => element('circle', {
      cx: x, cy: y, r: 5.5, fill: '#fff', stroke: measuredColor, 'stroke-width': 2.1, opacity,
    });

    svg.setAttribute('aria-label', 'Six-hour home demand in ' + data.timezone + '. Ranges, measured demand and estimates use a shared kilowatt-hour scale.');
    label(figureLayout.left, 26, 'Six-hour home demand forecast errors', 'start', figureLayout.title, 650);

    for (const [index, day] of days.entries()) {
      const columnLeft = left + index * (columnWidth + columnGap);
      const columnRight = columnLeft + columnWidth;
      const x = value => columnLeft + gutter + fraction(value) * (columnWidth - 2 * gutter);
      const firstBlock = blocks.get(day + '02:00');
      const heading = Number.isFinite(firstBlock?.start) ? date.format(firstBlock.start * 1000) : '';
      if (heading) label(columnLeft + columnWidth / 2, bottom + 38, heading, 'middle', figureLayout.label, 650);
      element('rect', { x: columnLeft, y: top, width: columnWidth, height: panelHeight, fill: '#fff', stroke: plotColors.grid });
      for (const tick of ticks) {
        line(x(tick), top, x(tick), bottom, plotColors.grid, 0.7);
      }
      const usedTicks = [];
      for (const tick of new Set([low, high, ...ticks])) {
        const text = format(tick, false, 0);
        const center = x(tick), half = textWidth(text) / 2;
        if (center - half < columnLeft || center + half > columnRight ||
          usedTicks.some(([other, radius]) => Math.abs(center - other) < half + radius + 4)) continue;
        label(center, bottom + 16, text, 'middle', fontSize, 400, { fill: '#52615b' });
        usedTicks.push([center, half]);
      }

      for (const [row, period] of periods.entries()) {
        const block = blocks.get(day + period.slice(0, 5));
        const rowTop = top + row * rowHeight;
        const y = rowTop + rowHeight / 2;
        if (index === 0) {
          const reference = block ?? days.map(day => blocks.get(day + period.slice(0, 5))).find(Boolean);
          const times = reference && Number.isFinite(reference.start) && Number.isFinite(reference.end)
            ? clock.format(reference.start * 1000) + '–' + clock.format(reference.end * 1000) : '';
          if (times) label(left - 7, y + 4, times, 'end', fontSize, 600);
        }
        if (row > 0) line(columnLeft, rowTop, columnRight, rowTop, plotColors.grid, 0.7);
        if (!block) continue;
        const { measured, estimate, estimateLabel, reference, bounds } = block;
        const hasMeasured = measured !== null;
        const hasError = hasMeasured && Number.isFinite(block.error_kwh);
        const rows = [];
        let markerY = y;
        if (bounds) {
          const [lower, upper] = bounds;
          const lowLabel = format(lower), highLabel = format(upper);
          rows.push({ label: '90% range', value: lowLabel + ' to ' + highLabel, color: rangeColor });
          const start = x(lower), end = x(upper);
          element('rect', { x: start, y: y - 8, width: Math.max(1, end - start), height: 16, rx: 3,
            fill: rangeColor, 'fill-opacity': hasMeasured ? 1 : 0.30 });
          const limitsStyle = { 'dominant-baseline': 'central', opacity: hasMeasured ? 1 : 0.66 };
          label(start - limitGap, y, lowLabel, 'end', fontSize, 400, limitsStyle);
          label(end + limitGap, y, highLabel, 'start', fontSize, 400, limitsStyle);
          const referenceX = x(reference);
          const hitsLabel = (from, to) => referenceX + 7 > from && referenceX - 7 < to;
          if (hitsLabel(start - limitGap - textWidth(lowLabel), start - limitGap) ||
            hitsLabel(end + limitGap, end + limitGap + textWidth(highLabel))) markerY += 14;
        }
        if (reference !== null) {
          const text = format(reference);
          rows.push({ label: hasMeasured ? 'Measured demand' : 'Estimated demand', value: text, color: measuredColor });
          marker(x(reference), markerY, hasMeasured ? 1 : 0.32);
          label(x(reference), markerY + 22, text, 'middle', figureLayout.value, 650, { fill: measuredColor, opacity: hasMeasured ? 1 : 0.55 });
        }
        if (hasMeasured && estimate !== null) {
          const forecast = format(estimate);
          const color = hasError ? colorForError(block.error_kwh) : forecastColor;
          rows.push({ label: estimateLabel, value: forecast, color });
          const position = x(estimate);
          arrow(position, y - 8, color);
          label(position, y - 22, forecast, 'middle', figureLayout.value, 650, { fill: color });
        } else if (reference === null || hasMeasured) {
          rows.push({ label: 'Estimated demand', value: 'Unavailable' });
        }
        if (hasError) {
          rows.push({ label: 'Forecast error', value: format(block.error_kwh, true), color: colorForError(block.error_kwh) });
        }
        if (rows.length) {
          hoverBlocks.push({
            left: columnLeft, right: columnRight, top: rowTop, bottom: rowTop + rowHeight,
            title: Number.isFinite(block.start) && Number.isFinite(block.end)
              ? formatInterval(block.start, block.end) : heading,
            rows,
          });
        }
      }
    }

    label(width / 2, bottom + 61, 'Demand (kWh)', 'middle', figureLayout.label);
    const legendItems = [
      ['90% range', (x, y) => element('rect', { x: x - 8, y: y - 3, width: 16, height: 6, rx: 2, fill: rangeColor })],
      ['Demand', marker],
      ['Estimated', (x, y) => arrow(x, y + 5, forecastColor)],
    ];
    let legendLeft = left;
    const legendY = bottom + 85;
    for (const [name, symbol] of legendItems) {
      symbol(legendLeft + 8, legendY);
      label(legendLeft + 21, legendY + 4, name, 'start', 12);
      legendLeft += 21 + textWidth(name) + 13;
    }
    window.SolarLoggerChartHover.attach(svg, (pointerX, pointerY) => {
      const block = hoverBlocks.find(block => pointerX >= block.left && pointerX <= block.right
        && pointerY >= block.top && pointerY < block.bottom);
      return block ? { title: block.title, rows: block.rows } : null;
    });
    return true;
  }

  return { draw, drawErrors, dailyTotals };
})();
