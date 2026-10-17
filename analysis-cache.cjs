const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
module.exports = { getAnalysis, saveAnalysis };
