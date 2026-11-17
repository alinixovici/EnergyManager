'use strict';

function forecastChartTimestamp(value) {
  const time = Date.parse(value) / 1000;
  return Number.isFinite(time) ? time : null;
}

function forecastChartNumber(value) {
  const number = value == null || value === '' ? NaN : Number(value);
  return Number.isFinite(number) ? number : null;
}

function publishedChartWindow(row) {
  const start = forecastChartTimestamp(row.chart_start);
  const end = forecastChartTimestamp(row.chart_end);
  return start !== null && end !== null && start < end
    ? { start, end, as_of: forecastChartTimestamp(row.chart_as_of) }
    : null;
}

function forecastChartSeries(rows, column) {
  return rows.flatMap(row => {
    const time = forecastChartTimestamp(row.time), value = forecastChartNumber(row[column]);
    return time === null || value === null ? [] : [[time, value]];
  });
}

function publishedForecastData(rows, kind) {
  if (!rows.length) return null;
  const demand = kind === 'demand';
  const metadata = demand ? rows[0] : rows.find(row => row.forecast_download_utc) ?? rows[0];
  const cutoff = forecastChartTimestamp(metadata.latest_reading);
  const download = forecastChartTimestamp(metadata.forecast_download_utc);
  const bounds = publishedChartWindow(metadata);
  const minutes = Number(metadata.interval_minutes);
  const interval = demand && Number.isInteger(minutes) && minutes > 0 && minutes <= 60 ? minutes : 60;
  const inputsThrough = forecastChartTimestamp(metadata.inputs_through);
  const unit = demand ? 'kwh' : 'kw';
  const forecast = forecastChartSeries(rows, 'ai_forecast_' + unit);
  const first = forecastChartTimestamp(rows[0].time);
  const last = forecastChartTimestamp(rows.at(-1).time);
  const data = {
    ...(bounds ?? {
      start: first === null ? null : first - (demand ? 0 : 3600),
      end: last === null ? null : last + (demand ? interval * 60 : 0),
    }),
    kind, timezone: metadata.timezone || 'Europe/London',
    download, latest_reading: cutoff, interval_minutes: interval,
    forecast_issued_at: demand
      ? inputsThrough ?? (forecast.length && cutoff !== null ? Math.floor(cutoff / (interval * 60)) * interval * 60 : null)
      : download,
    inputs_through: inputsThrough,
    last_run_at: forecastChartTimestamp(metadata.last_run_at),
    model_name: metadata.model_name,
    model_label: metadata.model_label,
    measured: forecastChartSeries(rows, 'measured_' + unit),
    past: forecastChartSeries(rows, 'ai_past_estimate_' + unit),
    forecast,
  };
  if (demand && bounds && Object.hasOwn(metadata, 'measured_today_kwh')) {
    data.measured_today_kwh = forecastChartNumber(metadata.measured_today_kwh);
  }
  return data;
}

function publishedDemandRangeBlocks(rows, demand) {
  const interval = demand.interval_minutes * 60;
  const historical = new Map(demand.past);
  const estimates = new Map([...historical, ...demand.forecast]);
  function blockEstimate(points, start, end) {
    let estimate = 0;
    for (let from = start; from < end;) {
      const bin = Math.floor(from / interval) * interval;
      const value = points.get(bin);
      if (!Number.isFinite(value)) return null;
      const until = Math.min(end, bin + interval);
      estimate += value * (until - from) / interval;
      from = until;
    }
    return estimate;
  }
  const blocks = rows.flatMap(row => {
    const start = forecastChartTimestamp(row.time), end = forecastChartTimestamp(row.block_end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const measured = forecastChartNumber(row.measured_kwh), error = forecastChartNumber(row.error_kwh);
    return [{
      day: row.day, period: row.period, start, end, measured_kwh: measured, error_kwh: error,
      range_kwh: [forecastChartNumber(row.range_low_kwh), forecastChartNumber(row.range_high_kwh)],
      forecast_kwh: measured !== null && error !== null ? measured + error : null,
      historical_estimate_kwh: measured !== null && error === null ? blockEstimate(historical, start, end) : null,
      forecast_average_kwh: blockEstimate(estimates, start, end),
    }];
  });
  if (!blocks.some(block => block.day === 'next2')) {
    const britishOffset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'longOffset' });
    const offset = time => {
      const name = britishOffset.formatToParts(time * 1000).find(part => part.type === 'timeZoneName')?.value;
      const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? '');
      return match ? (match[1] === '+' ? 1 : -1) * (+match[2] * 3600 + +match[3] * 60) : 0;
    };
    const tomorrow = time => time + 86400 + offset(time) - offset(time + 86400);
    for (const block of blocks.filter(entry => entry.day === 'next')) {
      const start = tomorrow(block.start), end = tomorrow(block.end);
      blocks.push({ ...block, day: 'next2', start, end, measured_kwh: null, error_kwh: null, forecast_kwh: null,
        historical_estimate_kwh: null, forecast_average_kwh: blockEstimate(estimates, start, end) });
    }
  }
  return blocks;
}

function liveForecastChart(panel, chart, onDraw = () => {}) {
  const live = SolarGeneration.liveView(start => window.energyCloud.readMeasured(start),
    () => !panel.hidden && !document.hidden, data => {
    const result = SolarGeneration.draw(chart, data);
    chart.toggleAttribute('hidden', !result.hasData);
    onDraw(data);
    return result;
  });
  const clear = () => { live.reset(); chart.setAttribute('hidden', ''); };
  return {
    draw: live.show,
    clear,
    reset: clear,
  };
}

