const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
async function run() {
  const { waitFor } = require('../cancellation.cjs');
  const queuedAbort = new AbortController(); let rejectLater;
  const waiting = waitFor(new Promise((_resolve, reject) => { rejectLater = reject; }), queuedAbort.signal);
  queuedAbort.abort(); await assert.rejects(waiting, /abort/i);
  rejectLater(new Error('cancelled queued operation')); await new Promise(setImmediate);
  assert.equal(require('node:events').getEventListeners(queuedAbort.signal, 'abort').length, 0);
  const controller = new AbortController(), processTools = require('node:child_process'), spawn = processTools.spawn;
  let child;
  processTools.spawn = (...args) => { child = spawn(...args); setTimeout(() => controller.abort(), 30); return child; };
  const { transcribePcm } = require('../lyric-recognition.cjs');
  processTools.spawn = spawn;
  const dirs = () => new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('ccmusic-lyrics-')));
  const before = dirs();
  await assert.rejects(transcribePcm(Buffer.alloc(16000 * 2 * 15), 16000, path.resolve(__dirname, '../resources'), controller.signal), /abort/i);
  assert.ok(child, 'the real whisper child must have started');
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'cancellation waits for the child to stop');
  assert.deepEqual([...dirs()].filter(name => !before.has(name)), [], 'temporary WAV and JSON removed after process exit');
  console.log('PASS: queued cancellation detaches listeners and handles late errors; real whisper stops before temp cleanup; silent PCM, no network/playback');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
