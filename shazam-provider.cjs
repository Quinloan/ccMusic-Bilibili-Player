// Node/WASM provider: no Python runtime or user credentials.
function pcmWav(pcm, rate = 8000) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
let client;
async function identifyShazam(pcm, rate = 8000, signal) {
  if (!client) {
    const { Shazam } = require('shazamio-api');
    client = new Shazam({ language: 'zh-CN' });
  }
  signal?.throwIfAborted();
  const result = await client.recognize(pcmWav(pcm, rate), { seconds: 12, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  if (!result.matches?.length || !result.track?.title) return null;
  return { name: result.track.title, artist: result.track.subtitle || '', source: 'shazam', cover: result.track.images?.coverart || '' };
}
module.exports = { pcmWav, identifyShazam };
