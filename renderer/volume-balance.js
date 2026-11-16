// Playback loudness matching, independent of the user's volume fader.
// BS.1770 stereo K-weighting, 400 ms blocks and absolute/relative gating.
// Live playback measures the portion heard so far, not a pre-scanned whole file.
(function (root) {
  const Meter = typeof module === 'object' && module.exports ? require('./loudness-meter.js') : root.LoudnessMeter;
  // Music playback target, not the -23 LUFS broadcast delivery target.
  const MIN_DB = -18, MAX_DB = 18, TARGET_DB = -12, INITIAL_DB = -3;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const amplitude = db => 10 ** (db / 20);
  function rms(channels) {
    // Strongest channel avoids both anti-phase cancellation and a 3 dB mono bias.
    let energy = 0;
    for (const channel of channels) {
      let sum = 0;
      for (const value of channel) if (Number.isFinite(value)) sum += value * value;
      if (channel.length) energy = Math.max(energy, sum / channel.length);
    }
    return Math.sqrt(energy);
  }
  function createController(cachedReference) {
    const cached = Number.isFinite(cachedReference) && cachedReference >= -70 && cachedReference <= 10 ? cachedReference : null;
    let reference = cached, samples = 0, applied = cached === null ? INITIAL_DB : clamp(TARGET_DB - cached, MIN_DB, MAX_DB);
    // Bounded 0.1 LU histogram retains exact energy sums: no ever-loudest reference,
    // no moving window that starts boosting a quiet bridge after ten seconds.
    const counts = new Float64Array(1000), sums = new Float64Array(1000);
    let total = 0, energy = 0;
    return {
      get reference() { return reference; },
      get gainReference() { return reference === null ? null : TARGET_DB - applied; },
      get samples() { return samples; },
      get db() { return applied; },
      push(level) {
        if (!Number.isFinite(level) || level <= 0) return applied;
        const e = level * level, lu = -0.691 + 10 * Math.log10(e);
        if (lu < -70) return applied;
        const bin = clamp(Math.floor((lu + 70) * 10), 0, 999);
        counts[bin]++; sums[bin] += e; total++; energy += e; samples++;
        if (samples < 12) return applied;
        const gate = -0.691 + 10 * Math.log10(energy / total) - 10;
        let gatedEnergy = 0, gatedCount = 0;
        for (let i = Math.max(0, Math.ceil((gate + 70) * 10 - 0.5)); i < counts.length; i++) {
          gatedEnergy += sums[i]; gatedCount += counts[i];
        }
        if (!gatedCount) return applied;
        reference = -0.691 + 10 * Math.log10(gatedEnergy / gatedCount);
        const target = clamp(TARGET_DB - reference, MIN_DB, MAX_DB);
        if (samples === 12 && cached === null) applied = target;
        else if (cached === null || samples >= 150) {
          // Slow recalibration; never lift a quiet passage to chase the target.
          const change = target - applied;
          if (change <= 0 || lu >= reference - 8) applied += clamp(change, -0.1, 0.025);
        }
        return this.db;
      },
    };
  }
  function createGraph(context, source, volume = 1) {
    const gain = context.createGain(), limiter = context.createGain(), master = context.createGain();
    gain.gain.value = amplitude(INITIAL_DB);
    // Unity gain below the ceiling; no compressor's automatic makeup gain.
    // A 5 ms lookahead limiter runs in the worklet. A final soft ceiling
    // is linear below 0.95 and bounds samples before the user's fader.
    const headroom = context.createGain(), ceiling = context.createWaveShaper();
    headroom.gain.value = 1 / 8;
    const curve = new Float32Array(65537);
    for (let i = 0; i < curve.length; i++) {
      const x = (i * 2 / (curve.length - 1) - 1) * 8, level = Math.abs(x);
      curve[i] = Math.sign(x) * (level <= 0.95 ? level : 0.95 + 0.04 * (1 - Math.exp(-(level - 0.95) / 0.04)));
    }
    ceiling.curve = curve; ceiling.oversample = 'none';
    gain.connect(limiter); limiter.connect(headroom); headroom.connect(ceiling); ceiling.connect(master); master.connect(context.destination);
    master.gain.value = clamp(volume, 0, 1);
    // Meter filters are on a silent side chain; the music itself is not EQ'd.
    const meterInput = context.createGain(); meterInput.channelCount = 2; meterInput.channelCountMode = 'explicit';
    source.connect(meterInput);
    const filters = Meter.coefficients(context.sampleRate || 48000);
    const shelf = context.createIIRFilter(filters[0].b, filters[0].a), highpass = context.createIIRFilter(filters[1].b, filters[1].a);
    const splitter = context.createChannelSplitter(2), sink = context.createGain(); sink.gain.value = 0;
    meterInput.connect(shelf); shelf.connect(highpass); highpass.connect(splitter);
    const meters = [context.createAnalyser(), context.createAnalyser()];
    const buffers = meters.map(meter => { meter.fftSize = 32768; meter.connect(sink); return new Float32Array(meter.fftSize); });
    splitter.connect(meters[0], 0); splitter.connect(meters[1], 1); sink.connect(context.destination);
    let enabled, worklet = null, generation = 0, collecting = false, pending = [];
    function resetMeter(on = true) {
      generation++; collecting = on; pending = [];
      worklet?.port.postMessage({ generation, enabled: on });
    }
    // file:// and opaque-origin Blob module fetches fail CORS in Chromium.
    // Load only this bundled module's source via data:, no remote/eval code.
    const moduleUrl = context.audioWorklet ? 'data:text/javascript;charset=utf-8,' + encodeURIComponent(Meter.workletSource) : null;
    const ready = context.audioWorklet ? context.audioWorklet.addModule(moduleUrl).then(() => {
      worklet = new AudioWorkletNode(context, 'cc-loudness', { channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [1] });
      worklet.port.onmessage = ({ data }) => { if (collecting && data.generation === generation && pending.length < 100) pending.push(data.level); };
      worklet.onprocessorerror = () => {
        meterInput.disconnect(worklet); worklet.disconnect(); worklet = null; pending = [];
        meterInput.connect(shelf); console.warn('Loudness worklet stopped; using sampled K-weighting');
      };
      meterInput.connect(worklet); worklet.connect(sink);
      const peak = new AudioWorkletNode(context, 'cc-peak-limiter', { channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2] });
      limiter.disconnect(headroom); limiter.connect(peak); peak.connect(headroom);
      peak.onprocessorerror = () => { limiter.disconnect(peak); limiter.connect(headroom); console.warn('Peak worklet stopped; using sample ceiling'); };
      // Snapshot fallback is no longer needed once continuous metering is ready.
      meterInput.disconnect(shelf); resetMeter(collecting);
    }).catch(error => console.warn('Continuous loudness meter unavailable; using sampled K-weighting', error)) : Promise.resolve();
    function smooth(param, value, time) {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(context.currentTime);
      else { param.cancelScheduledValues(context.currentTime); param.setValueAtTime(param.value, context.currentTime); }
      param.setTargetAtTime(value, context.currentTime, time);
    }
    return {
      gain, limiter, master, ready, resetMeter,
      get continuous() { return !!worklet; },
      setEnabled(on) {
        if (enabled === on) return;
        try { source.disconnect(gain); } catch (_) {}
        try { source.disconnect(master); } catch (_) {}
        source.connect(on ? gain : master); enabled = on;
      },
      setVolume(value) { smooth(master.gain, clamp(value, 0, 1), 0.015); },
      setDb(db, immediate = false) {
        const value = amplitude(clamp(db, MIN_DB, MAX_DB));
        if (immediate) { gain.gain.cancelScheduledValues(context.currentTime); gain.gain.setValueAtTime(value, context.currentTime); }
        else smooth(gain.gain, value, value < gain.gain.value ? 0.25 : 0.7);
      },
      measure() {
        meters.forEach((meter, i) => meter.getFloatTimeDomainData(buffers[i]));
        const n = Math.min(buffers[0].length, Math.round((context.sampleRate || 48000) * 0.4));
        let energy = 0;
        for (const buffer of buffers) for (let i = buffer.length - n; i < buffer.length; i++) energy += buffer[i] * buffer[i] / n;
        return Math.sqrt(energy);
      },
      takeMeasurements() { if (!collecting) return []; if (!worklet) return [this.measure()]; const rows = pending; pending = []; return rows; },
    };
  }
  const api = { createController, createGraph, rms, amplitude, INITIAL_DB, MIN_DB, MAX_DB, TARGET_DB };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VolumeBalance = api;
})(globalThis);
