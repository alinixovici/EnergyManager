'use strict';

function forecastChartTimestamp(value) {
  const time = Date.parse(value) / 1000;
  return Number.isFinite(time) ? time : null;
}

function forecastChartNumber(value) {
  return value == null || value === '' ? null : Number(value);
}

function publishedChartWindow(row) {
  const start = forecastChartTimestamp(row.chart_start);
  const end = forecastChartTimestamp(row.chart_end);
  return start !== null && end !== null && start < end
    ? { start, end, as_of: forecastChartTimestamp(row.chart_as_of) }
    : null;
}

function forecastChartSeries(rows, column) {
  return rows.flatMap(row => row[column] == null
    ? [] : [[forecastChartTimestamp(row.time), forecastChartNumber(row[column])]]);
}

function liveForecastChart(panel, chart, fallbackCursor = () => null) {
  let data;
  let cursor = null;
  function draw(snapshot) {
    data = snapshot;
    const result = SolarGeneration.draw(chart, data, cursor ?? fallbackCursor(data));
    chart.toggleAttribute('hidden', !result.hasData);
    return result;
  }
  window.addEventListener('energy-cloud-sample', event => {
    const next = forecastChartTimestamp(event.detail);
    if (next === cursor) return;
    cursor = next;
    if (data && !panel.hidden && !document.hidden) draw(data);
  });
  return {
    draw,
    clear() { data = null; chart.setAttribute('hidden', ''); },
    reset() { cursor = null; this.clear(); },
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
      const metadata = rows.find(row => row.forecast_download_utc) ?? rows[0];
      const download = forecastChartTimestamp(metadata.forecast_download_utc);
      // Legacy solar rows are labelled by the end of their hourly interval.
      const first = forecastChartTimestamp(rows[0].time);
      const bounds = publishedChartWindow(metadata) ?? {
        start: first === null ? null : first - 3600,
        end: forecastChartTimestamp(rows.at(-1).time),
      };
      const result = plot.draw({
        ...bounds,
        timezone: metadata.timezone || 'Europe/London',
        download,
        forecast_issued_at: download,
        model_name: metadata.model_name,
        model_label: metadata.model_label,
        measured: forecastChartSeries(rows, 'measured_kw'),
        past: forecastChartSeries(rows, 'ai_past_estimate_kw'),
        forecast: forecastChartSeries(rows, 'ai_forecast_kw'),
      });
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
  const plot = liveForecastChart(panel, chart, data => data.latest_reading);
  let request = 0;
  let loading = false;
  let pending = false;
  let refreshTimer;
  let unsubscribe;
  async function loadDemand() {
    if (panel.hidden || document.hidden) return;
    if (loading) { pending = true; return; }
    loading = true;
    const id = ++request;
    try {
      const rows = await window.energyCloud.readDemandForecast();
      if (id !== request) return;
      if (!rows.length) {
        plot.clear();
        throw new Error('No home demand forecast has been published.');
      }
      const metadata = rows[0];
      const cutoff = forecastChartTimestamp(metadata.latest_reading);
      const bounds = publishedChartWindow(metadata);
      const interval = metadata.interval_minutes ?? 60;
      const intervalSeconds = interval * 60;
      const inputsThrough = forecastChartTimestamp(metadata.inputs_through);
      const forecast = forecastChartSeries(rows, 'ai_forecast_kwh');
      const issue = inputsThrough ?? (forecast.length && cutoff !== null
        ? Math.floor(cutoff / intervalSeconds) * intervalSeconds : null);
      const data = {
        ...(bounds ?? {
          start: cutoff === null ? null : cutoff - 48 * 3600,
          end: cutoff === null ? null : cutoff + 48 * 3600,
        }),
        kind: 'demand', timezone: metadata.timezone || 'Europe/London',
        latest_reading: cutoff, interval_minutes: interval,
        forecast_issued_at: issue,
        inputs_through: inputsThrough,
        last_run_at: forecastChartTimestamp(metadata.last_run_at),
        model_name: metadata.model_name,
        model_label: metadata.model_label,
        measured: forecastChartSeries(rows, 'measured_kwh'),
        past: forecastChartSeries(rows, 'ai_past_estimate_kwh'),
        forecast,
      };
      if (bounds && Object.hasOwn(metadata, 'measured_today_kwh')) {
        data.measured_today_kwh = forecastChartNumber(metadata.measured_today_kwh);
      }
      const result = plot.draw(data);
      status.textContent = result.warning;
    } catch (error) {
      if (id !== request) return;
      status.textContent = error.message;
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
    unsubscribe?.();
    request++;
    plot.reset();
    unsubscribe = window.energyCloud.watchForecast('home_demand_estimate', scheduleDemand);
    scheduleDemand();
  });
})();

(() => {
  const panel = document.getElementById('solar-forecasts');
  const chart = document.getElementById('demand-error-chart');
  const status = document.getElementById('demand-error-status');
  let generation = 0;
  let refreshTimer;
  let unsubscribe;

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  async function loadErrors() {
    if (panel.hidden || document.hidden) return;
    const request = ++generation;
    try {
      const rows = await window.energyCloud.readDemandErrors();
      if (request !== generation) return;
      const blocks = rows.map(row => ({
        day: row.day,
        period: row.period,
        start: forecastChartTimestamp(row.time),
        end: forecastChartTimestamp(row.block_end),
        range_kwh: [forecastChartNumber(row.range_low_kwh), forecastChartNumber(row.range_high_kwh)],
        measured_kwh: forecastChartNumber(row.measured_kwh),
        error_kwh: forecastChartNumber(row.error_kwh),
      }));
      chart.toggleAttribute('hidden', !SolarGeneration.drawErrors(chart, { error_blocks: blocks }));
      showStatus('');
    } catch (error) {
      if (request !== generation) return;
      chart.setAttribute('hidden', '');
      showStatus(error.message || 'Could not load the home demand forecast errors.');
    }
  }

  function scheduleErrors() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadErrors, 250);
  }

  window.addEventListener('energy-cloud-forecast-refresh', loadErrors);
  window.addEventListener('energy-cloud-connected', () => {
    unsubscribe?.();
    generation++;
    chart.setAttribute('hidden', '');
    showStatus('');
    scheduleErrors();
    unsubscribe = window.energyCloud.watchForecast('demand_error', scheduleErrors);
  });
})();
