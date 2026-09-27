// VoxMorph DSP — time-domain effects: biquad EQ, tremor (age vibrato), breath,
// roughness, noise gate, compressor, look-ahead limiter. All streaming, sample-accurate.

export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  static _make(fs, type, f, Q, gainDb = 0) {
    const bq = new Biquad();
    bq.set(fs, type, f, Q, gainDb);
    return bq;
  }
  static lowpass(fs, f, Q = 0.7071) { return Biquad._make(fs, 'lowpass', f, Q); }
  static highpass(fs, f, Q = 0.7071) { return Biquad._make(fs, 'highpass', f, Q); }
  static bandpass(fs, f, Q = 1) { return Biquad._make(fs, 'bandpass', f, Q); }
  static lowshelf(fs, f, gainDb, Q = 0.7071) { return Biquad._make(fs, 'lowshelf', f, Q, gainDb); }
  static highshelf(fs, f, gainDb, Q = 0.7071) { return Biquad._make(fs, 'highshelf', f, Q, gainDb); }
  static peaking(fs, f, gainDb, Q = 1) { return Biquad._make(fs, 'peaking', f, Q, gainDb); }

  // RBJ Audio EQ Cookbook
  set(fs, type, f, Q, gainDb = 0) {
    f = Math.max(10, Math.min(fs * 0.49, f));
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * f / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bandpass': // constant 0 dB peak gain
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
        a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
      }
      default: throw new Error('unknown biquad type ' + type);
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  // Transposed direct form II
  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  processInPlace(buf) {
    let z1 = this.z1, z2 = this.z2;
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
    return buf;
  }
}

// Chain of biquads, processed in place
export class FilterChain {
  constructor(filters = []) { this.filters = filters; }
  processInPlace(buf) { for (const f of this.filters) f.processInPlace(buf); return buf; }
}

// Small deterministic noise source (xorshift) so renders are reproducible
export class Noise {
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0 || 1; }
  next() { // uniform in [-1, 1)
    let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x;
    return (x / 4294967296) * 2 - 1;
  }
}

// Age tremor: irregular pitch vibrato (modulated delay) + tremolo + slow drift.
export class Tremor {
  constructor(fs) {
    this.fs = fs;
    this.size = 1 << 12;
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.phase = 0;
    this.noise = new Noise(12345);
    this.drift = 0; this.drift2 = 0;
    this.set({ amount: 0 });
  }
  // amount 0..1 ; rate in Hz ; cents = peak pitch deviation at amount 1 ; tremolo = amplitude depth at amount 1
  set({ amount = 0, rate = 6, cents = 40, tremolo = 0.25 }) {
    this.amount = Math.max(0, Math.min(1.5, amount));
    this.rate = rate;
    const dev = Math.pow(2, (cents * this.amount) / 1200) - 1;   // fractional pitch deviation
    this.depthSamples = (dev / (2 * Math.PI * rate)) * this.fs;   // delay modulation amplitude
    this.baseDelay = this.depthSamples * 1.5 + 4;
    this.tremDepth = tremolo * this.amount;
  }
  processInPlace(buf) {
    if (this.amount <= 0) return buf;
    const fs = this.fs, b = this.buf, mask = this.mask;
    let w = this.w, phase = this.phase, drift = this.drift, drift2 = this.drift2;
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < buf.length; i++) {
      // slow random drift of the tremor rate/depth (elderly voices are irregular)
      drift += (this.noise.next() * 0.02 - drift * 0.0015);
      drift2 += (this.noise.next() * 0.02 - drift2 * 0.0015);
      const rate = this.rate * (1 + 0.35 * drift);
      phase += twoPi * rate / fs;
      if (phase > twoPi) phase -= twoPi;
      const lfo = Math.sin(phase);
      const delay = this.baseDelay + this.depthSamples * (1 + 0.5 * drift2) * lfo;
      b[w] = buf[i];
      // fractional read (linear interpolation)
      let rp = w - delay;
      const ri = Math.floor(rp);
      const frac = rp - ri;
      const s0 = b[ri & mask], s1 = b[(ri + 1) & mask];
      let y = s0 + (s1 - s0) * frac;
      // tremolo
      y *= 1 - this.tremDepth * (0.5 + 0.5 * Math.sin(phase + 1.2));
      buf[i] = y;
      w = (w + 1) & mask;
    }
    this.w = w; this.phase = phase; this.drift = drift; this.drift2 = drift2;
    return buf;
  }
}

