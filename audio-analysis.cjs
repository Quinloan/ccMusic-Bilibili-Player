// Pure audio analysis helpers; no Electron or network dependencies.
function splitRms(rms, seconds) {
  const silences = [];
  const baselines = [];
  // Local baseline avoids a loud mastering level setting the threshold for a quiet song.
  for (let base = 0; base < rms.length; base += 300) {
    const local = rms.slice(Math.max(0, base - 300), base + 600).filter(Number.isFinite).sort((a, b) => a - b);
    const level = local[Math.floor(local.length * 0.65)] || 0;
    const threshold = Math.min(0.025, Math.max(0.001, level * 0.12));
    for (let i = base; i < Math.min(base + 300, rms.length); i++) {
      silences[i] = rms[i] <= threshold;
      baselines[i] = level;
    }
  }
  // Bridge a single 100ms noise spike, but require 600ms of actual low energy.
  const low = silences.slice();
  for (let i = 1; i + 1 < low.length; i++) {
    if (silences[i - 1] && silences[i + 1]) low[i] = true;
  }
  const gaps = [];
  let from = -1, quiet = 0;
  for (let i = 0; i <= low.length; i++) {
    if (low[i]) {
      if (from < 0) from = i;
      if (silences[i]) quiet++;
    } else if (from >= 0) {
      if (quiet >= 6) {
        let energy = 0, baseline = 0;
        for (let j = from; j < i; j++) { energy += rms[j]; baseline += baselines[j]; }
        const score = quiet / 10 * Math.log(1 + baseline / Math.max(0.00001, energy));
        gaps.push({ from: from / 10, to: i / 10, score });
      }
      from = -1; quiet = 0;
    }
  }
  const tracks = [];
  let start = 0;
  // Prefer a deeper/longer gap over an earlier weak pause within the minimum track span.
  // Greedy chronological selection otherwise hides the true boundary that follows it.
  const cuts = [];
  for (const gap of gaps.slice().sort((a, b) => b.score - a.score)) {
    const cut = +((gap.from + gap.to) / 2).toFixed(1);
    if (cut >= 60 && seconds - cut >= 60 && cuts.every(other => Math.abs(other - cut) >= 60)) cuts.push(cut);
  }
  for (const cut of cuts.sort((a, b) => a - b)) { tracks.push({ start, end: cut }); start = cut; }
  if (seconds > start) tracks.push({ start, end: +seconds.toFixed(1) });
  return { tracks, silences: gaps.length };
}

// Store exact windows by absolute sample index, independent of stdout chunk boundaries.
class PcmSampler {
  constructor(rate = 8000, every = 15, length = 12) {
    this.rate = rate; this.every = every * rate * 2; this.size = length * rate * 2;
    this.next = this.size; this.offset = 0; this.buffer = Buffer.alloc(0); this.samples = [];
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const end = this.offset + this.buffer.length;
    while (this.next <= end) {
      const start = this.next - this.size;
      this.samples.push({ from: start / (this.rate * 2), at: this.next / (this.rate * 2),
        pcm: Buffer.from(this.buffer.subarray(start - this.offset, this.next - this.offset)) });
      this.next += this.every;
    }
    const keep = Math.max(this.offset, Math.min(end, this.next - this.size));
    this.buffer = Buffer.from(this.buffer.subarray(keep - this.offset)); this.offset = keep;
  }
}

function selectSamples(samples, track) {
  const available = samples.filter(s => s.from >= track.start + 3 && s.at <= track.end - 3);
  const used = new Set();
  return [0.5, 0.3, 0.7].map(r => {
    const mid = track.start + (track.end - track.start) * r;
    const best = available.filter(s => !used.has(s)).sort((a, b) =>
      Math.abs((a.from + a.at) / 2 - mid) - Math.abs((b.from + b.at) / 2 - mid))[0];
    if (best) used.add(best);
    return best;
  }).filter(Boolean);
}
function timestampTracks(description, seconds) {
  const entries = [];
  for (const line of String(description || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[（(【\[])?(?:(\d{1,2})[:：])?(\d{1,3})[:：](\d{2})(?:[）)】\]])?\s*[-—|、.]?\s*(\S.*)$/);
    if (!m || +m[3] >= 60 || (m[1] && +m[2] >= 60)) continue;
    const start = (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3];
    if (start >= seconds) continue;
    entries.push({ start, title: m[4].trim(), source: 'description' });
  }
  // Reject unordered, sparse or ambiguous lists rather than inventing a tracklist.
  if (entries.length < 2 || entries[0].start > 15) return null;
  for (let i = 1; i < entries.length; i++) if (entries[i].start - entries[i - 1].start < 30) return null;
  entries[0].start = 0;
  return entries.map((entry, i) => ({ ...entry, end: entries[i + 1]?.start ?? +seconds.toFixed(1) }));
}
function matchKey(hit) {
  return [hit.name, hit.artist || ''].map(s => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, '')).join('|');
}
function specificSongMatch(hit) {
  return !!hit?.name && !/(?:合集|串烧|连歌|歌曲集|热歌精选|精选流行|纯音乐合集|\d{10,}|\.(?:mp3|wav|flac)$)/i.test(hit.name);
}
function consistentMatch(hits) {
  const votes = new Map();
  for (const hit of hits.filter(specificSongMatch)) {
    const key = matchKey(hit), entry = votes.get(key) || { count: 0, hit };
    entry.count++; votes.set(key, entry);
  }
  const ranked = [...votes.values()].sort((a, b) => b.count - a.count);
  return ranked[0]?.count >= 2 && (!ranked[1] || ranked[0].count > ranked[1].count) ? ranked[0].hit : null;
}
function mergeRecognizedFragments(tracks) {
  const merged = [];
  for (const track of tracks) {
    const prev = merged.at(-1);
    if (prev?.title && track.title && prev.end === track.start &&
      matchKey({ name: prev.title, artist: prev.artist }) === matchKey({ name: track.title, artist: track.artist }) &&
      (prev.end - prev.start < 120 || track.end - track.start < 120) &&
      prev.source !== 'description' && track.source !== 'description') prev.end = track.end;
    else merged.push({ ...track });
  }
  return merged;
}
module.exports = { splitRms, PcmSampler, selectSamples, timestampTracks, consistentMatch, mergeRecognizedFragments, specificSongMatch };
