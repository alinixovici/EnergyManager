(() => {
  const form = document.getElementById('cloud-setup');
  const dashboard = document.getElementById('solar-dashboard');
  const prefix = 'energy-manager-';
  const systemFields = ['PPV', 'Load', 'PBat', 'PAC', 'SOC%'];
  const meterFields = ['PV Gen Today', 'Consumption Today', 'Batt Discharge Today',
    'Batt Charge Today', 'Combined Gen Today', 'Combined Gen Total',
    'Import Total', 'Export Total', 'Import Today', 'Export Today'];
  const column = name => name.toLowerCase().replaceAll(' ', '_').replaceAll('%', 'percent');
  const stamp = row => new Date(row.time).toISOString().replace(/\.\d+Z$/, 'Z');
  const number = (row, name) => {
    const value = row[column(name)];
    return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  const record = row => row && { stamp: stamp(row), number: name => number(row, name) };
  function systemFile(rows, month) {
    const lines = rows.map(row => [stamp(row), ...systemFields.map(name => number(row, name))].join(','));
    return new File([['Time', ...systemFields].join(',') + '\n', lines.join('\n') + '\n'],
      'FD2324F695 System Data ' + month + '.csv');
  }
  let client;
  const table = () => client.from('energy_readings');
  async function query(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }
  async function range(from, to) {
    const rows = [];
    let cursor = from;
    let inclusive = true;
    for (;;) {
      const request = table().select('*').lt('time', to).order('time').limit(1000);
      const page = await query(inclusive ? request.gte('time', cursor) : request.gt('time', cursor));
      if (!page.length) return rows;
      rows.push(...page);
      cursor = page.at(-1).time;
      inclusive = false;
    }
  }
  const controlColumns = 'time,end_time,soc,estimated_soc,no_charge_soc,end_soc,end_no_charge_soc,'
    + 'demand_kwh,estimated_demand_kwh,solar_kwh,estimated_solar_kwh,grid_kwh';
  const controlPlan = source => query(source.from('control_graph').select('time,metadata').eq('series', 'plan').maybeSingle());
  async function controlPoints(source, series, start, end) {
    const rows = [];
    let cursor;
    for (;;) {
      const request = source.from('control_graph').select(controlColumns).eq('series', series)
        .lt('time', end).order('time').limit(1000);
      const page = await query(cursor ? request.gt('time', cursor) : request.gte('time', start));
      if (!page.length) return rows;
      for (const { time, end_time, ...values } of page) {
        rows.push({ ...values, time: Date.parse(time) / 1000, end: end_time ? Date.parse(end_time) / 1000 : null });
      }
      cursor = page.at(-1).time;
    }
  }
  window.energyCloud = {
    start(refresh) {
      function connect() {
        try {
          const { url, key } = form.elements;
          if (!url.value || !key.value) { form.hidden = false; return; }
          const endpoint = new URL(url.value);
          if (endpoint.protocol !== 'https:') throw new Error('Enter an HTTPS project URL.');
          const token = key.value.trim();
          if (!token.startsWith('sb_publishable_')) {
            const payload = JSON.parse(atob((token.split('.')[1] || '').replaceAll('-', '+').replaceAll('_', '/')));
            if (payload.role !== 'anon') throw new Error();
          }
          client = window.supabase.createClient(endpoint.href, token, { auth: { persistSession: false } });
          localStorage.setItem(prefix + 'url', endpoint.href);
          localStorage.setItem(prefix + 'key', token);
          form.hidden = true;
          dashboard.hidden = false;
          window.dispatchEvent(new Event("energy-cloud-connected"));
          refresh();
        } catch {
          document.getElementById('cloud-error').textContent = 'Enter your HTTPS project URL and publishable or legacy anon key.';
          form.hidden = false;
        }
      }
      form.elements.url.value = 'https://wkxhejzyudeqevnluxeo.supabase.co';
      form.elements.key.value = 'sb_publishable_pK2i-3IoxD6chk1kurQ-Xg_z8afauB7';
      form.onsubmit = event => { event.preventDefault(); connect(); };
      document.getElementById('solar-back').onclick = () => { form.hidden = false; };
      connect();
    },
    watchControl(refresh) {
      const source = client;
      const changes = { schema: 'public', table: 'control_graph', filter: 'series=eq.plan' };
      const channel = source.channel('control-graph-plan')
        .on('postgres_changes', { ...changes, event: 'INSERT' }, refresh)
        .on('postgres_changes', { ...changes, event: 'UPDATE' }, refresh)
        .subscribe(state => { if (state === 'SUBSCRIBED') refresh(); });
      return () => source.removeChannel(channel);
    },
    async readControl() {
      if (!client) throw new Error('Connect to Supabase first.');
      const source = client;
      for (let attempt = 0; attempt < 2; attempt++) {
        const plan = await controlPlan(source);
        if (client !== source) throw new Error('The Supabase connection changed.');
        if (!plan) return null;
        const metadata = plan.metadata;
        if (!Number.isFinite(metadata?.as_of) || !Number.isFinite(metadata.start)
          || !Number.isFinite(metadata.end) || metadata.end <= metadata.start) {
          throw new Error('The published Control plan has no valid time window.');
        }
        const start = new Date(metadata.start * 1000).toISOString();
        const end = new Date(metadata.end * 1000).toISOString();
        const [history_soc, history, forecast] = await Promise.all(['history_soc', 'history', 'forecast']
          .map(series => controlPoints(source, series, start, end)));
        const latest = await controlPlan(source);
        if (client !== source) throw new Error('The Supabase connection changed.');
        if (latest?.time === plan.time && latest.metadata?.as_of === metadata.as_of) {
          return { ...metadata, history_soc, history, forecast };
        }
      }
      throw new Error('The NAS is updating the Control plan. Try refreshing again.');
    },
    watchForecast(table, refresh) {
      const source = client;
      const channel = source.channel('forecast:' + table)
        .on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
        .subscribe(state => { if (state === 'SUBSCRIBED') refresh(); });
      return () => source.removeChannel(channel);
    },
    async readDemandForecast() {
      if (!client) throw new Error('Connect to Supabase first.');
      return query(client.from('home_demand_estimate').select('*').order('time'));
    },
    async readForecast() {
      if (!client) throw new Error('Connect to Supabase first.');
      return query(client.from('solar_generation_estimate')
        .select('time,measured_kw,ai_past_estimate_kw,ai_forecast_kw,forecast_download_utc,timezone,model_name')
        .order('time'));
    },
    async read(selectedDate) {
      if (!client) return;
      const [latest] = await query(table().select('*').order('time', { ascending: false }).limit(1));
      const date = [selectedDate || '9999', latest ? stamp(latest).slice(0, 10) : new Date().toISOString().slice(0, 10)].sort()[0];
      if (!latest) return { date };
      const day = new Date(date + 'T00:00:00Z');
      const end = new Date(latest.time).getTime();
      const [history, recent] = await Promise.all([
        range(day.toISOString(), new Date(+day + 86400000).toISOString()),
        range(new Date(end - 246 * 60000).toISOString(), new Date(end + 1).toISOString()),
      ]);
      const month = stamp(latest).slice(0, 7);
      const previous = recent.filter(row => stamp(row).slice(0, 7) !== month);
      return {
        date, system: record(latest), meter: record(latest),
        reserve: number(latest, 'battery_soc_reserve') ?? 4,
        selectedFile: history.length ? systemFile(history, date.slice(0, 7)) : undefined,
        latestFile: systemFile(recent.filter(row => stamp(row).startsWith(month)), month),
        previousFile: previous.length ? systemFile(previous, stamp(previous[0]).slice(0, 7)) : undefined,
      };
    },
  };
})();