// Breathiness: band-limited noise shaped by the signal envelope, mixed in.
export class Breath {
  constructor(fs) {
    this.fs = fs;
    this.noise = new Noise(777);
    this.bp1 = Biquad.bandpass(fs, 2500, 0.6);
    this.bp2 = Biquad.highpass(fs, 1200, 0.7);
    this.env = 0;
    this.att = Math.exp(-1 / (fs * 0.004));
    this.rel = Math.exp(-1 / (fs * 0.05));
    this.level = 0;
  }
  set(amount) { this.level = Math.max(0, Math.min(1.5, amount)) * 0.09; }
  processInPlace(buf) {
    if (this.level <= 0) return buf;
    let env = this.env;
    const att = this.att, rel = this.rel, lvl = this.level;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const a = Math.abs(x);
      env = a > env ? att * env + (1 - att) * a : rel * env + (1 - rel) * a;
      let n = this.noise.next();
      n = this.bp2.tick(this.bp1.tick(n));
      buf[i] = x + n * env * lvl;
    }
    this.env = env;
    return buf;
  }
}

// Roughness: subtle low-rate amplitude modulation by filtered noise (rasp)
export class Roughness {
  constructor(fs) {
    this.fs = fs;
    this.noise = new Noise(4242);
    this.lp = Biquad.lowpass(fs, 35, 0.7);
    this.amount = 0;
  }
  set(amount) { this.amount = Math.max(0, Math.min(1, amount)); }
  processInPlace(buf) {
    if (this.amount <= 0) return buf;
    const d = this.amount * 0.6;
    for (let i = 0; i < buf.length; i++) {
      const m = this.lp.tick(this.noise.next()) * 6; // ~[-1,1]
      buf[i] *= 1 - d * (0.5 + 0.5 * Math.max(-1, Math.min(1, m)));
    }
    return buf;
  }
}

// Downward expander / noise gate with hysteresis
export class Gate {
  constructor(fs) {
    this.fs = fs;
    this.env = 0;
    this.gain = 1;
    this.att = Math.exp(-1 / (fs * 0.002));
    this.rel = Math.exp(-1 / (fs * 0.08));
    this.gAtt = Math.exp(-1 / (fs * 0.003));
    this.gRel = Math.exp(-1 / (fs * 0.12));
    this.open = false;
    this.set({ enabled: false, thresholdDb: -45 });
  }
  set({ enabled = false, thresholdDb = -45, floorDb = -40 }) {
    this.enabled = enabled;
    this.thrOpen = Math.pow(10, thresholdDb / 20);
    this.thrClose = this.thrOpen * 0.6;
    this.floor = Math.pow(10, floorDb / 20);
  }
  processInPlace(buf) {
    if (!this.enabled) return buf;
    let env = this.env, gain = this.gain, open = this.open;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      env = a > env ? this.att * env + (1 - this.att) * a : this.rel * env + (1 - this.rel) * a;
      if (open && env < this.thrClose) open = false;
      else if (!open && env > this.thrOpen) open = true;
      const target = open ? 1 : this.floor;
      gain = target > gain ? this.gAtt * gain + (1 - this.gAtt) * target : this.gRel * gain + (1 - this.gRel) * target;
      buf[i] *= gain;
    }
    this.env = env; this.gain = gain; this.open = open;
    return buf;
  }
}

