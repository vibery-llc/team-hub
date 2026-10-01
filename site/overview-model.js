/* Shared parsing rules keep empty or malformed records from becoming progress. */
(() => {
  const text = (value) => typeof value === 'string' ? value.trim() : '';
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const list = (value) => Array.isArray(value) ? value : [];
  function href(value, local = false) {
    const raw = text(value);
    if (!raw || /[\\\u0000-\u001f\u007f]/.test(raw)) return '';
    try {
      const base = 'https://hub.invalid/';
      const parsed = new URL(raw, base);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      if (local && (parsed.origin !== new URL(base).origin || /^(?:[a-z]+:|\/\/)/i.test(raw))) return '';
      return raw;
    } catch { return ''; }
  }
  const links = (value) => list(value).map(object).map((item) => ({ label: text(item.label), href: href(item.href) })).filter((item) => item.label && item.href);
  function config(value) {
    const source = object(value);
    const reference = object(source.referenceExample);
    return {
      enabled: source.enabled === true,
      description: text(source.description), placesTitle: text(source.placesTitle), placesNote: text(source.placesNote),
      places: list(source.places).map(object).filter((item) => text(item.label)).map((item) => ({
        label: text(item.label), description: text(item.description), detail: text(item.detail), icon: href(item.icon, true), links: links(item.links),
      })),
      reference: {
        title: text(reference.title), description: text(reference.description), asset: text(reference.asset),
        referenceLabel: text(reference.referenceLabel) || 'references', caption: text(reference.caption),
        containers: list(reference.containers).map(object).filter((item) => text(item.label) && text(item.object)).map((item) => ({label:text(item.label), object:text(item.object)})),
      },
      workTitle: text(source.workTitle), workPath: href(source.workPath, true),
      stages: list(source.stages).map(object).filter((item) => text(item.label)).map((item) => ({label:text(item.label), description:text(item.description)})),
      guidance: { title:text(object(source.guidance).title), links:links(object(source.guidance).links),
        items:list(object(source.guidance).items).map(object).filter((item) => text(item.title) && text(item.text)).map((item) => ({title:text(item.title), text:text(item.text)})) },
    };
  }
  function records(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.items)) throw new Error('Invalid work records');
    return { example: value.example === true, checkedAt: text(value.checkedAt),
      items: value.items.map(object).filter((item) => text(item.title)).map((item) => ({
        title:text(item.title), status:text(item.status) || 'Status not recorded', summary:text(item.summary), next:text(item.next), revision:text(item.revision), sources:links(item.sources),
      })) };
  }
  function freshness(value, now = Date.now()) {
    // Require a complete ISO timestamp: permissive Date parsing can turn a
    // mistyped year or timezone-free date into a false verification claim.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return 'Verification time not recorded. Check the linked sources.';
    const calendar = new Date(value.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return 'Verification time is invalid. Check the linked sources.';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getTime() > now) return 'Verification time is invalid. Check the linked sources.';
    const days = Math.floor((now - date.getTime()) / 86400000);
    return `Checked ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC${days >= 1 ? ` · ${days} day${days === 1 ? '' : 's'} old` : ''}. Check sources for later updates.`;
  }
  globalThis.HubOverview = { config, records, freshness, href };
})();
