// VoxMorph DSP — streaming STFT stage: spectral noise reduction, formant (spectral
// envelope) warping and an anti-alias low-pass, all done in one analysis/synthesis pass.
//
// Formant warping: the smooth spectral envelope E(f) is estimated per frame with a
// liftered cepstrum. Multiplying the spectrum by E(f / warp) / E(f) moves the formants
// by the factor `warp` while leaving the harmonic (pitch) structure untouched.

import { FFT, hannPeriodic, SampleFifo } from './fft.js';

export class SpectralStage {
  /**
   * @param {number} fs sample rate
   * @param {object} opts { frameSize, hop }
   */
  constructor(fs, opts = {}) {
    this.fs = fs;
    this.N = opts.frameSize || 2048;
    this.H = opts.hop || (this.N >> 2);
    this.fft = new FFT(this.N);
    this.win = hannPeriodic(this.N);
    // Normalisation of the analysis*synthesis window overlap-add (constant for Hann^2 at hop N/4 or N/2)
    let norm = 0;
    for (let m = -8; m <= 8; m++) {
      const i = (this.N >> 1) - m * this.H;
      if (i >= 0 && i < this.N) norm += this.win[i] * this.win[i];
    }
    this.norm = norm;
    this.bins = (this.N >> 1) + 1;

    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.cre = new Float64Array(this.N);
    this.cim = new Float64Array(this.N);
    this.mag = new Float64Array(this.bins);
    this.gain = new Float64Array(this.bins);
    this.logmag = new Float64Array(this.bins);
    this.envLog = new Float64Array(this.bins);

    // Noise reduction state
    this.nrEnabled = false;
    this.nrStrength = 0.6;
    this.noisePsd = new Float64Array(this.bins).fill(1e-12);
    this.noiseFixed = false;          // true when a measured profile was supplied (offline)
    this.prevXi = new Float64Array(this.bins);
    this.prevGain = new Float64Array(this.bins).fill(1);
    this.prevP = new Float64Array(this.bins);
    this.smoothP = new Float64Array(this.bins);
    this.nrGain = new Float64Array(this.bins).fill(1);
    this.frameCount = 0;

    // Formant warp
    this.warp = 1;
    this.setLifter(120); // default assumption ~120 Hz source pitch
    this.maxGainDb = 36;

    // Anti-alias cutoff (bins), N/2 = off
    this.aaBin = this.N >> 1;

    // Streaming buffers
    this.input = new SampleFifo();
    this.readPos = 0;                    // absolute index of the next frame start
    this.ola = new Float64Array(this.N + this.H);
    this.olaBase = 0;                    // absolute output index of ola[0]
    this.pendingLatency = this.N - this.H; // samples to drop at the start (pre-padding)
    this.input.writeZeros(this.N - this.H);
    this.flushed = false;
  }

  get latency() { return 0; } // the pre-padding makes the stage delay-free from the caller's view

  setWarp(w) { this.warp = w; }
  setAntiAlias(cutoffHz) {
    const b = Math.round((cutoffHz / (this.fs / 2)) * (this.N >> 1));
    this.aaBin = Math.max(16, Math.min(this.N >> 1, b));
  }
  // Adapt the cepstral lifter to the source pitch: keep quefrencies below ~65% of the period.
  setLifter(sourceF0) {
    const period = this.fs / Math.max(60, Math.min(600, sourceF0 || 120));
    const q1 = Math.round(Math.max(48, Math.min(this.N >> 3, 0.65 * period)));
    const q0 = Math.round(q1 * 0.72);
    this.lifter = new Float64Array(this.N);
    for (let q = 0; q < this.N; q++) {
      const qq = Math.min(q, this.N - q);
      let l = 0;
      if (qq <= q0) l = 1;
      else if (qq < q1) l = 0.5 + 0.5 * Math.cos(Math.PI * (qq - q0) / (q1 - q0));
      this.lifter[q] = l;
    }
  }
  setNoiseReduction(enabled, strength = 0.6) {
    this.nrEnabled = !!enabled;
    this.nrStrength = Math.max(0, Math.min(1, strength));
  }
  // Supply a measured noise power profile (per bin, power units of |X|^2) — offline mode.
  setNoiseProfile(psd) {
    for (let k = 0; k < this.bins; k++) this.noisePsd[k] = Math.max(1e-12, psd[k]);
    this.noiseFixed = true;
  }

