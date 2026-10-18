// Silent OfflineAudioContext renders the real audio graph; never plays media.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const V = require('../renderer/volume-balance.js');
async function run() {
  const controller = V.createController();
  for (let n = 0; n < 100; n++) controller.push(0);
  assert.equal(controller.reference, null); assert.equal(controller.db, V.INITIAL_DB);
  for (let n = 0; n < 30; n++) controller.push(0.1);
  assert(Math.abs(controller.db) < 1e-8);
  for (let n = 0; n < 200; n++) controller.push(0.01);
  assert(Math.abs(controller.db) < 1e-8, 'quiet bridges/fades do not get chased upwards');
  assert.equal(V.createController(-45).db, V.MAX_DB); assert.equal(V.createController(2).db, V.MIN_DB);
  assert.equal(V.createController(NaN).reference, null);
  assert.equal(V.rms([new Float32Array([0.5,-0.5]), new Float32Array([-0.5,0.5])]), 0.5);
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../renderer/volume-balance.js'), 'utf8') });
    const result = await page.evaluate(async () => {
      async function render({ level = 0.6, duration = 9, intro = 0, antiPhase = false, volume = 1, enabled = true, changeVolume = false, bridge = false, impulse = false, cached } = {}) {
        const rate = 48000, context = new OfflineAudioContext(2, duration * rate, rate);
        const input = context.createBuffer(2, duration * rate, rate);
        for (let i = 0; i < input.length; i++) {
          const t = i / rate, wave = 0.65 * Math.sin(2 * Math.PI * 440 * t) + 0.22 * Math.sin(2 * Math.PI * 880 * t) + 0.13 * Math.sin(2 * Math.PI * 1760 * t);
          const sample = impulse ? (i % 24000 === 12000 ? 1 : wave * 0.01) : t < intro ? 0 : level * wave * (bridge && t > 4 ? 0.25 : 1);
          input.getChannelData(0)[i] = sample; input.getChannelData(1)[i] = antiPhase ? -sample : sample;
        }
        const source = context.createBufferSource(); source.buffer = input;
        const graph = VolumeBalance.createGraph(context, source, volume), control = VolumeBalance.createController(cached);
        graph.setEnabled(enabled); graph.setDb(impulse ? 12 : control.db, true);
        const readings = [], waits = [];
        for (let tick = 1; tick < duration * 10 - 1; tick++) waits.push(context.suspend(tick / 10).then(() => {
          const level = graph.measure();
          if (enabled && !impulse) graph.setDb(control.push(level));
          if (changeVolume && tick === 50) graph.setVolume(0.25);
          readings.push({ time: context.currentTime, level, db: control.db }); context.resume();
        }));
        source.start(); const output = await context.startRendering(); await Promise.all(waits);
        function rms(from, to) {
          const data = output.getChannelData(0); let sum = 0;
          for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) sum += data[i] ** 2;
          return Math.sqrt(sum / Math.round((to - from) * rate));
        }
        let peak = 0; for (const sample of output.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
        return { outputDb: 20 * Math.log10(rms(duration - 2, duration)), reference: control.reference, gainDb: control.db, peak,
          firstHalfDb: 20 * Math.log10(rms(3,4)), earlyDb: 20 * Math.log10(rms(0.1,0.3)), reading3: readings.find(r => r.time >= 3), samples: control.samples };
      }
      const loud = await render(), quiet = await render({ level: 0.06 });
      const intro = await render({ level: 0.06, duration: 14, intro: 6 });
      const antiPhase = await render({ antiPhase: true });
      const fader = await render({ changeVolume: true });
      const bypass = await render({ enabled: false }), bypassQuarter = await render({ enabled: false, volume: 0.25 });
      const bridge = await render({ bridge: true }), cached = await render({ cached: loud.reference });
      const safety = await render({ impulse: true });
      return { loud, quiet, intro, antiPhase, fader, bypass, bypassQuarter, bridge, cached, safety };
    });
    fs.mkdirSync(path.join(__dirname, '../validation'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '../validation/volume-balance-offline.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    assert(Math.abs(result.loud.outputDb - result.quiet.outputDb) < 1, '20 dB recording difference converges within 1 dB');
    assert(Math.abs(result.intro.outputDb - result.quiet.outputDb) < 1, 'silent intro longer than five seconds still gets normalized');
    assert(Math.abs(result.antiPhase.outputDb - result.loud.outputDb) < 0.05, 'anti-phase stereo is not misread as silence');
    assert(Math.abs(result.fader.gainDb - result.loud.gainDb) < 0.05, 'fader does not change the measurement/reference');
    assert(Math.abs(result.fader.outputDb - result.loud.outputDb + 12.0412) < 0.2, 'quarter volume stays quarter volume');
    assert(Math.abs(result.bypass.outputDb - result.bypassQuarter.outputDb - 12.0412) < 0.05);
    assert(Math.abs(result.bridge.gainDb - result.loud.gainDb) < 0.5, 'quiet passages retain the song gain');
    assert(Math.abs(result.bridge.outputDb - result.bridge.firstHalfDb + 12.0412) < 1);
    assert(result.cached.earlyDb < result.loud.earlyDb - 3, 'cached loud tracks start attenuated immediately');
    assert(result.safety.peak < 1, 'peak protection keeps a 12 dB boosted transient below full scale');
    console.log('PASS: real silent Web Audio graph; 20 dB source difference, late intro, stereo phase, user fader, bypass, musical dynamics, cache startup and peak protection');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
