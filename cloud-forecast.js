'use strict';

(() => {
  const tabs = [...document.querySelectorAll('.forecast-tabs button')];
  const panel = document.getElementById('solar-forecasts');
  const refresh = document.getElementById('forecast-refresh');
  const status = document.getElementById('forecast-status');
  const chart = document.getElementById('solar-generation-chart');
  let generation = 0;

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  async function loadForecast() {
    const request = ++generation;
    refresh.disabled = true;
    showStatus('Loading solar forecast…');
    try {
      const rows = await window.energyCloud.readForecast();
      if (request !== generation) return;
      if (!rows.length) {
        chart.setAttribute('hidden', '');
        showStatus('No forecast has been published. Use Read Forecast on the NAS.');
        return;
      }
      const metadata = rows.find(row => row.forecast_download_utc) ?? rows[0];
      const series = column => rows.flatMap(row => row[column] == null
        ? [] : [[Date.parse(row.time) / 1000, Number(row[column])]]);
      const result = SolarGeneration.draw(chart, {
        timezone: metadata.timezone || 'Europe/London',
        download: metadata.forecast_download_utc ? Date.parse(metadata.forecast_download_utc) / 1000 : null,
        measured: series('measured_kw'),
        past: series('ai_past_estimate_kw'),
        forecast: series('ai_forecast_kw'),
      });
      chart.toggleAttribute('hidden', !result.hasData);
      showStatus(result.warning);
    } catch (error) {
      if (request === generation) showStatus(error.code === '42501'
        ? 'Run forecast-read.sql in Supabase to enable dashboard reads.'
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
      if (!panel.hidden) loadForecast();
    });
  }
  refresh.addEventListener('click', loadForecast);

  window.addEventListener('energy-cloud-connected', () => {
    generation++;
    refresh.disabled = false;
    chart.setAttribute('hidden', '');
    showStatus('');
    if (!panel.hidden) loadForecast();
  });
})();
