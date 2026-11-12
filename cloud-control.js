'use strict';

(() => {
  const form = document.getElementById('solar-control-login');
  if (!form) return;
  const signIn = form.querySelector('[type="submit"]');
  const signOut = document.getElementById('solar-control-sign-out');
  const status = document.getElementById('solar-control-auth-status');
  const pointColumns = 'time,end_time,soc,estimated_soc,no_charge_soc,end_soc,end_no_charge_soc,'
    + 'demand_kwh,estimated_demand_kwh,solar_kwh,estimated_solar_kwh,grid_kwh';
  let project;
  let client;
  let authenticated = false;
  let authSubscription;
  let planChannel;
  let refreshTimer;

  function notify() {
    window.dispatchEvent(new Event('energy-control-changed'));
  }

  function updateAuthView(message = '') {
    form.hidden = !client || authenticated;
    signOut.hidden = !authenticated;
    status.textContent = message;
  }

  function stopWatching() {
    clearTimeout(refreshTimer);
    if (planChannel) void client.removeChannel(planChannel);
    planChannel = undefined;
  }

  function watchPlan(source) {
    const refresh = () => {
      if (client !== source || !authenticated) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(notify, 250);
    };
    const planChanges = { schema: 'public', table: 'control_graph', filter: 'series=eq.plan' };
    planChannel = source.channel('control-graph-plan')
      .on('postgres_changes', { ...planChanges, event: 'INSERT' }, refresh)
      .on('postgres_changes', { ...planChanges, event: 'UPDATE' }, refresh)
      .subscribe(state => { if (state === 'SUBSCRIBED') refresh(); });
  }

  function newClient(connection) {
    stopWatching();
    authSubscription?.unsubscribe();
    if (client) void client.auth.stopAutoRefresh();
    authenticated = false;
    client = connection && window.supabase.createClient(connection.url, connection.key, {
      auth: { persistSession: false, detectSessionInUrl: false, storageKey: 'energy-manager-control-auth' },
    });
    if (client) {
      const source = client;
      authSubscription = source.auth.onAuthStateChange(event => {
        if (event !== 'SIGNED_OUT') return;
        setTimeout(() => {
          if (client !== source || !authenticated) return;
          stopWatching();
          authenticated = false;
          form.reset();
          updateAuthView('Sign in again to load the Control graph.');
          notify();
        }, 0);
      }).data.subscription;
    } else {
      authSubscription = undefined;
    }
    form.reset();
    signIn.disabled = !client;
    updateAuthView(client ? '' : 'Connect to your Supabase project first.');
  }

  function connectProject() {
    const candidate = window.energyCloud.controlProject();
    const endpoint = candidate && new URL(candidate.url);
    const connection = endpoint?.protocol === 'https:' && endpoint.pathname === '/'
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash ? candidate : undefined;
    if (project?.url === connection?.url && project?.key === connection?.key && client) return;
    project = connection;
    newClient(project);
    notify();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!client || signIn.disabled || authenticated) return;
    const source = client;
    const { email, password } = form.elements;
    const credentials = { email: email.value.trim(), password: password.value };
    password.value = '';
    signIn.disabled = true;
    status.textContent = 'Signing in to Supabase.';
    try {
      const { data, error } = await source.auth.signInWithPassword(credentials);
      if (error || !data.session) throw new Error('Check the Supabase uploader email and password.');
      const access = await source.rpc('control_graph_uploader_allowed');
      if (client !== source) {
        void source.auth.signOut({ scope: 'local' });
        return;
      }
      if (access.error) throw new Error('Could not verify Control access in this Supabase project.');
      if (access.data !== true) throw new Error('Sign in with the forecast uploader configured for this project.');
      authenticated = true;
      form.reset();
      updateAuthView();
      watchPlan(source);
      notify();
    } catch (error) {
      if (client !== source) return;
      newClient(project);
      void source.auth.signOut({ scope: 'local' });
      updateAuthView(error.message || 'Could not sign in to Supabase.');
      notify();
    } finally {
      if (client === source) signIn.disabled = false;
    }
  });

  signOut.addEventListener('click', () => {
    const source = client;
    newClient(project);
    if (source) void source.auth.signOut({ scope: 'local' });
    notify();
  });

  async function query(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }

  const loadPlan = source => query(source.from('control_graph').select('time,metadata').eq('series', 'plan').maybeSingle());

  async function loadPoints(source, series, start, end) {
    const rows = [];
    let cursor;
    for (;;) {
      const request = source.from('control_graph').select(pointColumns).eq('series', series)
        .lt('time', end).order('time').limit(1000);
      const page = await query(cursor ? request.gt('time', cursor) : request.gte('time', start));
      if (!page.length) return rows;
      for (const { time, end_time, ...values } of page) {
        rows.push({ ...values, time: Date.parse(time) / 1000, end: end_time ? Date.parse(end_time) / 1000 : null });
      }
      cursor = page.at(-1).time;
    }
  }

  window.energyControl = {
    signedIn: () => authenticated,
    async read() {
      if (!authenticated) throw new Error('Sign in to read the Control graph.');
      const source = client;
      for (let attempt = 0; attempt < 2; attempt++) {
        const plan = await loadPlan(source);
        if (client !== source || !authenticated) throw new Error('The Control session changed.');
        if (!plan) return null;
        const metadata = plan.metadata;
        if (!Number.isFinite(metadata?.as_of) || !Number.isFinite(metadata.start)
          || !Number.isFinite(metadata.end) || metadata.end <= metadata.start) {
          throw new Error('The published Control plan has no valid time window.');
        }
        const start = new Date(metadata.start * 1000).toISOString();
        const end = new Date(metadata.end * 1000).toISOString();
        const [history_soc, history, forecast] = await Promise.all(['history_soc', 'history', 'forecast']
          .map(series => loadPoints(source, series, start, end)));
        const latest = await loadPlan(source);
        if (client !== source || !authenticated) throw new Error('The Control session changed.');
        if (latest?.time === plan.time && latest.metadata?.as_of === metadata.as_of) {
          return { ...metadata, history_soc, history, forecast };
        }
      }
      throw new Error('The NAS is updating the Control plan. Try refreshing again.');
    },
  };

  window.addEventListener('energy-cloud-connected', connectProject);
  connectProject();
})();
