'use strict';

const SolarGeneration = (() => {
  const daySeconds = 86400;

  function draw(svg, data) {
    const demand = data.kind === 'demand';
    let warning = data.model_warning || '';
    const measured = data.measured.filter(point => Array.isArray(point)
      && Number.isFinite(point[0]) && Number.isFinite(point[1]));
    const series = [
      { values: measured, color: '#238783', label: demand ? 'Measured' : 'Measured inverter', fill: true },
      { values: data.past, color: '#BA4A18', label: demand ? 'Estimated' : 'AI past estimate' },
      { values: data.forecast, color: '#000000', label: demand ? 'Forecast' : 'AI forecast (ensemble median)' },
    ].filter(line => line.values.length);

    svg.replaceChildren();
    if (!series.length) {
      warning = [warning, 'No measured inverter data is available.'].filter(Boolean).join(' ');
      return { hasData: false, warning };
    }
    const cutoff = demand && Number.isFinite(data.latest_reading) ? data.latest_reading : data.download;
    const download = Number.isFinite(cutoff) ? cutoff : null;
    const width = 1200, height = 500;
    const left = 108, right = 1176, top = 60, bottom = 365;
    const timezone = { timeZone: data.timezone };
    const calendar = new Intl.DateTimeFormat('en-GB', { ...timezone, day: 'numeric', month: 'short' });
    const clock = new Intl.DateTimeFormat('en-GB', { ...timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const all = series.flatMap(line => line.values);
    const times = all.map(point => point[0]);
    if (download !== null) times.push(download);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const midnights = [], ticks = [];
    for (let time = Math.floor((min - daySeconds) / 900) * 900; time <= max + daySeconds; time += 900) {
      const label = clock.format(time * 1000);
      if (label === '00:00') midnights.push(time);
      if (['00:00', '06:00', '12:00', '18:00'].includes(label)) ticks.push([time, label]);
    }
    const start = demand ? data.start : midnights.filter(time => time <= min).pop() ?? min;
    const end = demand ? data.end : midnights.find(time => time >= max && time > start && time > download) ?? Math.max(max, start + 900);
    const ceiling = Math.max(0.05, ...all.map(point => point[1])) * 1.29;
    const spacing = ceiling / 9;
    const magnitude = 10 ** Math.floor(Math.log10(spacing));
    const step = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= spacing) * magnitude;
    const decimals = Math.max(2, Number(step.toPrecision(8)).toString().split('.')[1]?.length ?? 0);
    const x = time => left + (time - start) / (end - start) * (right - left);
    const y = power => bottom - power / ceiling * (bottom - top);

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('font-family', 'DejaVu Sans, Verdana, sans-serif');
    function element(tag, attributes, label) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      if (label !== undefined) node.textContent = label;
      svg.append(node);
    }
    function line(x1, y1, x2, y2, stroke, size = 1, dash = '') {
      element('line', { x1, y1, x2, y2, stroke, 'stroke-width': size, 'stroke-dasharray': dash });
    }
    function label(x, y, text, anchor = 'start', size = 13, weight = 400, extra = {}) {
      element('text', { x, y, 'text-anchor': anchor, 'font-size': size, 'font-weight': weight, fill: '#000', ...extra }, text);
    }
    element('rect', { width, height, fill: '#fff' });
    label(left, 42, demand ? 'Home demand forecast' : 'Solar generation forecast', 'start', 24, 700);
    const axisMiddle = (top + bottom) / 2;
    label(61, axisMiddle, demand ? 'Hourly home demand (kWh)' : 'Hourly mean DC power (kW)', 'middle', 14, 400, {
      transform: 'rotate(-90 61 ' + axisMiddle + ')',
    });
    const dayKey = new Intl.DateTimeFormat('en-CA', { ...timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const today = dayKey.format(demand ? download * 1000 : new Date());
    const days = midnights.slice(0, -1).flatMap((time, i) => {
      const until = midnights[i + 1];
      return until > start && time < end ? [{ time, until, key: dayKey.format(time * 1000) }] : [];
    });
    for (const { time, until, key } of days) {
      if (key !== today) element('rect', {
        x: x(Math.max(time, start)), y: top, width: x(Math.min(until, end)) - x(Math.max(time, start)), height: bottom - top, fill: '#EEF2F5',
      });
    }
    for (let power = 0; power <= ceiling + 1e-9; power += step) {
      line(left, y(power), right, y(power), '#DDE3E7', 0.8);
      label(left - 10, y(power) + 4, power.toFixed(decimals), 'end');
    }
    for (const [time, tick] of ticks) {
      if (time >= start && time < end) label(x(time), bottom + 19, tick, 'middle', 13);
    }
    for (let i = 0; i < midnights.length - 1; i++) {
      const time = midnights[i];
      if (midnights[i + 1] <= start || time >= end) continue;
      if (time > start) line(x(time), top, x(time), bottom, '#BCC7CE');
      const [day, month] = calendar.format(time * 1000).split(' ');
      const number = Number(day);
      const suffix = number % 100 >= 11 && number % 100 <= 13
        ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th');
      label(x((Math.max(time, start) + Math.min(midnights[i + 1], end)) / 2), bottom + 52, day + suffix + ' ' + month, 'middle', 14, 700);
    }
    line(left, top, left, bottom, '#BBC4CB');
    line(left, bottom, right, bottom, '#BBC4CB');
    for (const { values, color, fill } of series) {
      let segment = [];
      for (const [time, power] of values) {
        const point = [demand && color === '#000000' ? Math.max(time, download) : time, power];
        if (segment.length && point[0] - segment[segment.length - 1][0] > 3600) {
          drawSegment(segment, color, fill);
          segment = [];
        }
        segment.push(point);
      }
      drawSegment(segment, color, fill);
    }
    function drawSegment(points, color, fill) {
      const xy = points.map(([time, power]) => [x(time), y(power)]);
      if (demand) {
        let path = 'M' + xy[0].join(',');
        for (let i = 1; i < xy.length; i++) path += ' H' + xy[i][0] + ' V' + xy[i][1];
        path += ' H' + x(Math.min(end, points[points.length - 1][0] + 3600));
        if (fill) element('path', { d: path + ' V' + bottom + ' H' + xy[0][0] + ' Z', fill: color, opacity: 0.22 });
        element('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2.4 });
        return;
      }
      if (xy.length === 1) {
        element('circle', { cx: xy[0][0], cy: xy[0][1], r: 2.5, fill: color });
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
      if (fill) element('path', { d: path + ' V' + bottom + ' H' + xy[0][0] + ' Z', fill: color, opacity: 0.22 });
      element('path', { d: path, fill: 'none', stroke: color, 'stroke-width': color === '#000000' ? 2.8 : 2.4, 'stroke-linejoin': 'round' });
    }
    if (download !== null) {
      const divider = x(download);
      line(divider, top, divider, bottom, '#34465a', 2.5, '2 5');
      const [day, month] = calendar.format(download * 1000).split(' ');
      const color = { fill: '#34465A' };
      const labelX = divider - 11;
      element('rect', { x: labelX - 48, y: top + 63, width: 53, height: 34, fill: '#fff', opacity: 0.95 });
      label(labelX, top + 78, day.padStart(2, '0') + month.toLowerCase(), 'end', 13, 700, color);
      label(labelX, top + 93, clock.format(download * 1000), 'end', 13, 700, color);
    }
    const actualHours = new Map(measured);
    const estimateHours = new Map(data.past);
    const sum = (points, time, until, match) => {
      const values = points.filter(([hour]) => (demand ? hour >= time && hour < until : hour > time && hour <= until) && (!match || match.has(hour)));
      return values.length ? values.reduce((total, [, power]) => total + power, 0) : null;
    };
    for (const { time, until, key } of days) {
      const estimated = (key === today ? [...data.past, ...data.forecast] : data.past);
      const metrics = key > today
        ? [['Forecast', sum(data.forecast, time, until), '#26384D']]
        : [
          ['Estimated', sum(estimated, time, until, key === today ? null : actualHours), '#A3431B'],
          [key === today ? 'Measured so far' : 'Measured',
            sum(measured, time, until, key === today ? null : estimateHours), '#16736E'],
        ];
      const center = x((Math.max(time, start) + Math.min(until, end)) / 2);
      const cardWidth = Math.min(202, x(Math.min(until, end)) - x(Math.max(time, start)) - 10);
      if (cardWidth <= 0 || (demand && key !== today && (time < start || until > end))) continue;
      const scale = Math.min(1, cardWidth / 202);
      const cardX = center - cardWidth / 2;
      element('rect', { x: cardX, y: top + 5, width: cardWidth,
        height: (12 + metrics.length * 20) * scale, rx: 7 * scale,
        fill: '#fff', stroke: '#CBD8E2', 'stroke-width': 1 });
      metrics.forEach(([name, amount, color], i) => {
        const rowY = top + 5 + (20 + i * 20) * scale;
        label(cardX + 10 * scale, rowY, name, 'start', 12 * scale, 400, { fill: color });
        label(cardX + cardWidth - 10 * scale, rowY,
          amount === null ? '—' : amount.toFixed(2) + ' kWh', 'end', 15 * scale, 700, { fill: color });
      });
    }
    label((left + right) / 2, bottom + 72, data.timezone === 'Europe/London'
      ? 'UK local time' : data.timezone + ' local time', 'middle', 14);
    const widths = { 'Measured inverter': 178, 'AI past estimate': 167, 'AI forecast (ensemble median)': 238, Measured: 132, Estimated: 135, Forecast: 120 };
    const total = series.reduce((sum, item) => sum + widths[item.label], 0) - 20;
    let position = (width - total) / 2;
    for (const { color, label: title } of series) {
      line(position, 469, position + 27, 469, color, color === '#000000' ? 2.8 : 2.4);
      label(position + 36, 473, title, 'start', 13);
      position += widths[title];
    }
    return { hasData: true, warning };
  }

  return { draw };
})();