// Feed-forward compressor with soft knee (peak detection in the log domain)
export class Compressor {
  constructor(fs) {
    this.fs = fs;
    this.envDb = -100;
    this.set({ thresholdDb: -18, ratio: 3, attackMs: 6, releaseMs: 90, kneeDb: 6, makeupDb: 0 });
  }
  set({ thresholdDb = -18, ratio = 3, attackMs = 6, releaseMs = 90, kneeDb = 6, makeupDb = 0, enabled = true }) {
    this.enabled = enabled;
    this.thr = thresholdDb; this.ratio = ratio; this.knee = kneeDb;
    this.att = Math.exp(-1 / (this.fs * attackMs / 1000));
    this.rel = Math.exp(-1 / (this.fs * releaseMs / 1000));
    this.makeup = Math.pow(10, makeupDb / 20);
  }
  _gainDb(levelDb) {
    const thr = this.thr, knee = this.knee, ratio = this.ratio;
    const over = levelDb - thr;
    if (over <= -knee / 2) return 0;
    if (over >= knee / 2) return -(over) * (1 - 1 / ratio);
    const t = over + knee / 2;
    return -(1 - 1 / ratio) * (t * t) / (2 * knee);
  }
  processInPlace(buf) {
    if (!this.enabled) { if (this.makeup !== 1) for (let i = 0; i < buf.length; i++) buf[i] *= this.makeup; return buf; }
    let envDb = this.envDb;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      const lvl = 20 * Math.log10(a + 1e-9);
      envDb = lvl > envDb ? this.att * envDb + (1 - this.att) * lvl : this.rel * envDb + (1 - this.rel) * lvl;
      const g = Math.pow(10, this._gainDb(envDb) / 20) * this.makeup;
      buf[i] *= g;
    }
    this.envDb = envDb;
    return buf;
  }
}

// Look-ahead peak limiter (transparent ceiling) — introduces `lookahead` samples of delay.
export class Limiter {
  constructor(fs, { ceilingDb = -1, lookaheadMs = 3, releaseMs = 60 } = {}) {
    this.fs = fs;
    this.ceiling = Math.pow(10, ceilingDb / 20);
    this.la = Math.max(1, Math.round(fs * lookaheadMs / 1000));
    this.delay = new Float32Array(this.la);
    this.dw = 0;
    this.gain = 1;
    this.rel = Math.exp(-1 / (fs * releaseMs / 1000));
    // sliding-window maximum over the look-ahead window (monotonic deque)
    this.q = new Float32Array(this.la * 4);
    this.qi = new Int32Array(this.la * 4);
    this.qh = 0; this.qt = 0; this.n = 0;
    this.attCoef = Math.exp(-1 / (this.la * 0.35));
    this.enabled = true;
  }
  get latency() { return this.la; }
  processInPlace(buf) {
    if (!this.enabled) return buf;
    const la = this.la, ceiling = this.ceiling, delay = this.delay, rel = this.rel;
    const qcap = this.q.length;
    let gain = this.gain, dw = this.dw, qh = this.qh, qt = this.qt, n = this.n;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const a = Math.abs(x);
      // push into monotonic deque (values decreasing from head to tail)
      while (qt !== qh && this.q[(qt - 1 + qcap) % qcap] <= a) qt = (qt - 1 + qcap) % qcap;
      this.q[qt] = a; this.qi[qt] = n; qt = (qt + 1) % qcap;
      // pop expired
      while (this.qi[qh] <= n - la) qh = (qh + 1) % qcap;
      const peak = this.q[qh];
      const target = peak > ceiling ? ceiling / peak : 1;
      // gain moves down quickly (within the look-ahead), recovers slowly
      if (target < gain) gain = this.attCoef * gain + (1 - this.attCoef) * target;
      else gain = rel * gain + (1 - rel) * target;
      const delayed = delay[dw];
      delay[dw] = x;
      dw = (dw + 1) % la;
      let y = delayed * gain;
      // safety clip
      if (y > ceiling) y = ceiling; else if (y < -ceiling) y = -ceiling;
      buf[i] = y;
      n++;
    }
    this.gain = gain; this.dw = dw; this.qh = qh; this.qt = qt; this.n = n;
    return buf;
  }
}

// Simple gain
export function applyGain(buf, g) { for (let i = 0; i < buf.length; i++) buf[i] *= g; return buf; }
