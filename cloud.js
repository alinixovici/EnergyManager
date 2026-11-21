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
    window.dispatchEvent(new Event('energy-graph-sample'));
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
  async function readDisplay(kind) {
    if (!client) throw new Error('Connect to Supabase first.');
    const source = client;
    let snapshot;
    try {
      snapshot = await query(source.from('dashboard_display').select('updated_at,data').eq('kind', kind).maybeSingle());
    } catch (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') {
        throw new Error('Run display-read.sql in Supabase and install the updated NAS app to receive display values.');
      }
      throw error;
    }
    if (client !== source) throw new Error('The Supabase connection changed.');
    return snapshot?.data ?? null;
  }
  function watchDisplay(kind, refresh) {
    const source = client;
    const channel = source.channel('display:' + kind)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dashboard_display', filter: 'kind=eq.' + kind }, refresh)
      .subscribe(state => { if (state === 'SUBSCRIBED') refresh(); });
    return () => source.removeChannel(channel);
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
    watchControl(refresh) { return watchDisplay('control', refresh); },
    readControl() { return readDisplay('control'); },
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
      return watchDisplay(table === 'solar_generation_estimate' ? 'solar' : 'demand', refresh);
    },
    readDemandForecast() { return readDisplay('demand'); },
    readForecast() { return readDisplay('solar'); },
    async read(selectedDate) {
      if (!client) return;
      const source = client;
      const [latest] = await query(table().select('*').order('time', { ascending: false }).limit(1));
      if (client !== source) return;
      publishSample(latest);
      const date = [selectedDate || '9999', latest ? stamp(latest).slice(0, 10) : new Date().toISOString().slice(0, 10)].sort()[0];
      if (!latest) return { date };
      const day = new Date(date + 'T00:00:00Z');
      const history = await range(day.toISOString(), new Date(+day + 86400000).toISOString());
      return {
        date, system: record(latest), meter: record(latest),
        reserve: number(latest, 'battery_soc_reserve'),
        selectedFile: history.length ? systemFile(history, date.slice(0, 7)) : undefined,
      };
    },
  };
})();
