const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { saveAnalysis, getFragmentHistory, getFragmentHistories } = require('../analysis-cache.cjs');
const root = path.resolve(__dirname, '..'), file = path.join(root, 'validation', `fragment-history-${process.pid}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const base = { bvid: 'BV1CaPrz7EL6', cid: 36468035480, title: '再见爱人', artist: '胡彦斌', neteaseId: '2655113815' };
try {
  for (const [start, end] of [[2667, 2735.4], [2735.4, 2800.6], [2800.6, 2930.1]]) {
    const key = createHash('sha256').update(`progressive:${base.bvid}:${base.cid}:false:${start}:${end}`).digest('hex');
    saveAnalysis(file, key, { tracks: [{ start, end, title: base.title, artist: base.artist, neteaseId: base.neteaseId, source: 'netease' }] }, 1000);
  }
  const item = { ...base, startSec: 2667, endSec: 2800.6 };
  const expected = [{ start: 2667, end: 2735.4 }, { start: 2735.4, end: 2800.6 }];
  assert.deepEqual(getFragmentHistory(file, item, 2000), expected);
  assert.deepEqual(getFragmentHistories(file, [item, { ...item, cid: 1 }], 2000), [expected, null]);
  for (const patch of [{ cid: 1 }, { bvid: 'BV15C41187cx' }, { artist: '翻唱歌手' }, { neteaseId: '9' }, { startSec: 2660 }, { endSec: 2805 }]) assert.equal(getFragmentHistory(file, { ...item, ...patch }, 2000), null);
  assert.equal(getFragmentHistory(file, item, 8 * 86400000), null, 'expired recognition is not historical proof');
  const stored = JSON.parse(fs.readFileSync(file)); delete stored.entries[Object.keys(stored.entries)[1]];
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal(getFragmentHistory(file, item, 2000), null, 'a missing original fragment cannot be guessed from titles');
  console.log('PASS: exact cached source/identity/ID and complete fragment coverage; batch query, mismatch/expiry/hole rejection, no profile changes');
} finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
