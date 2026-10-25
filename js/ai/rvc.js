// VoxMorph AI — local neural voice conversion (RVC v2 pipeline) on top of onnxruntime-web.
//
//   input (48 kHz) → 16 kHz → ContentVec (768-dim content features @ 50 Hz, repeated to 100 Hz)
//                 → f0 track @ 100 Hz (built-in YIN, or RMVPE ONNX when installed) → transpose
//                 → RVC generator ONNX ("phone", "phone_lengths", "pitch", "pitchf", "ds", "rnd")
//                 → audio at the model's rate (32/40/48 kHz) → 48 kHz.
//
// The ORT module is injected (so the same code runs in a Worker with the real runtime and in
// Node tests with a mock). Everything that is not an ONNX session call is plain JavaScript.

import { FFT, hannPeriodic } from '../dsp/fft.js';
import { Resampler } from '../dsp/timescale.js';
import { Biquad } from '../dsp/effects.js';
import { estimatePitch } from '../dsp/analysis.js';

export const CV_RATE = 16000;
const F0_MIN = 50, F0_MAX = 1100;
const F0_MEL_MIN = 1127 * Math.log(1 + F0_MIN / 700);
const F0_MEL_MAX = 1127 * Math.log(1 + F0_MAX / 700);

/** Resample mono float audio (with a low-pass guard when going down). */
export function resampleTo(samples, from, to) {
  if (from === to) return samples;
  let x = samples;
  if (to < from) {
    x = new Float32Array(samples);
    const f = to * 0.45;
    Biquad.lowpass(from, f, 0.54).processInPlace(x);
    Biquad.lowpass(from, f, 1.31).processInPlace(x);
  }
  const rs = new Resampler(from / to);
  const a = rs.process(x), b = rs.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  const want = Math.round(samples.length * to / from);
  if (out.length >= want) return out.subarray(0, want);
  const padded = new Float32Array(want); padded.set(out); return padded;
}

/** RVC's coarse pitch code (1..255) from f0 in Hz (0 → 1 = unvoiced). */
export function f0ToCoarse(f0) {
  if (!(f0 > 0)) return 1;
  let mel = 1127 * Math.log(1 + f0 / 700);
  mel = (mel - F0_MEL_MIN) * 254 / (F0_MEL_MAX - F0_MEL_MIN) + 1;
  if (mel <= 1) return 1;
  if (mel > 255) return 255;
  return Math.round(mel);
}

/** Linear interpolation of a frame track to a new length over the same time span. */
export function resampleTrack(track, newLen) {
  const n = track.length;
  const out = new Float32Array(newLen);
  if (n === 0 || newLen === 0) return out;
  if (n === 1) { out.fill(track[0]); return out; }
  for (let i = 0; i < newLen; i++) {
    const p = (i * (n - 1)) / Math.max(1, newLen - 1);
    const i0 = Math.floor(p), f = p - i0;
    const a = track[i0], b = track[Math.min(n - 1, i0 + 1)];
    // do not interpolate across unvoiced (0) frames
    out[i] = a > 0 && b > 0 ? a + (b - a) * f : (f < 0.5 ? a : b);
  }
  return out;
}

