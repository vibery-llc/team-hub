import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const context = vm.createContext({ URL });
vm.runInContext(await readFile(new URL('../site/overview-model.js', import.meta.url), 'utf8'), context);
const model = context.HubOverview;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('old, absent and disabled configs do not opt in', () => {
  for (const input of [undefined, null, {}, { enabled:false }, { enabled:'true' }]) assert.equal(model.config(input).enabled, false);
  assert.equal(model.config({ enabled:true }).enabled, true);
});
test('empty and malformed collections leave usable empty state', () => {
  const value = model.config({ enabled:true, places:[null, 4, {}, { label:'Valid', links:[{label:'bad',href:'javascript:alert(1)'}] }], stages:'no', guidance:[] });
  assert.equal(value.places.length, 1); assert.equal(value.places[0].links.length, 0);
  assert.equal(value.stages.length, 0); assert.equal(value.guidance.items.length, 0);
});
test('tenant labels, object references and status definitions remain independent', () => {
  const value = model.config({ places:[{ label:'Lab', description:'Test things' }], referenceExample:{title:'Components',containers:[{label:'Screen',object:'Button'}],asset:'Shared button'}, stages:[{label:'Accepted',description:'Reviewed'}] });
  assert.equal(value.places[0].label, 'Lab'); assert.equal(value.reference.containers[0].object, 'Button'); assert.equal(value.stages[0].label, 'Accepted');
});
test('executable, opaque and malformed URLs are rejected; assets stay local', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', '\\evil.example', 'https:\n//evil.example']) assert.equal(model.href(href), '');
  for (const href of ['https://example.com/icon.svg', '//example.com/x']) assert.equal(model.href(href, true), '');
  assert.equal(model.href('brand/icon.svg', true), 'brand/icon.svg');
  assert.equal(model.href('https://example.com/pr/1'), 'https://example.com/pr/1');
});
test('missing metadata never becomes a successful status', () => {
  const data = model.records({items:[{title:'Work',sources:[]}]});
  assert.equal(data.items[0].status, 'Status not recorded'); assert.equal(data.checkedAt, '');
  assert.equal(data.items[0].sources.length, 0);
  assert.throws(() => model.records({items:'wrong'}));
  assert.equal(model.records({items:[]}).items.length, 0);
});
test('status stays explicit, even when source prose mentions a merge', () => {
  const data = model.records({items:[{title:'Work',summary:'Merged PR; tests pass',status:'Needs review',sources:[{label:'PR',href:'https://example.com/1'}]}]});
  assert.equal(data.items[0].status, 'Needs review');
});
test('record strings stay literal for textContent rendering', () => {
  const data = model.records({items:[{title:'<img src=x onerror=alert(1)>',status:'<b>done</b>'}]});
  assert.equal(data.items[0].title, '<img src=x onerror=alert(1)>');
});
test('timestamps expose age, missing time and future dates', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.match(model.freshness('2026-09-29T00:00:00Z', now), /2 days old/);
  assert.match(model.freshness('', now), /not recorded/);
  assert.match(model.freshness('2026-09-29', now), /not recorded/);
  assert.match(model.freshness('2027-01-01T00:00:00Z', now), /invalid/);
});
test('shipped example is clearly marked and has valid local sources', async () => {
  const configContext = vm.createContext({});
  vm.runInContext(await readFile(new URL('../site/hub.config.js', import.meta.url), 'utf8'), configContext);
  const config = model.config(plain(configContext.HUB_CONFIG.overview));
  assert.equal(config.enabled, true); assert.equal(config.places.length, 4);
  const data = model.records(JSON.parse(await readFile(new URL('../site/overview.json', import.meta.url), 'utf8')));
  assert.equal(data.example, true); assert.equal(data.items.length, 3);
});