(() => {
  const tabs = [...document.querySelectorAll('.forecast-tabs button')];
  const panel = document.getElementById('solar-forecasts');
  const refresh = document.getElementById('forecast-refresh');
  const status = document.getElementById('forecast-status');
  const chart = document.getElementById('solar-generation-chart');
  const plot = liveForecastChart(panel, chart);
  let generation = 0;
  let solarTimer;
  let stopSolar;

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  async function loadForecast() {
    if (panel.hidden || document.hidden) return;
    const request = ++generation;
    refresh.disabled = true;
    if (chart.hidden) showStatus('Loading solar forecast…');
    try {
      const rows = await window.energyCloud.readForecast();
      if (request !== generation) return;
      if (!rows.length) {
        plot.clear();
        showStatus('No forecast has been published. Use Read Forecast on the NAS.');
        return;
      }
      const result = plot.draw(publishedForecastData(rows, 'solar'));
      showStatus(result.warning);
    } catch (error) {
      if (request === generation) showStatus(error.code === '42501'
        ? 'This dashboard cannot read the published solar forecast.'
        : error.message || 'Could not load the solar forecast.');
    } finally {
      if (request === generation) refresh.disabled = false;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const button of tabs) {
        const active = button === tab;
        button.setAttribute('aria-pressed', String(active));
        document.getElementById(button.getAttribute('aria-controls')).hidden = !active;
      }
      refreshForecastCharts();
    });
  }
  function refreshForecastCharts() {
    if (!panel.hidden && !document.hidden) window.dispatchEvent(new Event('energy-cloud-forecast-refresh'));
  }
  refresh.addEventListener('click', refreshForecastCharts);
  document.addEventListener('visibilitychange', refreshForecastCharts);
  window.addEventListener('energy-cloud-forecast-refresh', loadForecast);
  setInterval(refreshForecastCharts, 60_000);

  window.addEventListener('energy-cloud-connected', () => {
    stopSolar?.();
    stopSolar = window.energyCloud.watchForecast('solar_generation_estimate', () => {
      clearTimeout(solarTimer);
      solarTimer = setTimeout(() => { if (!panel.hidden && !document.hidden) loadForecast(); }, 250);
    });
    generation++;
    refresh.disabled = false;
    plot.reset();
    showStatus('');
    if (!panel.hidden) loadForecast();
  });
})();

(() => {
  const panel = document.getElementById('solar-forecasts');
  const chart = document.getElementById('home-demand-chart');
  const status = document.getElementById('demand-forecast-status');
  const errorChart = document.getElementById('demand-error-chart');
  const errorScroll = document.getElementById('demand-error-chart-scroll');
  const errorStatus = document.getElementById('demand-error-status');
  const plot = liveForecastChart(panel, chart, data => {
    errorData = data.demand_range_blocks ? { timezone: 'Europe/London', demand_range_blocks: data.demand_range_blocks } : null;
    drawErrors();
  });
  let request = 0;
  let loading = false;
  let pending = false;
  let refreshTimer;
  let subscriptions = [];
  let errorData;
  let errorWidth;

  function drawErrors() {
    errorWidth = errorChart.clientWidth;
    errorScroll.hidden = !errorData || !SolarGeneration.drawErrors(errorChart, errorData);
  }

  new ResizeObserver(() => {
    if (errorData && errorChart.clientWidth && errorChart.clientWidth !== errorWidth) drawErrors();
  }).observe(errorChart);

  async function loadDemand() {
    if (panel.hidden || document.hidden) return;
    if (loading) { pending = true; return; }
    loading = true;
    const id = ++request;
    try {
      const [demand, diagnostics] = await Promise.allSettled([
        window.energyCloud.readDemandForecast(), window.energyCloud.readDemandErrors(),
      ]);
      if (id !== request) return;
      if (demand.status === 'rejected') throw demand.reason;
      const data = publishedForecastData(demand.value, 'demand');
      if (!data) {
        plot.clear();
        throw new Error('No home demand forecast has been published.');
      }
      if (diagnostics.status === 'fulfilled') data.demand_range_blocks = publishedDemandRangeBlocks(diagnostics.value, data);
      const result = plot.draw(data);
      status.textContent = result.warning;
      errorStatus.textContent = diagnostics.status === 'rejected'
        ? diagnostics.reason.message || 'Could not load the home demand forecast errors.' : '';
      errorStatus.hidden = !errorStatus.textContent;
    } catch (error) {
      if (id !== request) return;
      status.textContent = error.message;
      errorData = null;
      drawErrors();
      if (!chart.childElementCount) chart.setAttribute('hidden', '');
    } finally {
      loading = false;
      if (pending) { pending = false; scheduleDemand(); }
    }
    status.hidden = !status.textContent;
  }
  window.addEventListener('energy-cloud-forecast-refresh', loadDemand);
  function scheduleDemand() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadDemand, 250);
  }
  window.addEventListener('energy-cloud-connected', () => {
    for (const unsubscribe of subscriptions) unsubscribe();
    request++;
    plot.reset();
    errorData = null;
    drawErrors();
    subscriptions = ['home_demand_estimate', 'demand_error']
      .map(table => window.energyCloud.watchForecast(table, scheduleDemand));
    scheduleDemand();
  });
})();
