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
    async read(selectedDate) {
      if (!client) return;
      const [latest] = await query(table().select('*').order('time', { ascending: false }).limit(1));
      const date = [selectedDate || '9999', latest ? stamp(latest).slice(0, 10) : new Date().toISOString().slice(0, 10)].sort()[0];
      if (!latest) return { date };
      const day = new Date(date + 'T00:00:00Z');
      const end = new Date(latest.time).getTime();
      const [history, recent] = await Promise.all([
        range(day.toISOString(), new Date(+day + 86400000).toISOString()),
        range(new Date(end - 21 * 60000).toISOString(), new Date(end + 1).toISOString()),
      ]);
      const month = stamp(latest).slice(0, 7);
      const previous = recent.filter(row => stamp(row).slice(0, 7) !== month);
      return {
        date, system: record(latest), meter: record(latest),
        selectedFile: history.length ? systemFile(history, date.slice(0, 7)) : undefined,
        latestFile: systemFile(recent.filter(row => stamp(row).startsWith(month)), month),
        previousFile: previous.length ? systemFile(previous, stamp(previous[0]).slice(0, 7)) : undefined,
      };
    },
  };
})();
