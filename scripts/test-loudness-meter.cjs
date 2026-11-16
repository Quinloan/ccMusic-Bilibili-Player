// Standards/calibration, programme dynamics and real AudioWorklet graph; no audible output.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const M = require('../renderer/loudness-meter.js'), V = require('../renderer/volume-balance.js');
const root = path.resolve(__dirname, '..');
function tone(rate, seconds, level, hz = 1000) {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => level * Math.sin(2 * Math.PI * hz * i / rate));
}
for (const rate of [44100, 48000, 96000]) {
  const samples = tone(rate, 4, .1), levels = [], meter = M.createMeter(rate, level => levels.push(level));
  // Odd callback sizes exercise block boundaries independently of UI polling.
  for (let i = 0; i < samples.length; i += 137) meter.process([samples.subarray(i, i + 137), samples.subarray(i, i + 137)]);
  assert.equal(levels.length, 37);
  const lu = -.691 + 20 * Math.log10(levels.at(-1));
  assert(Math.abs(lu + 20) < .06, '1 kHz stereo sine, peak -20 dBFS calibrates to -20 LUFS: ' + rate + ' ' + lu);
  meter.reset(); levels.length = 0; meter.process([samples.subarray(0, Math.round(rate * .3))]);
  assert.equal(levels.length, 0, 'seek reset discards prior partial blocks');
}
const plain = V.createController(), burst = V.createController();
for (let i = 0; i < 1200; i++) { plain.push(.1); burst.push(i < 20 ? .3 : .1); }
assert(Math.abs(plain.reference - burst.reference) < 1, 'brief loud passage is averaged, never held as the permanent reference');
const bridge = V.createController();
for (let i = 0; i < 200; i++) bridge.push(.1);
const gain = bridge.db;
for (let i = 0; i < 600; i++) bridge.push(.01);
assert(Math.abs(bridge.db - gain) < .01, 'one-minute quiet bridge retains musical dynamics');
const corrected = V.createController(-5);
for (let i = 0; i < 2000; i++) corrected.push(.1);
assert(Math.abs(corrected.db - plain.db) < .01, 'cached mistakes can correct in either direction');
const limit = M.createLimiter(48000), input = [new Float32Array(24000), new Float32Array(24000)], output = input.map(row => new Float32Array(row.length));
for (let i = 0; i < input[0].length; i++) { input[0][i] = i < 1200 ? (1200 - i) / 150 : Math.sin(i / 10) * .1; input[1][i] = i % 997 === 0 ? -7 : .05; }
limit(input, output);
assert(Math.max(...output.flatMap(row => Array.from(row, Math.abs))) < .971, 'stereo-linked limiter contains transients and descending peak windows');
const transparent = M.createLimiter(48000), low = tone(48000, 1, .3), out = [new Float32Array(low.length), new Float32Array(low.length)];
transparent([low, low], out);
for (let i = 240; i < low.length; i++) assert.equal(out[0][i], low[i - 240], 'under-ceiling signal is unchanged except 5 ms lookahead');

async function workletChecks() {
  const server = require('node:http').createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.statusCode = 204; return response.end(); }
    if (request.url === '/renderer/index.html') { response.setHeader('Content-Type', 'text/html'); return response.end('<!doctype html><html></html>'); }
    if (request.url !== '/renderer/loudness-meter.js') { response.statusCode = 404; return response.end(); }
    response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(root, 'renderer/loudness-meter.js')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') console.log('Browser:', message.text()); });
    await page.goto('http://127.0.0.1:' + server.address().port + '/renderer/index.html');
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'renderer/loudness-meter.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'renderer/volume-balance.js'), 'utf8') });
    const result = await page.evaluate(async () => {
      const records = [];
      for (const level of [.6, .06]) {
        const rate = 48000, duration = 12, context = new OfflineAudioContext(2, rate * duration, rate);
        const buffer = context.createBuffer(2, rate * duration, rate);
        for (let c = 0; c < 2; c++) for (let i = 0; i < buffer.length; i++) buffer.getChannelData(c)[i] = level * Math.sin(2 * Math.PI * 1000 * i / rate);
        const source = context.createBufferSource(); source.buffer = buffer;
        const graph = VolumeBalance.createGraph(context, source), control = VolumeBalance.createController();
        await graph.ready;
        if (!graph.continuous) throw new Error('Test requires actual AudioWorklet, not the snapshot fallback');
        graph.setEnabled(true); graph.resetMeter();
        const failures = []; context.addEventListener('processorerror', e => failures.push(String(e)));
        const waits = [];
        for (let tick = 1; tick < duration * 10; tick++) waits.push(context.suspend(tick / 10).then(async () => {
          await new Promise(resolve => setTimeout(resolve, 0));
          for (const value of graph.takeMeasurements()) control.push(value);
          graph.setDb(control.db); await context.resume();
        }));
        source.start(); const rendered = await context.startRendering(); await Promise.all(waits);
        const outputMeter = VolumeBalance.createController(), meter = LoudnessMeter.createMeter(rate, value => outputMeter.push(value));
        meter.process([rendered.getChannelData(0).subarray(rate * 9), rendered.getChannelData(1).subarray(rate * 9)]);
        records.push({ level, reference: control.reference, samples: control.samples, output: outputMeter.reference, continuous: graph.continuous, failures });
      }
      return records;
    });
    for (const row of result) { assert(row.continuous); assert(row.samples >= 100); assert(Math.abs(row.output - V.TARGET_DB) < .4, JSON.stringify(row)); assert.deepEqual(row.failures, []); }
    assert(Math.abs(result[0].output - result[1].output) < .2);
    const localFile = path.join(root, 'validation/loudness-file-probe.html');
    try {
      fs.writeFileSync(localFile, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' data:"><base href="../renderer/"><script src="loudness-meter.js"></script><script src="volume-balance.js"></script>');
      await page.goto(require('node:url').pathToFileURL(localFile).href);
      assert(await page.evaluate(async () => {
        const context = new OfflineAudioContext(2, 48000, 48000), source = context.createBufferSource();
        const graph = VolumeBalance.createGraph(context, source); await graph.ready; return graph.continuous;
      }), 'file:// loading with desktop CSP uses the continuous meter');
    } finally { fs.unlinkSync(localFile); }
    fs.writeFileSync(path.join(root, 'validation/loudness-worklet.json'), JSON.stringify(result, null, 2));
    console.log('PASS 44.1/48/96 kHz calibration, 400ms/75% blocks, gated quiet bridges, loud outlier recovery, bidirectional cache correction, transparent/peak-safe lookahead and real offline AudioWorklet normalized outputs', result);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
workletChecks().catch(error => { console.error(error); process.exitCode = 1; });
