// Native codec/export compatibility audit. Synthetic tones only; no playback/network.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { convertAudio, outputFormat } = require('../audio-downloads.cjs');
const root = path.resolve(__dirname, '..');
const artifact = path.join(root, 'build-tools/cloud-artifact');
const candidate = process.env.CCMUSIC_FFMPEG || path.join(artifact, 'ffmpeg.exe');
const backup = path.join(root, 'build-tools/download-audio-original/ffmpeg.exe');
const reference = process.env.CCMUSIC_REFERENCE_FFMPEG || (fs.existsSync(backup) ? backup : path.join(root, 'resources/download-audio/ffmpeg.exe'));
const dir = path.join(root, 'validation/ffmpeg-audio-compat');
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function run(exe, args, input) {
  const result = spawnSync(exe, ['-v', 'error', ...args], { windowsHide: true, input, maxBuffer: 10 * 1024 * 1024, timeout: 60000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr?.toString());
  return result.stdout;
}
const decode = (exe, file, rate = 8000) => run(exe, ['-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']);
async function main() {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(artifact, 'download-manifest.json')));
  assert.equal(await digest(candidate), manifest.exe_sha256);
  assert(manifest.bytes < 15 * 1024 * 1024);
  for (const [name, sha] of Object.entries(manifest.files)) {
    assert.equal(path.basename(name), name);
    assert.equal(await digest(path.join(artifact, name)), sha, name);
  }
  const license = run(candidate, ['-hide_banner', '-L']).toString();
  assert.match(license, /version 2\.1/); assert(!license.includes('GNU General Public License'));
  const config = fs.readFileSync(path.join(artifact, 'config.h'), 'utf8');
  for (const feature of ['GPL', 'VERSION3', 'NONFREE', 'NETWORK', 'AVDEVICE', 'SWSCALE']) assert.match(config, new RegExp('^#define CONFIG_' + feature + ' 0$', 'm'));
  const version = run(candidate, ['-version']).toString().split('\n')[0];
  assert(version.includes(manifest.revision));
  const source = path.join(root, 'scripts/fixtures/tone-aac.m4a');
  const cases = [
    { name: 'AAC in MP4', file: source, track: { codecs: 'mp4a.40.2' } },
    { name: 'FLAC', nameOnDisk: 'source.flac', args: ['-c:a', 'flac', '-sample_fmt', 's32'], track: { codecs: 'fLaC', lossless: true } },
    { name: 'FLAC in MP4', nameOnDisk: 'flac.m4a', args: ['-c:a', 'flac', '-strict', '-2'], track: { codecs: 'fLaC', lossless: true } },
    { name: 'Opus in Ogg', nameOnDisk: 'source.opus', args: ['-c:a', 'libopus'], track: { codecs: 'opus' } },
    { name: 'Opus in MP4', nameOnDisk: 'opus.m4a', args: ['-c:a', 'libopus'], track: { codecs: 'opus' } },
    { name: 'EAC3 in MP4', nameOnDisk: 'dolby.m4a', args: ['-c:a', 'eac3'], track: { codecs: 'ec-3' } },
    { name: 'Vorbis in Ogg', nameOnDisk: 'source.ogg', args: ['-c:a', 'libvorbis'] },
    { name: 'MP3', nameOnDisk: 'source.mp3', args: ['-c:a', 'libmp3lame'] },
    { name: 'WAV 44.1k stereo', nameOnDisk: 'source.wav', args: ['-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2'] },
    { name: 'AAC ADTS', nameOnDisk: 'source.aac', args: ['-c:a', 'aac', '-f', 'adts'] },
  ];
  const report = { version, bytes: manifest.bytes, sha256: manifest.exe_sha256, license: manifest.license, run: manifest.run_url, cases: [] };
  for (const item of cases) {
    const file = item.file || path.join(dir, item.nameOnDisk);
    if (!item.file) run(reference, ['-y', '-i', source, ...item.args, ...(file.endsWith('.m4a') ? ['-f', 'mp4', '-movflags', '+faststart'] : []), file]);
    const pcm = decode(candidate, file), expected = decode(reference, file);
    assert.equal(pcm.length, expected.length, item.name + ' decoded duration');
    let squares = 0;
    for (let i = 0; i < pcm.length; i += 2) squares += (pcm.readInt16LE(i) - expected.readInt16LE(i)) ** 2;
    const rmse = Math.sqrt(squares / (pcm.length / 2)); assert(rmse < 2, item.name + ' audio error: ' + rmse);
    const pipe = run(candidate, ['-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], fs.readFileSync(file));
    assert(pipe.length > 0, item.name + ' analysis pipe must decode audio');
    // A nonseekable MP4 pipe can retain padding which seekable file input trims.
    // Compare like-for-like with the old binary's pipe behavior.
    const expectedPipe = run(reference, ['-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], fs.readFileSync(file));
    assert.equal(pipe.length, expectedPipe.length, item.name + ' pipe duration vs original runtime');
    let pipeSquares = 0;
    for (let i = 0; i < pipe.length; i += 2) pipeSquares += (pipe.readInt16LE(i) - expectedPipe.readInt16LE(i)) ** 2;
    const pipeRmse = Math.sqrt(pipeSquares / (pipe.length / 2)); assert(pipeRmse < 2, item.name + ' pipe audio error: ' + pipeRmse);
    const row = { codec: item.name, decodedBytes8k: pcm.length, referenceRmse: rmse, pipeBytes8k: pipe.length, pipeReferenceRmse: pipeRmse };
    const signal = new AbortController().signal;
    const metadata = { title: '修正后的翻唱歌名', artist: '实际翻唱者' };
    const split = path.join(dir, item.name.replace(/\W/g, '') + '-split.flac');
    fs.rmSync(split, { force: true });
    await convertAudio({ executable: candidate, input: file, output: split, track: item.track || {}, item: { ...metadata, split: true, startSec: 1, endSec: 2.25 }, signal });
    assert.equal(decode(candidate, split).length, 20000, item.name + ' exact 1.25s segment');
    const tags = run(reference, ['-i', split, '-f', 'ffmetadata', 'pipe:1']).toString('utf8');
    assert(tags.includes('title=' + metadata.title)); assert(tags.includes('artist=' + metadata.artist));
    assert.equal(decode(candidate, split, 16000).length, 40000, item.name + ' transcription 16k input');
    row.exactSegmentSeconds = 1.25; row.editedTagsRetained = true;
    if (item.track) {
      const output = path.join(dir, item.name.replace(/\W/g, '') + '-whole.' + outputFormat(item.track, false).extension);
      fs.rmSync(output, { force: true });
      await convertAudio({ executable: candidate, input: file, output, track: item.track, item: metadata, signal });
      const expectedOutput = output + '.reference.' + outputFormat(item.track, false).extension;
      fs.rmSync(expectedOutput, { force: true });
      await convertAudio({ executable: reference, input: file, output: expectedOutput, track: item.track, item: metadata, signal });
      const remuxPcm = decode(candidate, output);
      assert(remuxPcm.equals(decode(candidate, expectedOutput)), item.name + ' remux differs from original runtime');
      const packets = filename => run(reference, ['-i', filename, '-map', '0:a:0', '-c:a', 'copy', '-f', 'data', 'pipe:1']);
      assert(packets(output).equals(packets(file)), item.name + ' remux changed encoded audio packets');
      row.remuxRetainsEncodedPackets = true; row.remuxMatchesOriginalRuntime = true; row.remuxDecodedBytes8k = remuxPcm.length;
    }
    report.cases.push(row); console.log('PASS:', item.name);
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS: ' + cases.length + ' codec/container paths; source hashes, build flags, license, standalone Windows execution, analysis pipe, resampling, exact splits, edited tags, whole-audio copy');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
