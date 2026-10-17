const assert = require('node:assert/strict');
const { splitRms, PcmSampler, selectSamples } = require('../audio-analysis.cjs');
const { timestampTracks } = require('../audio-analysis.cjs');
const { consistentMatch, mergeRecognizedFragments } = require('../audio-analysis.cjs');
const hit = { name: '悬溺', artist: '葛东琪', source: 'netease' };
assert.equal(consistentMatch([{ name: '精选流行轻音乐连歌' }, { name: '精选流行轻音乐连歌' }]), null);
assert.equal(consistentMatch([{ name: '花海1755067924583(1)' }, { name: '花海1755067924583(1)' }]), null);
assert.equal(consistentMatch([hit, null, { name: 'Wrong', artist: '' }]), null);
assert.equal(consistentMatch([hit, null, hit]), hit);
assert.equal(mergeRecognizedFragments([
  { start: 0, end: 84, title: hit.name, artist: hit.artist },
  { start: 84, end: 192, title: hit.name, artist: hit.artist },
]).length, 1);
const { pcmWav } = require('../shazam-provider.cjs');
const wav = pcmWav(Buffer.alloc(8000 * 2 * 12));
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.readUInt32LE(24), 8000);
assert.equal(wav.readUInt32LE(40), 192000);
// WASM must decode exactly the same sample rate/container sent by the product.
const signatures = require('shazamio-core').recognizeBytes(new Uint8Array(wav), 0, 12);
try { assert.ok(signatures.length > 0); assert.ok(Math.abs(signatures[0].samplems - 12000) < 100); }
finally { signatures.forEach(s => s.free()); }
assert.deepEqual(timestampTracks('00:00 第一首\n03:20 第二首', 400).map(t => [t.start, t.end]), [[0, 200], [200, 400]]);
assert.equal(timestampTracks('03:20 示例\n01:20 示例', 400), null);
assert.equal(timestampTracks('12:99 错误\n03:20 示例', 400), null);
const envelope = (seconds, level = 0.2) => Array(seconds * 10).fill(level);
const rms = envelope(400);
rms.fill(0.01, 1996, 2004); // 800ms low valley: previously missed.
rms[2000] = 0.1; // brief noise must not hide the transition.
let result = splitRms(rms, 400);
assert.equal(result.tracks.length, 2);
assert.equal(result.tracks[0].end, 200);
assert.equal(result.tracks[1].end, 400);
assert.equal(splitRms(envelope(400), 400).tracks.length, 1);
const tail = envelope(240); tail.fill(0, 2095, 2105);
result = splitRms(tail, 240);
assert.equal(result.tracks.at(-1).end, 240); // no dropped short tail
const quiet = envelope(400, 0.02); quiet.fill(0.0005, 1995, 2005);
assert.equal(splitRms(quiet, 400).tracks.length, 2);
const inside = envelope(400); inside.fill(0, 1999, 2002);
assert.equal(splitRms(inside, 400).tracks.length, 1); // 300ms is not a boundary
const competing = envelope(600);
competing.fill(0.015, 2796, 2804); // weaker intra-song pause
competing.fill(0.0001, 3190, 3210); // strong real boundary 40 seconds later
assert.deepEqual(splitRms(competing, 600).tracks.map(t => t.end), [320, 600]);
const pcm = Buffer.alloc(8000 * 2 * 80);
for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
const sampler = new PcmSampler();
for (let i = 0; i < pcm.length; i += 65537) sampler.push(pcm.subarray(i, i + 65537));
for (const sample of sampler.samples) {
  assert.equal(sample.pcm.length, 8000 * 2 * 12);
  assert.deepEqual(sample.pcm, pcm.subarray(sample.from * 16000, sample.at * 16000));
}
const selected = selectSamples(sampler.samples, { start: 0, end: 80 });
assert.equal(new Set(selected).size, 3);
assert.ok(selected.every(s => s.from >= 3 && s.at <= 77));
console.log('PASS: short/noisy gaps, quiet mastering, no gap, short tail, exact PCM windows and distinct in-track samples');