/** Median filter (odd window) that leaves zeros (unvoiced) alone. */
export function medianSmooth(track, win = 5) {
  const half = win >> 1, n = track.length, out = new Float32Array(n), buf = [];
  for (let i = 0; i < n; i++) {
    if (!(track[i] > 0)) { out[i] = 0; continue; }
    buf.length = 0;
    for (let j = -half; j <= half; j++) { const v = track[i + j]; if (v > 0) buf.push(v); }
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

/** f0 track at 10 ms hop from 16 kHz audio using the built-in YIN tracker. */
export function yinTrack16k(x16, frames) {
  // estimatePitch frames start at i*hop and span 1024 samples: pre-pad so frame i is centred on i*hop
  const pad = 512;
  const padded = new Float32Array(x16.length + 2 * pad + 1024);
  padded.set(x16, pad);
  const info = estimatePitch(padded, CV_RATE, { fMin: F0_MIN, fMax: 1000 });
  const t = new Float32Array(info.track.length);
  for (let i = 0; i < t.length; i++) t[i] = info.track[i].voiced ? info.track[i].f0 : 0;
  return resampleTrack(medianSmooth(t, 5), frames);
}

// ------------------------------------------------------------------------------------------
// RMVPE front-end (log-mel, HTK scale, slaney norm — as in RVC's rmvpe.py) and decoder
// ------------------------------------------------------------------------------------------

export function htkMelFilterbank(sr, nFft, nMels, fmin, fmax) {
  const nBins = (nFft >> 1) + 1;
  const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
  const mel2hz = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const melMin = hz2mel(fmin), melMax = hz2mel(fmax);
  const melF = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) melF[i] = mel2hz(melMin + (melMax - melMin) * i / (nMels + 1));
  const fftFreqs = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) fftFreqs[k] = (sr / 2) * k / (nBins - 1);
  const weights = new Float32Array(nMels * nBins);
  for (let i = 0; i < nMels; i++) {
    const fdiff0 = melF[i + 1] - melF[i], fdiff1 = melF[i + 2] - melF[i + 1];
    const enorm = 2 / (melF[i + 2] - melF[i]);
    for (let k = 0; k < nBins; k++) {
      const lower = (fftFreqs[k] - melF[i]) / fdiff0;
      const upper = (melF[i + 2] - fftFreqs[k]) / fdiff1;
      const w = Math.max(0, Math.min(lower, upper));
      weights[i * nBins + k] = w * enorm;
    }
  }
  return { weights, nMels, nBins };
}

/** log-mel spectrogram (128 × frames) exactly as RMVPE expects: n_fft 1024, hop 160, centre/reflect, clamp 1e-5. */
export function rmvpeMel(x16, fb = null) {
  const nFft = 1024, hop = 160, nMels = 128;
  const bank = fb || htkMelFilterbank(CV_RATE, nFft, nMels, 30, 8000);
  const nBins = bank.nBins;
  const half = nFft >> 1;
  const n = x16.length;
  // reflect padding
  const padded = new Float32Array(n + 2 * half);
  padded.set(x16, half);
  for (let i = 0; i < half; i++) { padded[half - 1 - i] = x16[Math.min(n - 1, i + 1)]; padded[half + n + i] = x16[Math.max(0, n - 2 - i)]; }
  const frames = 1 + Math.floor(n / hop);
  const fft = new FFT(nFft), win = hannPeriodic(nFft);
  const re = new Float64Array(nFft), im = new Float64Array(nFft), mag = new Float64Array(nBins);
  const mel = new Float32Array(nMels * frames); // row-major [mel][frame]
  for (let t = 0; t < frames; t++) {
    const off = t * hop;
    for (let i = 0; i < nFft; i++) { re[i] = padded[off + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);
    for (let k = 0; k < nBins; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    for (let m = 0; m < nMels; m++) {
      let s = 0;
      const row = m * nBins;
      for (let k = 0; k < nBins; k++) s += bank.weights[row + k] * mag[k];
      mel[m * frames + t] = Math.log(Math.max(s, 1e-5));
    }
  }
  return { mel, frames, nMels };
}

const CENTS_MAPPING = (() => { const c = new Float64Array(360 + 8); for (let i = 0; i < 360; i++) c[i + 4] = 20 * i + 1997.3794084376191; return c; })();

/** RMVPE salience (frames × 360) → f0 in Hz (0 = unvoiced). */
export function rmvpeDecode(hidden, frames, thred = 0.03) {
  const f0 = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const row = t * 360;
    let center = 0, maxx = -Infinity;
    for (let b = 0; b < 360; b++) { const v = hidden[row + b]; if (v > maxx) { maxx = v; center = b; } }
    if (maxx <= thred) { f0[t] = 0; continue; }
    let ps = 0, ws = 0;
    for (let j = -4; j <= 4; j++) {
      const b = center + j;
      const v = b >= 0 && b < 360 ? hidden[row + b] : 0;
      ps += v * CENTS_MAPPING[b + 4];
      ws += v;
    }
    const cents = ws > 0 ? ps / ws : 0;
    const hz = 10 * Math.pow(2, cents / 1200);
    f0[t] = hz === 10 ? 0 : hz;
  }
  return f0;
}

// ------------------------------------------------------------------------------------------
// Chunking: cut long inputs at quiet points so each ONNX run stays short
// ------------------------------------------------------------------------------------------

export function planChunks(audio, rate, { chunkSec = 20, searchSec = 2.5, padSec = 0.35 } = {}) {
  const n = audio.length, chunk = Math.round(chunkSec * rate), search = Math.round(searchSec * rate), pad = Math.round(padSec * rate);
  const frame = Math.round(rate * 0.01);
  const cuts = [0];
  let pos = 0;
  while (n - pos > chunk + search) {
    const target = pos + chunk;
    let best = target, bestE = Infinity;
    for (let c = Math.max(pos + frame, target - search); c <= Math.min(n - frame, target + search); c += frame) {
      let e = 0;
      for (let i = c - frame; i < c + frame; i++) e += audio[i] * audio[i];
      if (e < bestE) { bestE = e; best = c; }
    }
    cuts.push(best);
    pos = best;
  }
  cuts.push(n);
  const chunks = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i], end = cuts[i + 1];
    const padStart = Math.min(pad, start), padEnd = Math.min(pad, n - end);
    chunks.push({ start, end, padStart, padEnd });
  }
  return chunks;
}

