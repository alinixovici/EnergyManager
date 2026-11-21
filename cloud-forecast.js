'use strict';

function liveForecastChart(panel, chart, onDraw = () => {}) {
  const clear = () => { chart.replaceChildren(); chart.setAttribute('hidden', ''); };
  return {
    draw(data) {
      const result = SolarGeneration.draw(chart, data);
      chart.toggleAttribute('hidden', !result.hasData);
      onDraw(data);
      return result;
    },
    clear, reset: clear,
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
      const data = await window.energyCloud.readForecast();
      if (request !== generation) return;
      if (!data || data.unavailable) {
        plot.clear();
        showStatus(data?.message ?? 'No display values have been published. Install the updated NAS app and run display-read.sql in Supabase.');
        return;
      }
      const result = plot.draw(data);
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
      const data = await window.energyCloud.readDemandForecast();
      if (id !== request) return;
      if (!data || data.unavailable) {
        plot.clear();
        throw new Error(data?.message ?? 'No home demand display values have been published by the NAS.');
      }
      const result = plot.draw(data);
      status.textContent = result.warning;
      errorStatus.textContent = data.diagnostics_warning ?? '';
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
    subscriptions = ['home_demand_estimate']
      .map(table => window.energyCloud.watchForecast(table, scheduleDemand));
    scheduleDemand();
  });
})();
