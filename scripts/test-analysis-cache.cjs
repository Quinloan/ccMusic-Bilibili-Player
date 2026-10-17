const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { getAnalysis, saveAnalysis } = require('../analysis-cache.cjs');
const dir = fs.mkdtempSync(path.join(__dirname, 'cache-test-'));
const file = path.join(dir, 'cache.json');
try {
  assert.equal(getAnalysis(file, 'missing'), null);
  const partial = { tracks: [{ start: 0, end: 200 }] };
  saveAnalysis(file, 'partial', partial, 1000);
  assert.deepEqual(getAnalysis(file, 'partial', 2000), partial);
  assert.equal(getAnalysis(file, 'partial', 3601001), null);
  const full = { tracks: [{ start: 0, end: 200, title: '歌名' }] };
  saveAnalysis(file, 'full', full, 1000);
  assert.deepEqual(getAnalysis(file, 'full', 86400000), full);
  assert.equal(getAnalysis(file, 'full', 8 * 86400000), null);
  fs.writeFileSync(file, '{corrupt');
  assert.equal(getAnalysis(file, 'full'), null);
  console.log('PASS: analysis cache hit, partial/full TTLs, corrupt cache fallback');
} finally {
  fs.unlinkSync(file); fs.rmdirSync(dir);
}
