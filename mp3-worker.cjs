// CPU-heavy encoding runs off the Electron main thread. No network or playback.
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
(async () => {
  const { createMp3Encoder } = require('wasm-media-encoders');
  const encoder = await createMp3Encoder();
  encoder.configure({ channels: 2, sampleRate: 44100, outputSampleRate: 44100, bitrate: 320 });
  const input = fs.openSync(workerData.input, 'r'), output = fs.openSync(workerData.output, 'wx');
  try {
    const frames = [];
    for (const [key, value] of [['TIT2', workerData.title], ['TPE1', workerData.artist]]) {
      if (!value) continue;
      const data = Buffer.concat([Buffer.from([1, 255, 254]), Buffer.from(String(value), 'utf16le')]);
      const head = Buffer.alloc(10); head.write(key); head.writeUInt32BE(data.length, 4); frames.push(head, data);
    }
    const tags = Buffer.concat(frames), header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) header[9 - i] = (tags.length >>> (i * 7)) & 127;
    fs.writeSync(output, header); fs.writeSync(output, tags);
    const samples = 1152 * 32, buffer = Buffer.alloc(samples * 4);
    const left = new Float32Array(samples), right = new Float32Array(samples);
    const total = fs.fstatSync(input).size; let n, consumed = 0, lastUpdate = 0;
    while ((n = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      if (n % 4) throw Error('PCM 数据不完整');
      for (let i = 0; i < n / 4; i++) { left[i] = buffer.readInt16LE(i * 4) / 32768; right[i] = buffer.readInt16LE(i * 4 + 2) / 32768; }
      // encode() returns WASM-owned memory; consume it before the next call.
      fs.writeSync(output, encoder.encode([left.subarray(0, n / 4), right.subarray(0, n / 4)]));
      consumed += n;
      if (Date.now() - lastUpdate >= 250) { parentPort.postMessage(Math.min(99, Math.floor(consumed / total * 100))); lastUpdate = Date.now(); }
    }
    fs.writeSync(output, encoder.finalize());
    parentPort.postMessage(100);
  } finally { fs.closeSync(input); fs.closeSync(output); }
})().catch(error => { throw error; });
