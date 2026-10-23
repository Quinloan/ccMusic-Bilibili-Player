const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const VERSION = 5;
function readEntries(file) {
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.version === VERSION && data.entries && typeof data.entries === 'object' ? data.entries : {};
  } catch (_) { return {}; }
}
function getAnalysis(file, key, now = Date.now()) {
  const entry = readEntries(file)[key];
  if (!entry || entry.expires <= now || !Array.isArray(entry.result?.tracks)) return null;
  return entry.result;
}
function saveAnalysis(file, key, result, now = Date.now()) {
  const entries = readEntries(file);
  const complete = result.tracks.every(t => t.title);
  entries[key] = { expires: now + (complete ? 7 * 86400000 : 3600000), at: now, result };
  const kept = Object.fromEntries(Object.entries(entries).filter(([, value]) => value.expires > now)
    .sort((a, b) => b[1].at - a[1].at).slice(0, 40));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: VERSION, entries: kept }));
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
}
function getFragmentHistory(file, item, now = Date.now(), entries = readEntries(file)) {
  if (!/^BV[\da-z]{10}$/i.test(item?.bvid || '') || !Number.isSafeInteger(Number(item.cid)) || Number(item.cid) <= 0 ||
    !Number.isFinite(item.startSec) || !Number.isFinite(item.endSec) || item.endSec <= item.startSec || !item.title || !item.artist) return null;
  const keyOf = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const candidates = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.expires <= now || entry.result?.tracks?.length !== 1) continue;
    const t = entry.result.tracks[0];
    if (!['netease', 'shazam'].includes(t.source) || keyOf(t.title) !== keyOf(item.title) || keyOf(t.artist) !== keyOf(item.artist) ||
      (item.neteaseId && t.neteaseId && String(item.neteaseId) !== String(t.neteaseId)) ||
      !Number.isFinite(t.start) || !Number.isFinite(t.end) || t.start < item.startSec - 0.15 || t.end > item.endSec + 0.15 || t.end <= t.start) continue;
    if (![true, false].some(lyrics => createHash('sha256').update(`progressive:${item.bvid}:${item.cid}:${lyrics}:${t.start}:${t.end}`).digest('hex') === key)) continue;
    candidates.push({ start: t.start, end: t.end });
  }
  const rows = [...new Map(candidates.map(row => [row.start + ':' + row.end, row])).values()].sort((a, b) => a.start - b.start || a.end - b.end);
  // Prefer the finest cached chain, and require complete coverage with no gaps.
  const chain = []; let end = item.startSec;
  while (end < item.endSec - 0.15) {
    const row = rows.find(row => Math.abs(row.start - end) <= 0.15 && row.end > end);
    if (!row) return null;
    chain.push(row); end = row.end;
  }
  return chain.length > 1 && Math.abs(end - item.endSec) <= 0.15 ? chain : null;
}
function getFragmentHistories(file, items, now = Date.now()) {
  const entries = readEntries(file);
  return items.map(item => getFragmentHistory(file, item, now, entries));
}
module.exports = { getAnalysis, saveAnalysis, getFragmentHistory, getFragmentHistories };
