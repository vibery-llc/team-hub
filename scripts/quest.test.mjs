import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const c = vm.createContext({ URL });
for (const file of ['overview-model.js','quest-model.js','hub.config.js']) vm.runInContext(await readFile(new URL('../site/'+file, import.meta.url),'utf8'), c);
const model = c.HubQuest;
const settings = model.config(c.HUB_CONFIG.onboarding);
const plain = x => JSON.parse(JSON.stringify(x));
test('onboarding is absent by default for existing tenant configurations', () => {
  for (const input of [undefined,null,{}, {enabled:false}, {enabled:true,steps:[]}]) assert.equal(model.config(input).enabled,false);
  assert.equal(settings.enabled,true);
});
test('invalid and duplicate step IDs are rejected without inventing steps', () => {
  const step={id:'first',title:'First',action:'Do it',proof:'Check it'};
  const result=model.config({enabled:true,id:'valid',steps:[null,step,step,{...step,id:'<script>'},{...step,id:'second'}]});
  assert.deepEqual(plain(result.ids),['first','second']);
});
test('tenant copy stays literal and unsafe instruction links are removed', () => {
  const result=model.config({id:'flow',steps:[{id:'first',title:'<img onerror=x>',action:'Try',proof:'Check',instructions:['<script>bad</script>'],links:[{label:'Bad',href:'javascript:x()'},{label:'Setup',href:'setup.html'}]}]});
  assert.equal(result.steps[0].title,'<img onerror=x>');
  assert.equal(result.steps[0].instructions[0],'<script>bad</script>');
  assert.equal(result.steps[0].links.length,1);
});
test('flow identity and version isolate local records', () => {
  const other=model.config({...c.HUB_CONFIG.onboarding,id:'another',version:2});
  assert.notEqual(settings.key,other.key);
  assert.deepEqual(plain(model.parse(JSON.stringify({version:1,step:'review',reported:['review']}),other)),plain(model.initial(other)));
});
test('malformed notes, removed IDs and duplicate reports are normalized', () => {
  assert.deepEqual(plain(model.parse('broken',settings)),plain(model.initial(settings)));
  const value=model.parse(JSON.stringify({version:1,step:'gone',reported:['setup','setup','accepted','review']}),settings);
  assert.deepEqual(plain(value),{version:1,step:'setup',reported:['setup','review']});
});
test('repeated cross-view reports are idempotent and can be undone', () => {
  let value=model.report(model.initial(settings),'setup',true,settings);
  value=model.report(model.parse(JSON.stringify(value),settings),'setup',true,settings);
  assert.deepEqual(plain(value.reported),['setup']);
  assert.deepEqual(plain(model.report(value,'setup',false,settings).reported),[]);
});
test('exploration and self-report do not infer predecessor completion or acceptance', () => {
  const value=model.report(model.initial(settings),'review',true,settings);
  assert.equal(value.step,'setup');assert.deepEqual(plain(value.reported),['review']);
  assert.equal(model.fromHash('#accepted',settings),null);
  assert.equal(model.fromHash('#review',settings),'review');
});
test('shipped local instruction anchors resolve to existing setup and guide sections', async () => {
  for(const step of settings.steps) for(const link of step.links){
    const match=/^(setup|guide)\.html#(.+)$/.exec(link.href);if(!match)continue;
    const page=await readFile(new URL('../site/'+match[1]+'.html',import.meta.url),'utf8');
    assert.ok(page.includes('id="'+match[2]+'"'),link.href);
  }
});
