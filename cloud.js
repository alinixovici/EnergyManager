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
  let newestSample = -Infinity;
  let stopSampleWatch;
  const table = () => client.from('energy_readings');
  function publishSample(row) {
    const time = Date.parse(row?.time);
    if (!Number.isFinite(time) || time <= newestSample) return;
    newestSample = time;
    window.dispatchEvent(new CustomEvent('energy-cloud-sample', { detail: stamp(row) }));
  }
  async function query(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }
  async function range(from, to, columns = '*', source = client) {
    const rows = [];
    let cursor = from;
    let inclusive = true;
    for (;;) {
      const request = source.from('energy_readings').select(columns).lt('time', to).order('time').limit(1000);
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
  async function recordedGrid(source, start, cutoff) {
    if (!Number.isFinite(cutoff) || cutoff <= start) return [];
    const read = time => new Date(time * 1000).toISOString();
    const readings = await range(read(start - 300), read(cutoff + 1), 'time,ac_charge_total', source);
    const intervals = new Map();
    let previous;
    for (const row of readings) {
      const time = Date.parse(row.time) / 1000;
      const value = number(row, 'AC Charge Total');
      if (!Number.isFinite(time) || value === null || value < 0) continue;
      if (previous) {
        const seconds = time - previous.time;
        const change = value - previous.value;
        if (seconds > 0 && seconds <= 300 && change > 0) {
          for (let from = Math.max(start, previous.time); from < Math.min(time, cutoff);) {
            const block = Math.floor(from / 1800) * 1800;
            const end = Math.min(time, cutoff, block + 1800);
            intervals.set(block, (intervals.get(block) ?? 0) + change * (end - from) / seconds);
            from = end;
          }
        }
      }
      previous = { time, value };
    }
    return [...intervals].map(([block, grid_kwh]) => ({
      time: Math.max(start, block), end: Math.min(cutoff, block + 1800), grid_kwh,
    }));
  }

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
  async function forecastSnapshot(tableName, columns, versionFields = []) {
    if (!client) throw new Error('Connect to Supabase first.');
    const source = client;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = [];
      let cursor;
      let version = [];
      for (;;) {
        let request = source.from(tableName).select(columns).order('time').limit(500);
        if (cursor !== undefined) request = request.gt('time', cursor);
        for (const [key, value] of version) request = request.eq(key, value);
        const page = await query(request);
        if (client !== source) throw new Error('The Supabase connection changed.');
        if (!page.length) break;
        if (!rows.length) version = versionFields.filter(key => page[0][key] != null).map(key => [key, page[0][key]]);
        rows.push(...page);
        cursor = page.at(-1).time;
      }
      if (!version.length) return rows;
      const [latest] = await query(source.from(tableName).select(columns).order('time', { ascending: false }).limit(1));
      if (client !== source) throw new Error('The Supabase connection changed.');
      if (latest && version.every(([key, value]) => latest[key] === value)) return rows;
    }
    throw new Error('The NAS is updating the forecast. Try refreshing again.');
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
          stopSampleWatch?.();
          newestSample = -Infinity;
          window.dispatchEvent(new Event("energy-cloud-connected"));
          const source = client;
          const channel = source.channel('forecast:energy_readings')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'energy_readings' }, change => {
              if (client === source) publishSample(change.new);
            }).subscribe();
          stopSampleWatch = () => source.removeChannel(channel);
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
        const [history_soc, history, forecast, history_grid] = await Promise.all([
          ...['history_soc', 'history', 'forecast'].map(series => controlPoints(source, series, start, end)),
          Array.isArray(metadata.history_grid) ? metadata.history_grid
            : recordedGrid(source, metadata.start, metadata.cutoff).catch(() => []),
        ]);
        const latest = await controlPlan(source);
        if (client !== source) throw new Error('The Supabase connection changed.');
        if (latest?.time === plan.time && latest.metadata?.as_of === metadata.as_of) {
          return { ...metadata, history_soc, history, forecast, history_grid };
        }
      }
      throw new Error('The NAS is updating the Control plan. Try refreshing again.');
    },
    async readControlButtonStatus() {
      if (!client) throw new Error('Connect to Supabase first.');
      const source = client;
      const status = await query(source.from('control_button_status')
        .select('updated_at,automatic,inverter_control,direct_charge,direct_discharge,charge_slots')
        .order('updated_at', { ascending: false }).limit(1).maybeSingle());
      if (client !== source) throw new Error('The Supabase connection changed.');
      return status;
    },
    watchForecast(table, refresh) {
      const source = client;
      const channel = source.channel('forecast:' + table)
        .on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
        .subscribe(state => { if (state === 'SUBSCRIBED') refresh(); });
      return () => source.removeChannel(channel);
    },
    async readDemandForecast() {
      return forecastSnapshot('home_demand_estimate', '*', ['chart_as_of', 'latest_reading']);
    },
    async readForecast() {
      return forecastSnapshot('solar_generation_estimate', '*', ['chart_as_of', 'forecast_download_utc']);
    },
    async readDemandErrors() {
      try {
        return await forecastSnapshot('demand_error',
          'time,block_end,day,period,range_low_kwh,range_high_kwh,measured_kwh,error_kwh');
      } catch (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return [];
        throw error;
      }
    },
    async read(selectedDate) {
      if (!client) return;
      const source = client;
      const [latest] = await query(table().select('*').order('time', { ascending: false }).limit(1));
      if (client !== source) return;
      publishSample(latest);
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
