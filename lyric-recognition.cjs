const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pcmWav } = require('./shazam-provider.cjs');
const { searchNeteaseLyrics } = require('./netease-lyrics.cjs');
const { waitFor } = require('./cancellation.cjs');
const toSimplified = require('opencc-js').Converter({ from: 'tw', to: 'cn' });

const normalize = text => toSimplified(String(text || '').normalize('NFKC').toLowerCase())
  .replace(/<[^>]*>|\[[^\]]*\]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
const baseTitle = text => String(text).replace(/[（(][^）)]*[）)]/g, '').replace(/\s*(?:R&B|伴奏|instrumental|翻唱版|live)\s*$/i, '').trim();
const titleKey = text => normalize(baseTitle(text));
function similarity(query, line) {
  if (line.includes(query)) return 1;
  // Semi-global edit distance: ignore unmatched prefix/suffix of the database line.
  let row = Array(line.length + 1).fill(0);
  for (let i = 0; i < query.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < line.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (query[i] !== line[j])));
    row = next;
  }
  return 1 - Math.min(...row) / query.length;
}
function lyricPhrases(segments) {
  return [...new Set(segments.flatMap(s => String(s.text || s).split(/[，。！？,!?\n]/)).map(normalize)
    .filter(s => s.length >= 6 && s.length <= 60 && !/字幕|订阅|点赞|收看|歌词|翻译/.test(s)))];
}
function rankLyrics(segments, songs) {
  const phrases = lyricPhrases(segments);
  const byTitle = new Map();
  for (const song of songs) {
    const lines = (song.lyrics || []).map(normalize).filter(s => s.length >= 4 && s.length <= 180);
    const joined = lines.map((s, i) => s + (lines[i + 1] || ''));
    const supported = phrases.map(phrase => ({ phrase, score: Math.max(0, ...lines.concat(joined).map(line => similarity(phrase, line))) }))
      .filter(m => m.score >= 0.78);
    const chars = supported.reduce((n, m) => n + m.phrase.length, 0);
    const score = chars ? supported.reduce((n, m) => n + m.score * m.phrase.length, 0) / chars : 0;
    if (supported.length < 2 || chars < 14 || score < 0.84) continue;
    const hit = { name: baseTitle(song.name), artist: '', referenceArtist: (song.artists || song.ar || []).map(a => a.name).join('/'),
      source: 'lyrics', score, matchedPhrases: supported.map(m => m.phrase), songId: song.id };
    const key = titleKey(song.name), old = byTitle.get(key);
    if (!old || hit.score > old.score) byTitle.set(key, hit);
  }
  return [...byTitle.values()].sort((a, b) => b.score - a.score || b.matchedPhrases.length - a.matchedPhrases.length);
}
function chooseLyricMatch(segments, songs) {
  const ranked = rankLyrics(segments, songs);
  if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < 0.06)) return null;
  return ranked[0];
}
function whisperPaths(resourceRoot) {
  return { exe: path.join(resourceRoot, 'whisper', 'Release', 'whisper-cli.exe'),
    model: path.join(resourceRoot, 'whisper', 'ggml-small-q5_1.bin') };
}
function lyricsAvailable(resourceRoot) {
  const p = whisperPaths(resourceRoot);
  return fs.existsSync(p.exe) && fs.existsSync(p.model);
}
async function decodeLyricClip(ffmpeg, source, start, seconds = 30, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-ss', String(Math.max(0, start)), '-i', source,
      '-t', String(seconds), '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { windowsHide: true, signal });
    const chunks = []; let bytes = 0, log = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', b => {
      bytes += b.length;
      if (bytes > 16000 * 2 * (seconds + 1)) child.kill();
      else chunks.push(b);
    });
    child.stderr.on('data', b => { log = (log + b).slice(-1000); });
    child.once('error', error => { clearTimeout(timer); if (error.name !== 'AbortError') reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0 || bytes < 16000 * 2 * 5) reject(new Error('歌词采样失败: ' + log));
      else resolve(Buffer.concat(chunks));
    });
  });
}
async function transcribePcm(pcm, rate, resourceRoot, signal) {
  signal?.throwIfAborted();
  if (![8000, 16000].includes(rate)) throw new Error('Unsupported lyric sample rate');
  const files = whisperPaths(resourceRoot);
  if (!lyricsAvailable(resourceRoot)) return [];
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ccmusic-lyrics-'));
  const input = path.join(dir, 'clip.wav'), output = path.join(dir, 'result');
  // whisper-cli expects 16kHz input. Current product analysis retains 8kHz PCM.
  let converted = pcm;
  if (rate === 8000) {
    converted = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length / 2; i++) {
      const a = pcm.readInt16LE(i * 2), b = i + 1 < pcm.length / 2 ? pcm.readInt16LE(i * 2 + 2) : a;
      converted.writeInt16LE(a, i * 4); converted.writeInt16LE(Math.round((a + b) / 2), i * 4 + 2);
    }
  }
  try {
    await fs.promises.writeFile(input, pcmWav(converted, 16000));
    await new Promise((resolve, reject) => {
      const child = spawn(files.exe, ['-m', files.model, '-f', input, '-l', 'zh', '-t', String(Math.min(8, Math.max(2, Math.floor(os.availableParallelism() / 2)))), '-bs', '3', '-bo', '3',
        '-nf', '-oj', '-of', output, '--prompt', '以下是简体中文歌词。'], { windowsHide: true, signal });
      let log = '', timer;
      child.stdout.on('data', () => {});
      child.stderr.on('data', b => { log = (log + b).slice(-2000); });
      child.once('error', error => { clearTimeout(timer); if (error.name !== 'AbortError') reject(error); });
      child.once('close', code => { clearTimeout(timer); if (signal?.aborted) reject(signal.reason); else code === 0 ? resolve() : reject(new Error('歌词转写失败: ' + log)); });
      timer = setTimeout(() => { child.kill(); }, 60000);
    });
    const result = JSON.parse(await fs.promises.readFile(output + '.json', 'utf8'));
    return (result.transcription || []).map(s => ({ text: s.text, from: s.offsets?.from / 1000, to: s.offsets?.to / 1000 }));
  } finally {
    for (const file of [input, output + '.json']) await fs.promises.unlink(file).catch(() => {});
    await fs.promises.rmdir(dir).catch(() => {});
  }
}
const searchCache = new Map();
let searchQueue = Promise.resolve(), nextSearchAt = 0;
function queuedSearch(task, signal) {
  const pending = searchQueue.then(async () => {
    signal?.throwIfAborted();
    await require('node:timers/promises').setTimeout(Math.max(0, nextSearchAt - Date.now()), undefined, { signal });
    try { return await task(); } finally { nextSearchAt = Math.max(nextSearchAt, Date.now() + 1200); }
  });
  searchQueue = pending.catch(() => {});
  return waitFor(pending, signal);
}
async function searchLyrics(segments, request = fetch, dispatcher, signal) {
  const phrases = lyricPhrases(segments);
  const queries = phrases.slice().sort((a, b) => Math.abs(a.length - 10) - Math.abs(b.length - 10)).slice(0, 6);
  const songs = new Map();
  for (const phrase of queries) {
    signal?.throwIfAborted();
    let list = searchCache.get(phrase);
    if (!list) {
      list = await queuedSearch(async () => {
        try { signal?.throwIfAborted(); return await searchNeteaseLyrics(phrase, request, dispatcher, signal); }
        catch (error) {
          if ([405, 429].includes(error.serviceCode)) nextSearchAt = Date.now() + 30000;
          throw error;
        }
      }, signal);
      searchCache.set(phrase, list);
      if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    }
    for (const song of list) songs.set(song.id, song);
    const match = chooseLyricMatch(segments, [...songs.values()]);
    if (match) return { match, candidates: [...songs.values()] };
  }
  return { match: chooseLyricMatch(segments, [...songs.values()]), candidates: [...songs.values()] };
}
async function identifyLyricsForTrack({ ffmpeg, source, track, resourceRoot, request, dispatcher, onTranscript, signal }) {
  const segments = [];
  const length = Math.min(30, track.end - track.start - 6);
  if (length < 12 || !lyricsAvailable(resourceRoot)) return null;
  for (const ratio of [0.4, 0.65]) {
    signal?.throwIfAborted();
    const at = track.start + 3 + Math.max(0, track.end - track.start - 6 - length) * ratio;
    const pcm = await decodeLyricClip(ffmpeg, source, at, length, signal);
    const transcript = await transcribePcm(pcm, 16000, resourceRoot, signal);
    segments.push(...transcript);
    if (onTranscript) onTranscript({ at, transcript });
    const searched = await searchLyrics(segments, request, dispatcher, signal);
    if (searched.match) return searched.match;
  }
  return null;
}
module.exports = { normalize, lyricPhrases, rankLyrics, chooseLyricMatch, lyricsAvailable, decodeLyricClip, transcribePcm, searchLyrics, identifyLyricsForTrack };
