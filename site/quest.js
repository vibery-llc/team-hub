/* Configured onboarding: both views share one local note set. No chat, verification or provisioning API. */
(() => {
  const model = globalThis.HubQuest;
  if (!model || !globalThis.HubOverview) return;
  const settings = model.config(globalThis.HUB_CONFIG?.onboarding);
  if (!settings.enabled) return;
  const steps = settings.steps;
  const $ = selector => document.querySelector(selector);
  let state = model.initial(settings);
  let writable = true;
  try { state = model.parse(localStorage.getItem(settings.key), settings); } catch { writable = false; }
  state.step = model.fromHash(location.hash, settings) || state.step;
  const agentNames = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', other: 'Another agent' };
  const save = () => {
    try { localStorage.setItem(settings.key, JSON.stringify(state)); writable = true; }
    catch { writable = false; }
    $('#storage-note').textContent = writable
      ? 'Quest notes stay in this browser. They do not verify access, builds or review.'
      : 'This browser cannot save quest notes. You can continue here, but your place may be lost when you leave.';
  };
  const index = () => settings.ids.indexOf(state.step);
  function move(id) {
    if (!settings.ids.includes(id)) return;
    state.step = id; save();
    // Real history entries make Back work across steps without duplicating reports.
    if (location.hash !== '#' + id) history.pushState(null, '', '#' + id);
    render(); $('#step-title').focus();
  }
  function updateReportUI() {
    const n = index(), s = steps[n], done = state.reported.includes(s.id);
    $('#step-body').textContent = done ? s.reinforcement : s.body;
    $('#action').textContent = done ? (n === steps.length - 1 ? 'Return to the project' : 'Continue: ' + steps[n + 1].short) : s.action;
    if (done) {
      $('#action').removeAttribute('aria-expanded'); $('#action').removeAttribute('aria-controls');
    } else {
      $('#action').setAttribute('aria-expanded', String(!$('#instructions').hidden));
      $('#action').setAttribute('aria-controls', 'instructions');
    }
    $('#reported').checked = done;
    $('#proof-status').textContent = done ? 'You reported this step · not independently verified' : 'No completion reported · not independently verified';
    $('#next').hidden = done;
    $('#next').textContent = n === steps.length - 1 ? 'Return to the project' : 'Preview next step';
    $('#saved-count').textContent = state.reported.length + ' of ' + steps.length + ' steps self-reported. This is personal setup progress.';
    document.querySelectorAll('[data-step]').forEach((button, i) => {
      button.setAttribute('aria-current', i === n ? 'step' : 'false');
      button.querySelector('small').textContent = state.reported.includes(steps[i].id) ? 'Self-reported' : i === n ? 'Selected' : 'Explore step';
    });
  }
  function render() {
    const n = index(), s = steps[n];
    $('#step-title').textContent = s.title;
    $('#chapter').textContent = 'Main quest · Step ' + (n + 1) + ' of ' + steps.length;
    $('#proof-copy').textContent = s.proof;
    // Tenant content is always text. Link schemes were validated by the config model.
    const body = $('#instructions-body'); body.replaceChildren();
    const instructions = document.createElement('ol');
    for (const line of s.instructions) { const li = document.createElement('li'); li.textContent = line; instructions.append(li); }
    if (s.selectAgent) {
      const label = document.createElement('label'); label.htmlFor = 'quest-agent'; label.textContent = 'Which agent are you using?';
      const select = document.createElement('select'); select.id = 'quest-agent';
      for (const [value, name] of Object.entries(agentNames)) { const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option); }
      body.append(label, select);
    }
    body.append(instructions);
    for (const link of s.links) { const a = document.createElement('a'); a.href = link.href; a.textContent = link.label; body.append(a); }
    $('#check-copy').textContent = s.check;
    $('#instructions').hidden = true;
    $('#feedback').textContent = '';
    $('#reset-confirm').hidden = true; $('#reset').setAttribute('aria-expanded', 'false');
    document.querySelectorAll('.quest-view-switch a').forEach(link => {
      if (/\/(start|project-map)(\.html)?$/.test(new URL(link.href).pathname)) link.setAttribute('href', link.getAttribute('href').split('#')[0] + '#' + s.id);
    });
    const agent = $('#quest-agent');
    if (agent) {
      let selected = 'codex';
      try { const saved = localStorage.getItem('kfhub.agent'); if (agentNames[saved]) selected = saved; } catch { /* optional preference */ }
      agent.value = selected;
      const note = document.createElement('p'); note.className = 'mobile-note'; agent.after(note);
      const explain = () => { note.textContent = 'On the setup page, choose ' + agentNames[agent.value] + ' to see its install instructions.'; };
      explain();
      agent.addEventListener('change', () => {
        try { localStorage.setItem('kfhub.agent', agent.value); }
        catch { note.textContent = 'Your choice could not be saved. Choose the same tool on the setup page.'; return; }
        explain();
      });
    }
    updateReportUI();
    if (!writable) $('#storage-note').textContent = 'This browser cannot save quest notes. You can still explore; your place may be lost when you leave.';
  }
  const next = () => {
    if (index() === steps.length - 1) location.href = 'overview.html';
    else move(steps[index() + 1].id);
  };
  $('#quest-unavailable').hidden = true; $('#quest-body').hidden = false; $('#quest-footer').hidden = false;
  const isMap = /project-map(?:\.html)?$/.test(location.pathname);
  $('#quest-title').textContent = isMap ? (globalThis.HUB_CONFIG?.projectName || 'Your project') : settings.title;
  $('#quest-description').textContent = settings.description;
  $('#quest-helper').textContent = settings.helperName;
  for (const [i, step] of steps.entries()) {
    const li = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.dataset.step = i;
    const number = document.createElement('span'); number.className = 'num'; number.textContent = i + 1;
    const label = document.createElement('span'), strong = document.createElement('strong'), status = document.createElement('small'); strong.textContent = step.short; label.append(strong, status); button.append(number,label); li.append(button); $('#quest-steps').append(li);
  }
  const overview = globalThis.HubOverview.config(globalThis.HUB_CONFIG?.overview);
  if (overview.enabled && overview.places.length) {
    $('#quest-world').hidden = false; $('#quest-places-title').textContent = overview.placesTitle || 'Project areas'; $('#quest-places-note').textContent = overview.placesNote;
    for (const place of overview.places) {
      const details = document.createElement('details'); details.className = 'scene'; const summary = document.createElement('summary');
      if (place.icon) { const image = document.createElement('img'); image.src = place.icon; image.alt = ''; image.width = 36; image.height = 36; image.addEventListener('error',()=>{ image.hidden = true; },{once:true}); summary.append(image); }
      const label = document.createElement('span'), strong = document.createElement('strong'), desc = document.createElement('small'); strong.textContent = place.label; desc.textContent = place.description; label.append(strong,desc); summary.append(label); details.append(summary);
      const p = document.createElement('p'); p.textContent = place.detail; details.append(p);
      for (const link of place.links) {const a = document.createElement('a'); a.href = link.href; a.textContent = link.label; details.append(a);}
      $('#quest-places').append(details);
    }
  }
  document.querySelectorAll('[data-step]').forEach(button => {
    button.addEventListener('click', () => move(steps[Number(button.dataset.step)].id));
  });
  $('#action').addEventListener('click', () => {
    if (state.reported.includes(state.step)) { next(); return; }
    const panel = $('#instructions'); panel.hidden = !panel.hidden;
    $('#action').setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('#reported').addEventListener('change', event => {
    state = model.report(state, state.step, event.target.checked, settings); save(); updateReportUI();
    $('#feedback').textContent = writable
      ? (event.target.checked ? 'Saved on this browser. Continue when you’re ready.' : 'Your report was removed.')
      : 'Your note is kept for this visit only. This browser could not save it.';
  });
  $('#next').addEventListener('click', next);
  $('#reset').addEventListener('click', () => {
    $('#reset-confirm').hidden = !$('#reset-confirm').hidden;
    $('#reset').setAttribute('aria-expanded', String(!$('#reset-confirm').hidden));
    if (!$('#reset-confirm').hidden) $('#cancel-reset').focus();
  });
  $('#cancel-reset').addEventListener('click', () => {
    $('#reset-confirm').hidden = true; $('#reset').setAttribute('aria-expanded', 'false'); $('#reset').focus();
  });
  $('#confirm-reset').addEventListener('click', () => {
    state = model.initial(settings); save(); history.replaceState(null, '', location.pathname + location.search);
    render(); $('#step-title').focus();
  });
  window.addEventListener('popstate', () => {
    state.step = model.fromHash(location.hash, settings) || settings.ids[0]; save(); render();
  });
  window.addEventListener('hashchange', () => {
    const id = model.fromHash(location.hash, settings);
    if (id && id !== state.step) { state.step = id; save(); render(); }
  });
  window.addEventListener('storage', event => {
    if (event.key === settings.key) { state = model.parse(event.newValue, settings); history.replaceState(null, '', location.pathname + location.search + '#' + state.step); render(); }
  });
  const dark = () => document.documentElement.dataset.questTheme
    ? document.documentElement.dataset.questTheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const themeLabel = () => { $('#theme').textContent = dark() ? 'Light appearance' : 'Dark appearance'; };
  $('#theme').addEventListener('click', () => {
    document.documentElement.dataset.questTheme = dark() ? 'light' : 'dark'; themeLabel();
  });
  themeLabel(); render();
  if (/project-map(?:\.html)?$/.test(location.pathname)) {
    document.title = 'Project map · Get set up — ' + (globalThis.HUB_CONFIG?.siteName || 'Team Hub');
    document.querySelectorAll('.site__nav a').forEach(link => link.classList.toggle('active', /start\.html$/.test(link.getAttribute('href'))));
  }
})();