  /** Push samples in; returns the samples that became final (Float32Array, possibly empty). */
  process(chunk) {
    this.input.write(chunk);
    return this._run(false);
  }

  /** Signal end of stream; returns the remaining samples. */
  flush() {
    if (this.flushed) return new Float32Array(0);
    this.flushed = true;
    this.input.writeZeros(this.N);
    return this._run(true);
  }

  _run(final) {
    const N = this.N, H = this.H;
    const outChunks = [];
    let produced = 0;
    while (this.input.end - this.readPos >= N) {
      this._frame(this.readPos);
      // ola[0..H) is final now
      const outLen = H;
      const chunk = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) chunk[i] = this.ola[i];
      this.ola.copyWithin(0, H, N + H);
      this.ola.fill(0, N);
      this.olaBase += H;
      this.readPos += H;
      this.input.discardBefore(this.readPos);
      outChunks.push(chunk);
      produced += outLen;
    }
    // Concatenate, dropping the start latency (pre-padding) once
    let total = 0;
    for (const c of outChunks) total += c.length;
    let out = new Float32Array(total);
    let o = 0;
    for (const c of outChunks) { out.set(c, o); o += c.length; }
    if (this.pendingLatency > 0) {
      const drop = Math.min(this.pendingLatency, out.length);
      out = out.subarray(drop);
      this.pendingLatency -= drop;
    }
    if (final) {
      // Trailing padding produced N extra samples; the caller trims to the expected length.
    }
    return out;
  }

  _frame(absStart) {
    const N = this.N, bins = this.bins, re = this.re, im = this.im, win = this.win;
    const buf = this.input.buf, off = absStart - this.input.base;
    for (let i = 0; i < N; i++) { re[i] = buf[off + i] * win[i]; im[i] = 0; }
    this.fft.forward(re, im);
    const mag = this.mag, gain = this.gain;
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      gain[k] = 1;
    }
    this.frameCount++;

    if (this.nrEnabled) this._noiseReduce();
    if (Math.abs(this.warp - 1) > 1e-4) this._formantWarp();

    // Anti-alias low-pass (brick wall with a short cosine taper)
    if (this.aaBin < (N >> 1)) {
      const taper = 12;
      for (let k = this.aaBin - taper; k < bins; k++) {
        if (k < 0) continue;
        let g = 0;
        if (k < this.aaBin) g = 0.5 + 0.5 * Math.cos(Math.PI * (k - (this.aaBin - taper)) / taper);
        gain[k] *= g;
      }
    }

    // Apply gains (real, zero-phase) and rebuild the conjugate-symmetric spectrum
    for (let k = 0; k < bins; k++) { re[k] *= gain[k]; im[k] *= gain[k]; }
    for (let k = 1; k < (N >> 1); k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    this.fft.inverse(re, im);
    const ola = this.ola, s = 1 / this.norm;
    for (let i = 0; i < N; i++) ola[i] += re[i] * win[i] * s;
  }

  _noiseReduce() {
    const bins = this.bins, mag = this.mag, noise = this.noisePsd, gain = this.gain;
    const strength = this.nrStrength;
    const alpha = 0.96;                                   // decision-directed smoothing
    const floor = Math.pow(10, -(6 + 22 * strength) / 20);  // max attenuation 6..28 dB
    const over = 1 + 0.8 * strength;                       // over-subtraction
    const nrGain = this.nrGain, prevGain = this.prevGain, prevP = this.prevP, smoothP = this.smoothP;
    for (let k = 0; k < bins; k++) {
      const P = mag[k] * mag[k];
      // Running noise tracker (live mode): fast down, slow up
      if (!this.noiseFixed) {
        smoothP[k] = 0.7 * smoothP[k] + 0.3 * P;
        if (this.frameCount < 12) noise[k] = Math.max(noise[k], smoothP[k] * 0.9 + 1e-12);
        else if (smoothP[k] < noise[k]) noise[k] = 0.85 * noise[k] + 0.15 * smoothP[k];
        else noise[k] += (smoothP[k] - noise[k]) * 0.004;
      }
      const n = noise[k] * over + 1e-12;
      const gammaK = P / n;
      let xi = alpha * (prevGain[k] * prevGain[k] * prevP[k] / n) + (1 - alpha) * Math.max(gammaK - 1, 0);
      let G = xi / (1 + xi);
      if (G < floor) G = floor;
      nrGain[k] = G;
      prevP[k] = P;
    }
    // Light smoothing across frequency reduces "musical noise"
    let prev = nrGain[0];
    for (let k = 1; k < bins - 1; k++) {
      const cur = nrGain[k];
      nrGain[k] = 0.25 * prev + 0.5 * cur + 0.25 * nrGain[k + 1];
      prev = cur;
    }
    for (let k = 0; k < bins; k++) { prevGain[k] = nrGain[k]; gain[k] *= nrGain[k]; }
  }

  _formantWarp() {
    const N = this.N, bins = this.bins, mag = this.mag, gain = this.gain;
    const cre = this.cre, cim = this.cim, logmag = this.logmag, envLog = this.envLog;
    const floor = 1e-7 * N;
    let energy = 0;
    for (let k = 0; k < bins; k++) {
      const m = mag[k] * gain[k];
      energy += m * m;
      logmag[k] = Math.log(m > floor ? m : floor);
    }
    if (energy < floor * floor * bins * 4) return; // silence: nothing to warp
    // Real cepstrum of the (even-symmetric) log magnitude
    for (let k = 0; k < bins; k++) { cre[k] = logmag[k]; cim[k] = 0; }
    for (let k = 1; k < (N >> 1); k++) { cre[N - k] = logmag[k]; cim[N - k] = 0; }
    this.fft.inverse(cre, cim);
    const lifter = this.lifter;
    for (let q = 0; q < N; q++) { cre[q] *= lifter[q]; cim[q] = 0; }
    this.fft.forward(cre, cim);
    for (let k = 0; k < bins; k++) envLog[k] = cre[k];
    // Warp: new envelope at bin k = old envelope at bin k / warp
    const invWarp = 1 / this.warp;
    const maxLn = this.maxGainDb * Math.LN10 / 20;
    const top = bins - 1;
    for (let k = 0; k < bins; k++) {
      let src = k * invWarp;
      let e;
      if (src >= top) e = envLog[top];
      else {
        const i0 = src | 0, f = src - i0;
        e = envLog[i0] + (envLog[i0 + 1] - envLog[i0]) * f;
      }
      let d = e - envLog[k];
      if (d > maxLn) d = maxLn; else if (d < -maxLn) d = -maxLn;
      gain[k] *= Math.exp(d);
    }
  }
}