function randn(n, scale = 1) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.random() || 1e-12, v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u)) * scale;
    out[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return out;
}

/**
 * Condition a 16 kHz segment for the models: 48 Hz high-pass, RMS to -23 dBFS (gain ≤ 10×, peak ≤ 0.98).
 * Mirrors the reference test harness so browser results match the Python runs.
 */
export function prepareInput16k(x16, fixedGain = null) {
  const y = new Float32Array(x16);
  const hp = Biquad.highpass(CV_RATE, 48, 0.7071);
  hp.processInPlace(y);
  const gain = fixedGain ?? conditioningGain(y);
  if (gain !== 1) for (let i = 0; i < y.length; i++) y[i] *= gain;
  return y;
}

/** Gain that brings high-passed audio to -23 dBFS RMS (≤ 10×, peak ≤ 0.98). */
export function conditioningGain(y) {
  let sq = 0, peak = 0;
  for (let i = 0; i < y.length; i++) { sq += y[i] * y[i]; const a = Math.abs(y[i]); if (a > peak) peak = a; }
  const rms = Math.sqrt(sq / Math.max(1, y.length));
  if (!(rms > 1e-7 && peak > 0)) return 1;
  return Math.min(Math.pow(10, -23 / 20) / rms, 10, 0.98 / peak);
}

// ------------------------------------------------------------------------------------------
// Engine
// ------------------------------------------------------------------------------------------

export class RvcEngine {
  /**
   * @param {object} ort the onnxruntime-web module (real or mock)
   * @param {object} opts { executionProviders: ['webgpu'|'wasm'], log(fn) }
   */
  constructor(ort, opts = {}) {
    this.ort = ort;
    this.eps = opts.executionProviders || ['wasm'];
    this.onFallback = opts.onFallback || (() => {});
    this.log = opts.log || (() => {});
    this.cv = null;     // { session, inputName, outputName, layout: 'b1n'|'bn', outLayout: 'btc'|'bct', dims }
    this.rmvpe = null;  // { session, inputName, outputName }
    this.voice = null;  // { session, meta, names }
    this.melBank = null;
  }

  async _session(bytes, label) {
    const t0 = Date.now();
    let s;
    try {
      s = await this.ort.InferenceSession.create(bytes, { executionProviders: this.eps, graphOptimizationLevel: 'all' });
    } catch (e) {
      if (this.eps.length <= 1 || this.eps[0] === 'wasm') throw e;
      // GPU session failed (lost adapter, unsupported device …): fall back to the CPU build for this and later sessions
      this.log(`${label}: ${this.eps[0]} session failed (${e.message || e}); falling back to wasm`);
      this.eps = ['wasm'];
      this.onFallback('wasm');
      s = await this.ort.InferenceSession.create(bytes, { executionProviders: this.eps, graphOptimizationLevel: 'all' });
    }
    this.log(`${label}: session ready in ${Date.now() - t0} ms on ${this.eps[0]} (inputs ${s.inputNames.join(',')}; outputs ${s.outputNames.join(',')})`);
    return s;
  }

  async loadContentVec(bytes, { dims = 768 } = {}) {
    const session = await this._session(bytes, 'ContentVec');
    this.cv = { session, inputName: session.inputNames[0], outputName: session.outputNames[0], layout: null, outLayout: null, dims };
    return this.cv;
  }

  async loadRmvpe(bytes) {
    const session = await this._session(bytes, 'RMVPE');
    this.rmvpe = { session, inputName: session.inputNames[0], outputName: session.outputNames[0] };
    this.melBank = this.melBank || htkMelFilterbank(CV_RATE, 1024, 128, 30, 8000);
    return this.rmvpe;
  }

