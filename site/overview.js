/* Tenant prose is text, never HTML. The overview does not infer acceptance. */
(async () => {
  const model = globalThis.HubOverview;
  const settings = model.config(globalThis.HUB_CONFIG?.overview);
  const byId = (id) => document.getElementById(`overview-${id}`);
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const appendLinks = (parent, links, buttons = false) => {
    for (const item of links) {
      const a = node('a', item.label, buttons ? 'btn btn--ghost' : '');
      a.href = item.href;
      parent.append(a);
    }
  };
  if (!settings.enabled) return;
  byId('empty').hidden = true;
  if (settings.description) byId('description').textContent = settings.description;
  byId('scoreboard-link').hidden = globalThis.HUB_CONFIG?.pipelineScoreboard?.enabled !== true;

  if (settings.places.length) {
    byId('places-section').hidden = false;
    if (settings.placesTitle) byId('places-title').textContent = settings.placesTitle;
    for (const place of settings.places) {
      const details = node('details', '', 'overview-place');
      const summary = node('summary');
      if (place.icon) {
        const img = node('img'); img.src = place.icon; img.alt = ''; img.width = 36; img.height = 36;
        img.addEventListener('error', () => { img.hidden = true; }, { once: true });
        summary.append(img);
      }
      const label = node('span'); label.append(node('strong', place.label), node('span', place.description));
      const toggle = node('span', '+', 'overview-toggle'); toggle.setAttribute('aria-hidden', 'true');
      summary.append(label, toggle);
      const body = node('div', '', 'overview-place-body');
      body.append(node('p', place.detail || 'No description added yet.'));
      const links = node('div', '', 'overview-links'); appendLinks(links, place.links); body.append(links);
      details.append(summary, body); byId('places').append(details);
    }
    if (settings.placesNote) { byId('places-note').hidden = false; byId('places-note').textContent = settings.placesNote; }
    const ref = settings.reference;
    if (ref.title && ref.asset && ref.containers.length) {
      byId('reference').hidden = false;
      byId('reference-title').textContent = ref.title;
      byId('reference-description').textContent = ref.description;
      byId('reference-caption').textContent = ref.caption;
      for (const container of ref.containers) {
        const box = node('div', '', 'overview-container');
        box.append(node('strong', container.label), node('div', container.object, 'overview-object'), node('span', `${ref.referenceLabel} ↓`, 'overview-ref-label'));
        byId('reference-example').append(box);
      }
      byId('reference-example').append(node('div', ref.asset, 'overview-asset'));
    }
  }
  const guide = settings.guidance;
  if (guide.items.length || guide.links.length) {
    byId('guidance-section').hidden = false;
    if (guide.title) byId('guidance-title').textContent = guide.title;
    for (const item of guide.items) {
      const section = node('div'); section.append(node('h3', item.title), node('p', item.text)); byId('guidance-items').append(section);
    }
    appendLinks(byId('guidance-links'), guide.links, true);
  }
  byId('work-section').hidden = false;
  if (settings.workTitle) byId('work-title').textContent = settings.workTitle;
  if (settings.stages.length) {
    byId('status-key').hidden = false;
    for (const item of settings.stages) {
      const li = node('li'); li.append(node('strong', item.label), node('span', item.description)); byId('stages').append(li);
    }
  }
  if (!settings.workPath) {
    byId('freshness').textContent = 'No work records configured. Open the dashboard to see project data.';
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(settings.workPath, { cache:'no-cache', signal:controller.signal });
    if (!response.ok) throw new Error('Work records unavailable');
    const data = model.records(await response.json());
    byId('example').hidden = !data.example;
    byId('freshness').textContent = data.example ? 'Example records — not current project progress.' : model.freshness(data.checkedAt);
    if (!data.items.length) byId('work').append(node('p', 'No work records in this update. Open the dashboard for the full project.'));
    for (const item of data.items) {
      const row = node('article', '', 'overview-work-row');
      const label = node('div'); label.append(node('span', item.status, 'overview-work-status'), node('h3', item.title));
      if (item.revision) label.append(node('code', item.revision));
      const detail = node('div'); detail.append(node('p', item.summary));
      if (item.next) detail.append(node('p', `Next: ${item.next}`, 'overview-caption'));
      const sources = node('div', '', 'overview-links'); appendLinks(sources, item.sources);
      if (!item.sources.length) sources.append(node('span', 'No source linked.', 'overview-caption'));
      detail.append(sources); row.append(label, detail); byId('work').append(row);
    }
  } catch {
    byId('freshness').textContent = 'Could not load this update. No current status is available here; open the dashboard or linked sources.';
  } finally { clearTimeout(timeout); }
})();
