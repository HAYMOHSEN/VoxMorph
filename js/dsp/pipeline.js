// VoxMorph DSP — the voice pipeline (streaming) and the offline renderer.
//
//   input → HPF → spectral stage (noise reduction + formant warp + anti-alias)
//         → gate → WSOLA time-stretch → resampler (pitch) → tremor → breath → roughness
//         → EQ (tone / radio chain) → compressor → limiter → (offline: loudness normalise)

import { SpectralStage, estimateNoiseProfile } from './spectral.js';
import { WSOLA, Resampler } from './timescale.js';
import { Biquad, FilterChain, Tremor, Breath, Roughness, Gate, Compressor, Limiter } from './effects.js';
import { estimatePitch, normalizeInPlace, measureLoudness, peakAbs } from './analysis.js';
import { resolveSettings } from './presets.js';

export { resolveSettings } from './presets.js';
export { estimatePitch, measureLoudness } from './analysis.js';

export class VoicePipeline {
  /**
   * @param {number} fs
   * @param {'offline'|'live'} mode
   */
  constructor(fs, mode = 'offline') {
    this.fs = fs;
    this.mode = mode;
    this.live = mode === 'live';
    this.configured = false;
  }

  /**
   * (Re)build the chain for the given resolved parameters.
   * @param {object} p  from resolveSettings()
   * @param {object|null} voiceInfo  { f0Median }
   * @param {Float64Array|null} noiseProfile  measured noise PSD for offline NR
   */
  configure(p, voiceInfo = null, noiseProfile = null) {
    const fs = this.fs, live = this.live;
    this.p = p;
    this.hp = Biquad.highpass(fs, 50, 0.7071);

    this.spectral = new SpectralStage(fs, { frameSize: live ? 1024 : 2048 });
    this.spectral.setWarp(p.formantRatio / p.pitchRatio);
    this.spectral.setAntiAlias(p.pitchRatio > 1 ? (fs / 2) / p.pitchRatio * 0.94 : fs / 2);
    this.spectral.setLifter(voiceInfo && voiceInfo.f0Median ? voiceInfo.f0Median : 120);
    this.spectral.setNoiseReduction(p.nr.enabled, p.nr.strength);
    if (noiseProfile) this.spectral.setNoiseProfile(noiseProfile);

    this.gate = new Gate(fs);
    this.gate.set({ enabled: p.gate.enabled, thresholdDb: p.gate.thresholdDb });

    this.shift = Math.abs(p.pitchRatio - 1) > 1e-3;
    if (this.shift) {
      this.wsola = new WSOLA(fs, { frameMs: live ? 26 : 32, toleranceMs: live ? 6 : 8, ratio: p.pitchRatio });
      this.resampler = new Resampler(p.pitchRatio);
    }

    this.tremor = new Tremor(fs);
    this.tremor.set({ amount: p.tremor, rate: 6.3, cents: 40, tremolo: 0.25 });
    this.breath = new Breath(fs);
    this.breath.set(p.breath);
    this.rough = new Roughness(fs);
    this.rough.set(p.rough);

    const eq = [];
    if (p.radio) {
      eq.push(Biquad.highpass(fs, 80, 0.7071));
      eq.push(Biquad.lowshelf(fs, 130, 2.5));
      eq.push(Biquad.peaking(fs, 350, -2, 1.2));
      eq.push(Biquad.peaking(fs, 3200, 3, 0.8));
      eq.push(Biquad.peaking(fs, 7000, -1.5, 2));
      eq.push(Biquad.highshelf(fs, 10000, 1.5));
    }
    if (Math.abs(p.brightness) > 0.05) eq.push(Biquad.highshelf(fs, 4000, p.brightness));
    if (Math.abs(p.warmth) > 0.05) eq.push(Biquad.lowshelf(fs, 180, p.warmth));
    this.eq = new FilterChain(eq);

    this.comp = new Compressor(fs);
    const c = p.compress;
    this.comp.set({
      enabled: c > 0.02,
      thresholdDb: -(10 + 16 * c),
      ratio: 1.5 + 4 * c,
      attackMs: p.radio ? 4 : 8,
      releaseMs: p.radio ? 70 : 120,
      kneeDb: 6,
      makeupDb: live ? 2 + 8 * c : 4 + 8 * c,
    });
    this.limiter = new Limiter(fs, { ceilingDb: -1, lookaheadMs: live ? 3 : 5 });
    this.configured = true;
    this.flushed = false;
  }

