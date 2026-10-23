const assert = require('node:assert/strict');
const { canMergeFragments, cutTrack, mergeTrack, importedFolders } = require('../renderer/library-model.js');
const left = { bvid: 'BV15C41187cx', cid: 42, page: 1, split: true, splitBatch: 'a', startSec: 0, endSec: 89,
  title: 'Mr. "Broken Heart"', artist: '松下優也', identifySource: 'shazam', originalDuration: 500 };
const right = { ...left, startSec: 89, endSec: 217 };
assert.equal(canMergeFragments(left, right), true);
const merged = { ...left, startSec: 2667, endSec: 2800.6, splitFragments: [{ start: 2667, end: 2735.4 }, { start: 2735.4, end: 2800.6 }] };
const third = { ...left, startSec: 2800.6, endSec: 2930.1 };
assert.equal(canMergeFragments(merged, third), true, '68.4 + 65.2 + 129.5 seconds: retain original evidence after the first join');
assert.equal(canMergeFragments({ ...merged, splitFragments: undefined }, third), false, 'two long rows without provenance remain conservative');
assert.equal(canMergeFragments({ ...merged, splitFragments: [{ start: 0, end: 10 }, { start: 10, end: 20 }] }, third), false, 'invalid history cannot bypass safeguards');
assert.equal(canMergeFragments({ ...merged, boundaryLocked: true }, third), false);
for (const patch of [{ title: 'Mr. "Broken Heart" (Live)' }, { artist: '翻唱者' }, { identifySource: 'manual' },
  { identifySource: 'description' }, { identifySource: 'lyrics' }, { identifySource: 'title' }, { artist: '' },
  { startSec: 90 }, { splitBatch: 'other' }, { cid: 43 }, { page: 2 }, { boundaryLocked: true }, { endSec: 178 }]) {
  assert.equal(canMergeFragments(left, { ...right, ...patch }), false, JSON.stringify(patch));
}
assert.equal(canMergeFragments({ ...left, neteaseId: '1' }, { ...right, neteaseId: '2' }), false);
assert.equal(canMergeFragments({ ...left, endSec: 200 }, { ...right, startSec: 200, endSec: 480 }), false, 'two full-length recordings are not short fragments');
assert.equal(canMergeFragments(left, { ...right, endSec: 1000 }), false);
const cut = cutTrack([{ start: 0, end: 217 }], 0, 89);
assert(cut.every(t => t.boundaryLocked)); assert(mergeTrack(cut, 1)[0].boundaryLocked);
const imported = importedFolders({ folders: [{ name: '分段', items: [{ ...left, duration: 89, boundaryLocked: true }, { ...right, duration: 128 }] }] });
assert.equal(imported[0].items[0].boundaryLocked, true); assert.equal(imported[0].items[0].splitBatch, 'a');
const roundTrip = importedFolders({ folders: [{ name: '链式合并', items: [{ ...merged, duration: 133.6, originalDuration: 3167 }] }] });
assert.deepEqual(roundTrip[0].items[0].splitFragments, merged.splitFragments);
console.log('PASS: adjacent unequal short fingerprint fragments; same recording/source/version/artist/ID, equal-loop/full-length/gap/manual/timestamp/lyrics protection; boundary lock import');
