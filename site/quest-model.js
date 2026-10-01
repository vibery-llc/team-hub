/* Config and personal notes are separate: a report never becomes verified evidence. */
(() => {
  const text = value => typeof value === 'string' ? value.trim() : '';
  const id = value => /^[a-z0-9][a-z0-9-]{0,63}$/.test(text(value)) ? text(value) : '';
  const list = value => Array.isArray(value) ? value : [];
  function config(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const steps = list(source.steps).filter(s => {
      if (!s || !id(s.id) || seen.has(id(s.id)) || !text(s.title) || !text(s.action) || !text(s.proof)) return false;
      seen.add(id(s.id)); return true;
    }).map(s => ({ id:id(s.id), short:text(s.short) || text(s.title), title:text(s.title), body:text(s.body), action:text(s.action), proof:text(s.proof), check:text(s.check) || 'I report that I did this step', reinforcement:text(s.reinforcement) || 'You reported this step. Continue when you are ready.', selectAgent:s.selectAgent === true, instructions:list(s.instructions).map(text).filter(Boolean), links:list(s.links).filter(l => l && text(l.label) && globalThis.HubOverview.href(l.href)).map(l => ({label:text(l.label),href:globalThis.HubOverview.href(l.href)})) }));
    const settings = {enabled:source.enabled === true && Boolean(id(source.id)) && steps.length > 0,
      id:id(source.id), version:Number.isSafeInteger(source.version) && source.version > 0 ? source.version : 1,
      title:text(source.title) || 'Your first contribution.', description:text(source.description), helperName:text(source.helperName) || 'Your guide', steps};
    settings.ids = steps.map(s => s.id);
    settings.key = 'teamhub.quest.' + settings.id + '.v' + settings.version;
    return settings;
  }
  const initial = settings => ({version:settings.version,step:settings.ids[0] || '',reported:[]});
  function parse(raw, settings) {
    try {
      const value = JSON.parse(raw);
      if (!value || value.version !== settings.version) return initial(settings);
      return {version:settings.version,step:settings.ids.includes(value.step) ? value.step : settings.ids[0],reported:settings.ids.filter(id => Array.isArray(value.reported) && value.reported.includes(id))};
    } catch { return initial(settings); }
  }
  const report = (state, id, checked, settings) => ({...state,reported:settings.ids.filter(candidate => candidate === id ? Boolean(checked) : state.reported.includes(candidate))});
  const fromHash = (hash, settings) => settings.ids.includes(hash.replace(/^#/,'')) ? hash.replace(/^#/,'') : null;
  globalThis.HubQuest = {config,initial,parse,report,fromHash};
})();