  /** Output delay in samples (limiter look-ahead; the other stages are delay-compensated). */
  get latency() { return this.limiter ? this.limiter.latency : 0; }

  /** Process a chunk; returns whatever output became available (may be empty). */
  process(chunk) {
    const x = new Float32Array(chunk);
    this.hp.processInPlace(x);
    let y = this.spectral.process(x);
    return this._tail(y);
  }

  flush() {
    if (this.flushed) return new Float32Array(0);
    this.flushed = true;
    let y = this.spectral.flush();
    let out = this._tail(y, true);
    return out;
  }

  _tail(y, final = false) {
    if (y.length) this.gate.processInPlace(y);
    if (this.shift) {
      let t = y.length ? this.wsola.process(y) : new Float32Array(0);
      if (final) t = concat(t, this.wsola.flush());
      let r = t.length ? this.resampler.process(t) : new Float32Array(0);
      if (final) r = concat(r, this.resampler.flush());
      y = r;
    }
    if (final) {
      // push silence through the limiter look-ahead so the tail comes out
      y = concat(y, new Float32Array(this.limiter.latency));
    }
    if (!y.length) return y;
    this.tremor.processInPlace(y);
    this.breath.processInPlace(y);
    this.rough.processInPlace(y);
    this.eq.processInPlace(y);
    this.comp.processInPlace(y);
    this.limiter.processInPlace(y);
    return y;
  }
}

export function concat(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

/**
 * Analyse a clip: pitch statistics + loudness. Cheap enough to run on import.
 */
export function analyzeVoice(signal, fs) {
  // Pitch statistics from the first 60 s are plenty to characterise the speaker; loudness uses the whole clip.
  const maxLen = Math.min(signal.length, fs * 60);
  const info = estimatePitch(maxLen < signal.length ? signal.subarray(0, maxLen) : signal, fs);
  info.lufs = measureLoudness(signal, fs);
  info.peak = peakAbs(signal);
  info.voiceClass = info.f0Median <= 0 ? 'unknown' : info.f0Median > 165 ? 'high' : 'low';
  return info;
}

/**
 * Render a whole clip offline with the streaming pipeline.
 * @param {Float32Array} signal mono
 * @param {number} fs
 * @param {object} settings user settings (see presets.defaultSettings)
 * @param {object} [opts] { voiceInfo, onProgress(fraction) }
 * @returns {{ audio: Float32Array, voiceInfo: object, params: object, gain: number }}
 */
export function renderOffline(signal, fs, settings, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const voiceInfo = opts.voiceInfo || analyzeVoice(signal, fs);
  onProgress(0.05);
  const params = resolveSettings(settings, voiceInfo);
  const noiseProfile = params.nr.enabled ? estimateNoiseProfile(signal, fs, 2048) : null;
  onProgress(0.1);
  const pipe = new VoicePipeline(fs, 'offline');
  pipe.configure(params, voiceInfo, noiseProfile);
  const chunk = 8192;
  const parts = [];
  let total = 0;
  for (let i = 0; i < signal.length; i += chunk) {
    const y = pipe.process(signal.subarray(i, Math.min(signal.length, i + chunk)));
    if (y.length) { parts.push(y); total += y.length; }
    if ((i / chunk) % 8 === 0) onProgress(0.1 + 0.85 * (i / signal.length));
  }
  const tail = pipe.flush();
  if (tail.length) { parts.push(tail); total += tail.length; }
  let out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  // Align: drop the limiter delay, then fit exactly to the input length
  const start = pipe.latency;
  const aligned = new Float32Array(signal.length);
  const n = Math.min(signal.length, Math.max(0, out.length - start));
  aligned.set(out.subarray(start, start + n));
  // Short fade at both ends against clicks
  const fade = Math.min(Math.round(fs * 0.005), aligned.length >> 1);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    aligned[i] *= g;
    aligned[aligned.length - 1 - i] *= g;
  }
  let gain = 1;
  if (params.normalize.enabled) gain = normalizeInPlace(aligned, fs, { targetLufs: params.normalize.targetLufs, ceilingDb: -1 });
  onProgress(1);
  return { audio: aligned, voiceInfo, params, gain };
}
