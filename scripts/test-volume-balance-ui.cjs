// Actual renderer integration with silent, deterministic Web Audio/media mocks.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
function mockAudio() {
  window.testAudioReadyState = 4; window.testRms = 0.1; window.testSeeking = false;
  Object.defineProperty(HTMLMediaElement.prototype, 'seeking', { get: () => window.testSeeking });
  class Param {
    constructor() { this.value = 1; }
    cancelAndHoldAtTime() {} cancelScheduledValues() {}
    setValueAtTime(value) { this.value = value; }
    setTargetAtTime(value) { this.value = value; }
  }
  class Node {
    constructor() {
      this.connections = new Set();
      for (const p of ['gain', 'threshold', 'knee', 'ratio', 'attack', 'release', 'frequency', 'Q']) this[p] = new Param();
    }
    connect(node) { this.connections.add(node); return node; }
    disconnect(node) { this.connections.delete(node); }
    getFloatTimeDomainData(buffer) { buffer.fill(window.testRms); }
  }
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.destination = new Node(); }
    get currentTime() { return Date.now() / 1000; }
    createMediaElementSource() { return new Node(); }
    createGain() { return new Node(); } createDynamicsCompressor() { return new Node(); }
    createBiquadFilter() { return new Node(); } createChannelSplitter() { return new Node(); }
    createAnalyser() { return new Node(); } createWaveShaper() { return new Node(); }
    async resume() { this.state = 'running'; }
  };
}
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name);
      if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge); await page.addInitScript(mockAudio);
    await page.goto('http://ccmusic.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.clock.install();
    const read = () => page.evaluate(() => ({ key: balanceKey, reference: balanceController.reference, samples: balanceController.samples, gain: balanceGraph.gain.gain.value, master: balanceGraph.master.gain.value, native: audio.volume }));
    const play = item => page.evaluate(async item => { window.volumeItem = item; return playTrack(item); }, item);
    const item = { bvid: 'volume', cid: 1, page: 1, title: '音量测试', duration: 300 };
    assert.equal(await play(item), true);
    assert.equal((await read()).native, 1);
    await page.clock.runFor(5500);
    let measured = await read(); assert.ok(Math.abs(measured.reference + 20) < 0.01); assert.ok(measured.samples >= 45);
    assert.ok(Math.abs(measured.gain - 10 ** (6 / 20)) < 0.001, 'measured -20 dB song receives the new +6 dB gain');
    const reference = measured.reference;
    await page.evaluate(() => { $('#vol').value = '50'; $('#vol').dispatchEvent(new Event('input')); });
    await page.clock.runFor(2000);
    measured = await read(); assert.equal(measured.master, 0.25); assert.equal(measured.reference, reference);
    assert.equal(await page.evaluate(() => localStorage.savedVolume), '0.25');
    await page.evaluate(() => { $('#vol').value = '100'; $('#vol').dispatchEvent(new Event('input')); });
    measured = await read(); assert.equal(measured.master, 1, 'maximum fader does not add another attenuation stage');
    assert.equal(measured.reference, reference, 'higher user volume does not change the learned song loudness');
    await page.evaluate(() => { $('#vol').value = '0'; $('#vol').dispatchEvent(new Event('input')); });
    assert.equal((await read()).master, 0, 'mute remains mute');
    await page.evaluate(() => { audio.pause(); window.testRms = 0.6; });
    const paused = (await read()).samples; await page.clock.runFor(2000); assert.equal((await read()).samples, paused);
    await page.evaluate(() => { audio.play(); window.testSeeking = true; });
    await page.clock.runFor(1000); assert.equal((await read()).samples, paused, 'seeking cannot pollute learned loudness');
    await page.evaluate(() => { window.testSeeking = false; window.testRms = 0.1; });
    await page.clock.runFor(5000);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.volumeReferencesV1).length), 1);
    // Recovery URL preserves the same song reference, even after metadata edits.
    await play({ ...item, title: '手改标题' }); assert.equal((await read()).reference, reference);
    await page.evaluate(() => { window.testRms = 0; });
    await play({ ...item, cid: 2, page: 2 });
    assert.equal((await read()).reference, null, 'new P must not inherit another song gain');
    await page.clock.runFor(6500); assert.equal((await read()).reference, null);
    await page.evaluate(() => { window.testRms = 0.01; });
    await page.clock.runFor(4000);
    assert.ok((await read()).gain > 3, 'quiet song after a long intro is still measured and boosted');
    await play({ ...item, split: true, startSec: 20, endSec: 60 }); assert.equal((await read()).reference, null);
    await page.clock.runFor(4000);
    await play({ ...item, split: true, startSec: 60, endSec: 100 }); assert.equal((await read()).reference, null, 'new split gets its own reference');
    await play(item); assert.equal((await read()).reference, reference, 'replay uses cached reference before any metering');
    assert.ok(Math.abs((await read()).gain - 10 ** (6 / 20)) < 0.001, 'cached reference uses the higher target immediately');
    await page.evaluate(() => { $('#volumeBalance').checked = false; $('#volumeBalance').dispatchEvent(new Event('change')); });
    assert.equal(await page.evaluate(() => agcTimer), null);
    assert.equal(await page.evaluate(() => srcNode.connections.has(balanceGraph.master) && !srcNode.connections.has(balanceGraph.gain)), true);
    await page.reload(); await page.locator('#folders .folder').first().waitFor();
    assert.equal(await page.evaluate(() => balanceOn()), false, 'explicit opt-out persists');
    await play(item); assert.equal(await page.evaluate(() => agcTimer), null);
    await page.evaluate(() => { $('#volumeBalance').checked = true; $('#volumeBalance').dispatchEvent(new Event('change')); });
    assert.equal((await read()).reference, reference, 'reference survives restart');
    assert.equal((await read()).master, 0, 'user mute survives restart');
    await page.evaluate(() => clearQueue());
    assert.equal(await page.evaluate(() => agcTimer), null);
    assert.deepEqual(errors, []);
    console.log('PASS: actual renderer volume routing, user fader/mute, pause/seek gates, long quiet intro, multi-P/split isolation, recovery/replay cache, preference/restart and queue cleanup; no audible output');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