/**
 * Offline helper: estimate a per-bin noise power profile from the quietest frames of a clip.
 * Returns Float64Array(bins) matching a SpectralStage with the same frame size.
 */
export function estimateNoiseProfile(signal, fs, frameSize = 2048) {
  const N = frameSize, H = N >> 1, bins = (N >> 1) + 1;
  const fft = new FFT(N), win = hannPeriodic(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const frames = [];
  for (let start = 0; start + N <= signal.length; start += H) {
    let e = 0;
    const p = new Float64Array(bins);
    for (let i = 0; i < N; i++) { re[i] = signal[start + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) { const v = re[k] * re[k] + im[k] * im[k]; p[k] = v; e += v; }
    frames.push({ e, p });
  }
  const psd = new Float64Array(bins).fill(1e-12);
  if (frames.length === 0) return psd;
  frames.sort((a, b) => a.e - b.e);
  const count = Math.max(1, Math.min(frames.length, Math.round(frames.length * 0.12)));
  for (let i = 0; i < count; i++) {
    const p = frames[i].p;
    for (let k = 0; k < bins; k++) psd[k] += p[k];
  }
  for (let k = 0; k < bins; k++) psd[k] = psd[k] / count;
  // Smooth across frequency
  const sm = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let s = 0, c = 0;
    for (let j = -2; j <= 2; j++) { const kk = k + j; if (kk >= 0 && kk < bins) { s += psd[kk]; c++; } }
    sm[k] = s / c;
  }
  return sm;
}
