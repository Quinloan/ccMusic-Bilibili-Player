// Exercise the renderer's actual add/confirm/commit functions, with a small DOM adapter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
async function run() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: true, textContent: '', innerHTML: '', focus() {} });
    return elements.get(id);
  };
  let saves = 0;
  const splits = [], messages = [];
  const context = {
    $: element, document: { activeElement: null }, SPLIT_MIN_DURATION: 600,
    S: { folders: [{ id: 'first', name: '原歌单', items: [] }, { id: 'second', name: '目标歌单', items: [] }], active: 'first', cur: 3 },
    esc: text => String(text), fmtTotal: sec => sec + '秒', toast: text => messages.push(text),
    save: () => saves++, renderFolders() {}, renderList() {},
    maybeSplit: async (f, item, desc) => splits.push({ folder: f.id, bvid: item.bvid, desc }),
    B: { video: async bvid => ({ bvid, cid: 5, title: '长视频', duration: 1200, parts: [{ page: 1 }], desc: '简介' }) },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const sourceKey ='), source.indexOf('function pmEntries()'))
    + source.slice(source.indexOf('let addChoiceResolve ='), source.indexOf('async function playSearchItem(')), context);
  const item = { bvid: 'BVtest', cid: 42, page: 1, title: '长视频', duration: 1200 };
  const confirm = () => context.confirmAddDialog({ preventDefault() {} });
  const first = context.saveItemsToFolder([item]);
  assert.equal(saves, 0);
  assert.equal(element('#addWhole').checked, true);
  assert.equal(element('#addSplitOptions').hidden, false);
  element('#addFolder').value = 'second';
  confirm();
  await first;
  assert.equal(context.S.folders[0].items.length, 0);
  assert.equal(context.S.folders[1].items.length, 1);
  assert.equal(splits.length, 0, 'default whole must not trigger analysis');
  assert.equal(context.S.active, 'second');
  const before = JSON.stringify(context.S);
  const cancelled = context.saveItemsToFolder([{ ...item, bvid: 'cancelled' }]);
  element('#addFolder').value = '__new__'; element('#addNewName').value = '不该创建';
  context.closeAddDialog(null);
  assert.equal(await cancelled, null);
  assert.equal(JSON.stringify(context.S), before);
  const split = context.saveItemsToFolder([{ ...item, bvid: 'split' }], { description: '时间轴' });
  element('#addFolder').value = '__new__';
  confirm();
  assert.equal(element('#addModal').hidden, false);
  assert.match(element('#addError').textContent, /名称/);
  element('#addNewName').value = '目标歌单'; confirm();
  assert.match(element('#addError').textContent, /同名/);
  element('#addNewName').value = '新歌单'; element('#addSplit').checked = true; confirm();
  const created = await split;
  assert.equal(created.folder.name, '新歌单');
  assert.equal(splits.length, 1);
  assert.equal(splits[0].desc, '时间轴');
  const duplicate = context.saveItemsToFolder([{ ...item, bvid: 'split' }]); confirm();
  assert.equal((await duplicate).duplicates, 1);
  assert.equal(element('#addWhole').checked, true, 'previous opt-in must not change next default');
  const part = context.saveItemsToFolder([{ ...item, bvid: 'part', page: 2 }]);
  assert.equal(element('#addSplitOptions').hidden, true);
  context.closeAddDialog(null); await part;
  const segmented = context.saveItemsToFolder([{ ...item, split: true, bvid: 'segmented' }]);
  assert.equal(element('#addSplitOptions').hidden, true);
  context.closeAddDialog(null); await segmented;
  const add = context.addToFolder({ bvid: 'single' });
  await new Promise(resolve => setImmediate(resolve));
  const count = saves;
  assert.equal(element('#addModal').hidden, false);
  context.closeAddDialog(null); await add;
  assert.equal(saves, count);
  // Multi-P addition must go through the same destination dialog; cancellation retains the picker.
  context.pmSelectedKeys = () => ['P1'];
  context.pmEntries = () => [{ key: 'P1', bvid: 'parts', cid: 7, page: 1, name: 'P1', duration: 1300 }];
  context.pmMode = 'parts'; let closed = 0;
  context.closePartsPicker = () => closed++;
  vm.runInContext(source.slice(source.indexOf('async function pmCommit('), source.indexOf('// 打开某个视频的全部分 P')), context);
  const parts = context.pmCommit('add');
  assert.equal(element('#addSplitOptions').hidden, true);
  context.closeAddDialog(null); await parts;
  assert.equal(closed, 0);
  const commit = context.pmCommit('add');
  element('#addFolder').value = 'first'; confirm(); await commit;
  assert.equal(context.S.folders[0].items[0].bvid, 'parts');
  assert.equal(closed, 1);
  console.log('PASS: explicit target, cancellation without writes, default whole, opt-in split, create/validate playlist, dedup, single-video and multi-P flow');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