  /**
   * @param {ArrayBuffer|Uint8Array} bytes
   * @param {object} meta { sampleRate: 40000, version: 2, speakerId: 0, dims: 768 }
   */
  async loadVoice(bytes, meta) {
    const session = await this._session(bytes, `voice ${meta.id || ''}`);
    const names = session.inputNames;
    // RVC export order: phone, phone_lengths, pitch, pitchf, ds, rnd — resolve by name when available
    const pick = (want, idx) => names.includes(want) ? want : names[idx];
    this.voice = {
      session, meta: Object.assign({ sampleRate: 40000, version: 2, speakerId: 0, dims: 768 }, meta),
      names: { phone: pick('phone', 0), lengths: pick('phone_lengths', 1), pitch: pick('pitch', 2), pitchf: pick('pitchf', 3), ds: pick('ds', 4), rnd: pick('rnd', 5) },
      outputName: session.outputNames[0],
    };
    return this.voice;
  }

  unloadVoice() { if (this.voice) { try { this.voice.session.release && this.voice.session.release(); } catch { /* ignore */ } this.voice = null; } }

  /** Run only the generator with synthetic content features (diagnostics when ContentVec is absent). */
  async testGenerator(seconds = 2) {
    const v = this.voice;
    if (!v) throw new Error('voice model not loaded');
    const ort = this.ort, dims = v.meta.dims || 768, T = Math.round(seconds * 100);
    let seed = 12345; const rnd01 = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const phone = new Float32Array(T * dims);
    for (let i = 0; i < phone.length; i++) phone[i] = (rnd01() - 0.5) * 0.8;
    const pitchf = new Float32Array(T), pitch = new BigInt64Array(T);
    for (let i = 0; i < T; i++) { const hz = i % 25 === 0 ? 0 : 150 + 20 * Math.sin(i / 10); pitchf[i] = hz; pitch[i] = BigInt(f0ToCoarse(hz)); }
    const feeds = {
      [v.names.phone]: new ort.Tensor('float32', phone, [1, T, dims]),
      [v.names.lengths]: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
      [v.names.pitch]: new ort.Tensor('int64', pitch, [1, T]),
      [v.names.pitchf]: new ort.Tensor('float32', pitchf, [1, T]),
      [v.names.ds]: new ort.Tensor('int64', BigInt64Array.from([BigInt(v.meta.speakerId || 0)]), [1]),
      [v.names.rnd]: new ort.Tensor('float32', randn(192 * T, 0.66666), [1, 192, T]),
    };
    const t0 = Date.now();
    const out = await v.session.run(feeds);
    const audio = out[v.outputName];
    const data = audio.data instanceof Float32Array ? audio.data : Float32Array.from(audio.data);
    let peak = 0, sq = 0, nan = 0;
    for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (Number.isNaN(a)) nan++; if (a > peak) peak = a; sq += data[i] * data[i]; }
    return { frames: T, samples: data.length, dims: audio.dims, hop: data.length / T, peak, rms: Math.sqrt(sq / data.length), nan, ms: Date.now() - t0 };
  }

  /** Infer the generator's sample rate (32/40/48 kHz) from the output length of a short run. */
  async detectSampleRate() {
    const v = this.voice;
    if (!v) throw new Error('voice model not loaded');
    const x16 = new Float32Array(CV_RATE); // one second
    for (let i = 0; i < x16.length; i++) x16[i] = 0.2 * Math.sin(2 * Math.PI * 130 * i / CV_RATE);
    const r = await this.synthesize(x16, { transpose: 0, f0Method: 'yin' });
    const hop = r.audio.length / r.frames;
    const sr = [32000, 40000, 48000].reduce((best, cand) => Math.abs(cand / 100 - hop) < Math.abs(best / 100 - hop) ? cand : best, 40000);
    v.meta.sampleRate = sr;
    this.log(`voice sample rate detected: ${sr} Hz (hop ${hop.toFixed(1)})`);
    return sr;
  }

  /** Content features for 16 kHz audio → { data: Float32Array (T*dims), frames: T } */
  async contentFeatures(x16) {
    const ort = this.ort, cv = this.cv;
    if (!cv) throw new Error('ContentVec not loaded');
    const dims = cv.dims;
    const run = async (layout) => {
      const tensor = layout === 'b1n' ? new ort.Tensor('float32', x16, [1, 1, x16.length]) : new ort.Tensor('float32', x16, [1, x16.length]);
      const out = await cv.session.run({ [cv.inputName]: tensor });
      return out[cv.outputName];
    };
    let result;
    if (cv.layout) result = await run(cv.layout);
    else {
      try { result = await run('b1n'); cv.layout = 'b1n'; }
      catch (e) { this.log('ContentVec: (1,1,N) input rejected, trying (1,N): ' + (e.message || e)); result = await run('bn'); cv.layout = 'bn'; }
    }
    const d = result.dims;
    const data = result.data instanceof Float32Array ? result.data : Float32Array.from(result.data);
    let frames;
    if (d.length === 3 && d[2] === dims) { frames = d[1]; return { data, frames }; }          // (1, T, C)
    if (d.length === 3 && d[1] === dims) {                                                     // (1, C, T) → transpose
      frames = d[2];
      const t = new Float32Array(frames * dims);
      for (let c = 0; c < dims; c++) for (let f = 0; f < frames; f++) t[f * dims + c] = data[c * frames + f];
      return { data: t, frames };
    }
    if (d.length === 2 && d[1] === dims) { frames = d[0]; return { data, frames }; }
    throw new Error('Unexpected ContentVec output shape ' + JSON.stringify(d));
  }

  /** f0 (Hz) at 100 Hz for 16 kHz audio, `frames` long. method: 'yin' | 'rmvpe' | 'auto' */
  async pitchTrack(x16, frames, method = 'auto') {
    const useRmvpe = (method === 'rmvpe' || method === 'auto') && this.rmvpe;
    const yin = () => yinTrack16k(x16, frames);
    if (!useRmvpe) return { f0: yin(), method: 'yin' };
    try {
      const { mel, frames: mf, nMels } = rmvpeMel(x16, this.melBank);
      const padTo = 32 * Math.floor((mf - 1) / 32 + 1);
      const padded = new Float32Array(nMels * padTo);
      for (let m = 0; m < nMels; m++) {
        padded.set(mel.subarray(m * mf, m * mf + mf), m * padTo);
        for (let t = mf; t < padTo; t++) padded[m * padTo + t] = mel[m * mf + Math.max(0, mf - 2 - (t - mf))]; // reflect
      }
      const tensor = new this.ort.Tensor('float32', padded, [1, nMels, padTo]);
      const out = await this.rmvpe.session.run({ [this.rmvpe.inputName]: tensor });
      const hidden = out[this.rmvpe.outputName];
      const hd = hidden.data instanceof Float32Array ? hidden.data : Float32Array.from(hidden.data);
      const f0 = rmvpeDecode(hd, mf, 0.03);
      const track = resampleTrack(f0, frames);
      // sanity check against YIN: if RMVPE disagrees wildly the mel front-end is not matching → fall back
      if (method === 'auto') {
        const y = yin();
        const med = (a) => { const v = Array.from(a).filter((x) => x > 0).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 0; };
        const m1 = med(track), m2 = med(y);
        if (m2 > 0 && (m1 <= 0 || Math.abs(Math.log2(m1 / m2)) > 0.25)) { this.log(`RMVPE median ${m1.toFixed(1)} Hz vs YIN ${m2.toFixed(1)} Hz — using YIN`); return { f0: y, method: 'yin' }; }
      }
      return { f0: track, method: 'rmvpe' };
    } catch (e) {
      this.log('RMVPE failed, using YIN: ' + (e.message || e));
      return { f0: yin(), method: 'yin' };
    }
  }

  /** Run the generator for one 16 kHz segment; returns audio at the model's sample rate. */
  async synthesize(x16, { transpose = 0, f0Method = 'auto', speakerId } = {}) {
    const ort = this.ort, v = this.voice;
    if (!v) throw new Error('voice model not loaded');
    const { data: feats, frames } = await this.contentFeatures(x16);
    const dims = v.meta.dims || this.cv.dims;
    const T = frames * 2;
    const phone = new Float32Array(T * dims);
    for (let f = 0; f < frames; f++) {
      const src = feats.subarray(f * dims, f * dims + dims);
      phone.set(src, (2 * f) * dims); phone.set(src, (2 * f + 1) * dims);
    }
    const { f0, method } = await this.pitchTrack(x16, T, f0Method);
    const factor = Math.pow(2, transpose / 12);
    const pitchf = new Float32Array(T), pitch = new BigInt64Array(T);
    for (let i = 0; i < T; i++) { const hz = f0[i] > 0 ? f0[i] * factor : 0; pitchf[i] = hz; pitch[i] = BigInt(f0ToCoarse(hz)); }
    const feeds = {
      [v.names.phone]: new ort.Tensor('float32', phone, [1, T, dims]),
      [v.names.lengths]: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
      [v.names.pitch]: new ort.Tensor('int64', pitch, [1, T]),
      [v.names.pitchf]: new ort.Tensor('float32', pitchf, [1, T]),
      [v.names.ds]: new ort.Tensor('int64', BigInt64Array.from([BigInt(speakerId ?? v.meta.speakerId ?? 0)]), [1]),
      [v.names.rnd]: new ort.Tensor('float32', randn(192 * T, 0.66666), [1, 192, T]),
    };
    const out = await v.session.run(feeds);
    const audio = out[v.outputName];
    const data = audio.data instanceof Float32Array ? audio.data : Float32Array.from(audio.data);
    return { audio: data, frames: T, f0Method: method, f0 };
  }

  /**
   * Convert a whole clip.
   * @param {Float32Array} audio mono
   * @param {number} rate sample rate of `audio` (48000 in VoxMorph)
   * @param {object} opts { transpose, f0Method, speakerId, onProgress(fraction, label), chunkSec }
   * @returns {{ audio: Float32Array, f0Method: string, chunks: number }}
   */
  async convert(audio, rate, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const modelRate = this.voice.meta.sampleRate || 40000;
    const chunks = planChunks(audio, rate, { chunkSec: opts.chunkSec || 20 });
    const out = new Float32Array(audio.length);
    // One conditioning gain for the whole clip (not per chunk) so quiet and loud passages keep their relation
    // and chunk joins do not jump in level; the high-pass runs once over the whole clip for the same reason.
    const all16 = prepareInput16k(resampleTo(audio, rate, CV_RATE), 1);
    const gain = conditioningGain(all16);
    const toIdx16 = (i) => Math.min(all16.length, Math.round(i * CV_RATE / rate));
    const xf = Math.min(Math.round(rate * 0.02), Math.round(rate * 0.3)); // 20 ms equal-gain cross-fade at the joins
    let method = 'yin';
    const info = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci];
      const segStart = c.start - c.padStart, segEnd = c.end + c.padEnd;
      const x16 = all16.slice(toIdx16(segStart), toIdx16(segEnd));
      if (gain !== 1) for (let i = 0; i < x16.length; i++) x16[i] *= gain;
      onProgress(ci / chunks.length, `chunk ${ci + 1}/${chunks.length}`);
      const r = await this.synthesize(x16, opts);
      method = r.f0Method;
      { const v = Array.from(r.f0).filter((f) => f > 0).sort((a, b) => a - b); info.push({ start: c.start / rate, end: c.end / rate, f0Method: r.f0Method, frames: r.frames, voiced: v.length / Math.max(1, r.f0.length), medianF0: v.length ? v[v.length >> 1] : 0 }); }
      // model output covers T*hop samples at modelRate ≈ segment duration; bring to `rate`
      const segLen = segEnd - segStart;
      let y = r.audio;
      if (y.length > 0) {
        const expectedModel = Math.round(segLen * modelRate / rate);
        if (y.length > expectedModel) y = y.subarray(0, expectedModel);
        y = resampleTo(y, modelRate, rate);
      }
      const yy = new Float32Array(segLen);
      yy.set(y.subarray(0, Math.min(y.length, segLen)));
      // keep the body plus a short tail into the next chunk (taken from this chunk's end pad) for the cross-fade
      const bodyLen = c.end - c.start;
      const tail = ci < chunks.length - 1 ? Math.min(xf, c.padEnd) : 0;
      const head = ci > 0 ? Math.min(xf, chunks[ci - 1].padEnd) : 0; // the previous chunk wrote this far into our range
      for (let i = 0; i < bodyLen + tail; i++) {
        let g = 1;
        if (head && i < head) g = i / head;                       // fade in over the previous chunk's tail
        if (tail && i >= bodyLen) g = Math.min(g, (bodyLen + tail - i) / tail); // fade out into the next chunk
        out[c.start + i] += yy[c.padStart + i] * g;
      }
    }
    onProgress(1, 'done');
    return { audio: out, f0Method: method, chunks: chunks.length, chunkInfo: info };
  }
}
