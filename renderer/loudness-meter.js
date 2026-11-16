// Stereo BS.1770 K-weighting and continuous 400 ms blocks, 75% overlap.
// Filter parameterization follows libebur128 (MIT); see THIRD-PARTY-NOTICES.md.
(function loudnessModule(root) {
  function coefficients(rate) {
    const k = Math.tan(Math.PI * 1681.974450955533 / rate), q = 0.7071752369554196;
    const vh = 10 ** (3.999843853973347 / 20), vb = vh ** 0.4996667741545416, a0 = 1 + k / q + k * k;
    const shelf = { b: [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
      a: [1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0] };
    const h = Math.tan(Math.PI * 38.13547087602444 / rate), d = 1 + h / 0.5003270373238773 + h * h;
    return [shelf, { b: [1, -2, 1], a: [1, 2 * (h * h - 1) / d, (1 - h / 0.5003270373238773 + h * h) / d] }];
  }
  function createMeter(rate, emit) {
    const filters = coefficients(rate), step = Math.round(rate / 10), ring = new Float64Array(4 * step);
    let state, cursor, filled, until, sum, elapsed;
    function reset() { state = Array.from({ length: 2 }, () => filters.map(() => [0, 0])); ring.fill(0); cursor = filled = sum = elapsed = 0; until = 4 * step; }
    reset();
    function process(channels) {
      if (!channels[0]?.length) return;
      for (let i = 0; i < channels[0].length; i++) {
        let energy = 0;
        for (let c = 0; c < Math.min(2, channels.length); c++) {
          let value = Number.isFinite(channels[c][i]) ? channels[c][i] : 0;
          for (let f = 0; f < filters.length; f++) {
            const { a, b } = filters[f], z = state[c][f], output = b[0] * value + z[0];
            z[0] = b[1] * value - a[1] * output + z[1]; z[1] = b[2] * value - a[2] * output; value = output;
          }
          energy += value * value;
        }
        sum += energy - ring[cursor]; ring[cursor] = energy; cursor = (cursor + 1) % ring.length;
        filled = Math.min(ring.length, filled + 1); elapsed++;
        if (--until === 0) { emit(Math.sqrt(Math.max(0, sum / filled)), elapsed / rate); until = step; }
      }
    }
    return { process, reset };
  }
  function createLimiter(rate) {
    const length = Math.max(1, Math.ceil(rate * .005)), buffers = [new Float32Array(length), new Float32Array(length)];
    const capacity = length + 2, peaks = new Float64Array(capacity), indices = new Float64Array(capacity);
    const release = Math.exp(-1 / (rate * .15));
    let head = 0, tail = 0, frame = 0, gain = 1;
    return (input, output) => {
      for (let i = 0; i < output[0].length; i++, frame++) {
        let peak = 0;
        for (let c = 0; c < 2; c++) peak = Math.max(peak, Math.abs(input[c]?.[i] || 0));
        while (head !== tail && indices[head] < frame - length) head = (head + 1) % capacity;
        while (head !== tail && peaks[(tail - 1 + capacity) % capacity] <= peak) tail = (tail - 1 + capacity) % capacity;
        peaks[tail] = peak; indices[tail] = frame; tail = (tail + 1) % capacity;
        const target = Math.min(1, .97 / Math.max(peaks[head], 1e-15));
        gain = target < gain ? target : target + release * (gain - target);
        const at = frame % length;
        for (let c = 0; c < 2; c++) {
          const delayed = buffers[c][at]; buffers[c][at] = input[c]?.[i] || 0;
          if (output[c]) output[c][i] = delayed * gain;
        }
      }
    };
  }
  const api = { coefficients, createMeter, createLimiter, workletSource: '(' + loudnessModule.toString() + ')(globalThis);' };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoudnessMeter = api;
  if (typeof AudioWorkletProcessor !== 'undefined') {
    class LoudnessProcessor extends AudioWorkletProcessor {
      constructor() {
        super(); this.enabled = false; this.generation = 0;
        this.meter = createMeter(sampleRate, level => this.port.postMessage({ generation: this.generation, level }));
        this.port.onmessage = ({ data }) => { this.enabled = data.enabled; this.generation = data.generation; this.meter.reset(); };
      }
      process(inputs) { if (this.enabled) this.meter.process(inputs[0]); return true; }
    }
    registerProcessor('cc-loudness', LoudnessProcessor);
    class PeakLimiter extends AudioWorkletProcessor {
      constructor() { super(); this.limit = createLimiter(sampleRate); }
      process(inputs, outputs) { this.limit(inputs[0], outputs[0]); return true; }
    }
    registerProcessor('cc-peak-limiter', PeakLimiter);
  }
})(globalThis);
