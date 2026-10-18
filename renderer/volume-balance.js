// Playback loudness matching, independent of the user's volume fader.
// Weighted RMS is an estimate, not a certified BS.1770/LUFS measurement.
(function (root) {
  const MIN_DB = -18, MAX_DB = 12, TARGET_DB = -20, INITIAL_DB = -6;
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
    let reference = Number.isFinite(cachedReference) && cachedReference >= -50 && cachedReference <= 6 ? cachedReference : null;
    let frames = [], samples = 0;
    return {
      get reference() { return reference; },
      get samples() { return samples; },
      get db() { return reference === null ? INITIAL_DB : clamp(TARGET_DB - reference, MIN_DB, MAX_DB); },
      push(level) {
        if (!Number.isFinite(level) || level < 10 ** (-50 / 20)) return this.db;
        const db = 20 * Math.log10(level);
        frames.push(db); if (frames.length > 100) frames.shift();
        samples++;
        if (frames.length < 8) return this.db;
        const ordered = frames.slice().sort((a, b) => a - b);
        const gate = ordered[Math.floor(ordered.length * 0.8)] - 10;
        const active = ordered.filter(value => value >= gate);
        const estimate = 10 * Math.log10(active.reduce((sum, value) => sum + 10 ** (value / 10), 0) / active.length);
        // Learn louder representative passages, but don't boost every quiet bridge,
        // fade-out or talking gap. New songs get a fresh reference.
        reference = reference === null ? estimate : Math.max(reference, estimate);
        return this.db;
      },
    };
  }
  function createGraph(context, source, volume = 1) {
    const gain = context.createGain(), limiter = context.createDynamicsCompressor(), master = context.createGain();
    gain.gain.value = amplitude(INITIAL_DB);
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.001; limiter.release.value = 0.15;
    // The compressor can overshoot on isolated transients. A final soft ceiling
    // is exactly linear below 0.85 and bounds samples before the user's fader.
    const headroom = context.createGain(), ceiling = context.createWaveShaper();
    headroom.gain.value = 1 / 8;
    const curve = new Float32Array(65537);
    for (let i = 0; i < curve.length; i++) {
      const x = (i * 2 / (curve.length - 1) - 1) * 8, level = Math.abs(x);
      curve[i] = Math.sign(x) * (level <= 0.85 ? level : 0.85 + 0.13 * (1 - Math.exp(-(level - 0.85) / 0.13)));
    }
    ceiling.curve = curve; ceiling.oversample = 'none';
    gain.connect(limiter); limiter.connect(headroom); headroom.connect(ceiling); ceiling.connect(master); master.connect(context.destination);
    master.gain.value = clamp(volume, 0, 1);
    // Meter filters are on a silent side chain; the music itself is not EQ'd.
    const highpass = context.createBiquadFilter(), shelf = context.createBiquadFilter();
    highpass.type = 'highpass'; highpass.frequency.value = 60; highpass.Q.value = 0.5;
    shelf.type = 'highshelf'; shelf.frequency.value = 1500; shelf.gain.value = 4;
    const splitter = context.createChannelSplitter(2), sink = context.createGain(); sink.gain.value = 0;
    source.connect(highpass); highpass.connect(shelf); shelf.connect(splitter);
    const meters = [context.createAnalyser(), context.createAnalyser()];
    const buffers = meters.map(meter => { meter.fftSize = 4096; meter.connect(sink); return new Float32Array(meter.fftSize); });
    splitter.connect(meters[0], 0); splitter.connect(meters[1], 1); sink.connect(context.destination);
    let enabled;
    function smooth(param, value, time) {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(context.currentTime);
      else { param.cancelScheduledValues(context.currentTime); param.setValueAtTime(param.value, context.currentTime); }
      param.setTargetAtTime(value, context.currentTime, time);
    }
    return {
      gain, limiter, master,
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
        return rms(buffers);
      },
    };
  }
  const api = { createController, createGraph, rms, amplitude, INITIAL_DB, MIN_DB, MAX_DB };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VolumeBalance = api;
})(globalThis);
