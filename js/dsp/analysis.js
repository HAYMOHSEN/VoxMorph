// VoxMorph DSP — analysis helpers: YIN pitch estimation, loudness (BS.1770-style), peak/normalise.

import { Biquad } from './effects.js';

// Decimate by an integer factor with a 2-stage low-pass first
function decimate(signal, fs, factor) {
  const cutoff = (fs / factor) * 0.42;
  const lp1 = Biquad.lowpass(fs, cutoff, 0.54), lp2 = Biquad.lowpass(fs, cutoff, 1.31);
  const out = new Float32Array(Math.floor(signal.length / factor));
  let j = 0;
  for (let i = 0; i < signal.length; i++) {
    const y = lp2.tick(lp1.tick(signal[i]));
    if (i % factor === 0 && j < out.length) out[j++] = y;
  }
  return out;
}

/**
 * Estimate the fundamental frequency track and its median with the YIN algorithm.
 * Returns { f0Median, f0Mean, voicedRatio, track: [{t, f0, voiced}], rmsDb }.
 */
export function estimatePitch(signal, fs, { fMin = 60, fMax = 520 } = {}) {
  const factor = Math.max(1, Math.floor(fs / 16000));
  const x = factor > 1 ? decimate(signal, fs, factor) : signal;
  const sr = fs / factor;
  const W = 1024, hop = Math.round(sr * 0.01);
  const tauMin = Math.max(2, Math.floor(sr / fMax)), tauMax = Math.min(W - 1, Math.ceil(sr / fMin));
  const d = new Float64Array(tauMax + 1), cmnd = new Float64Array(tauMax + 1);
  const track = [];
  const f0s = [];
  let sumSq = 0;
  for (let i = 0; i < signal.length; i++) sumSq += signal[i] * signal[i];
  const rmsDb = 10 * Math.log10(sumSq / Math.max(1, signal.length) + 1e-12);
  const silenceDb = Math.max(-60, rmsDb - 25);
  for (let start = 0; start + W + tauMax < x.length; start += hop) {
    let e = 0;
    for (let i = 0; i < W; i++) e += x[start + i] * x[start + i];
    const frameDb = 10 * Math.log10(e / W + 1e-12);
    let voiced = false, f0 = 0;
    if (frameDb > silenceDb) {
      // difference function
      for (let tau = tauMin; tau <= tauMax; tau++) {
        let s = 0;
        for (let i = 0; i < W; i++) { const diff = x[start + i] - x[start + i + tau]; s += diff * diff; }
        d[tau] = s;
      }
      // cumulative mean normalised difference
      let run = 0;
      cmnd[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) {
        const v = tau >= tauMin ? d[tau] : 0;
        run += v;
        cmnd[tau] = tau >= tauMin && run > 0 ? d[tau] * tau / run : 1;
      }
      // absolute threshold
      let tauEst = -1;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cmnd[tau] < 0.15) {
          while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
          tauEst = tau; break;
        }
      }
      if (tauEst < 0) {
        let best = tauMin, bv = Infinity;
        for (let tau = tauMin; tau <= tauMax; tau++) if (cmnd[tau] < bv) { bv = cmnd[tau]; best = tau; }
        if (bv < 0.35) tauEst = best;
      }
      if (tauEst > 0) {
        // parabolic interpolation
        let t = tauEst;
        if (t > tauMin && t < tauMax) {
          const a = cmnd[t - 1], b = cmnd[t], c = cmnd[t + 1];
          const denom = a - 2 * b + c;
          if (Math.abs(denom) > 1e-12) t = t + 0.5 * (a - c) / denom;
        }
        f0 = sr / t;
        voiced = f0 >= fMin && f0 <= fMax;
        if (voiced) f0s.push(f0);
      }
    }
    track.push({ t: start / sr, f0: voiced ? f0 : 0, voiced });
  }
  const sorted = f0s.slice().sort((a, b) => a - b);
  const f0Median = sorted.length ? sorted[sorted.length >> 1] : 0;
  const f0Mean = f0s.length ? f0s.reduce((a, b) => a + b, 0) / f0s.length : 0;
  return { f0Median, f0Mean, voicedRatio: track.length ? f0s.length / track.length : 0, track, rmsDb };
}

/** Integrated loudness in LUFS (mono, K-weighting approximated with RBJ filters, gated as in BS.1770). */
export function measureLoudness(signal, fs) {
  const hs = Biquad.highshelf(fs, 1681, 3.99, 0.7071);
  const hp = Biquad.highpass(fs, 38, 0.5);
  const block = Math.round(fs * 0.4), step = Math.round(fs * 0.1);
  if (signal.length < block) {
    let s = 0;
    for (let i = 0; i < signal.length; i++) { const y = hp.tick(hs.tick(signal[i])); s += y * y; }
    return -0.691 + 10 * Math.log10(s / Math.max(1, signal.length) + 1e-12);
  }
  const y = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) y[i] = hp.tick(hs.tick(signal[i]));
  const blocks = [];
  for (let s = 0; s + block <= y.length; s += step) {
    let e = 0;
    for (let i = 0; i < block; i++) e += y[s + i] * y[s + i];
    blocks.push(e / block);
  }
  const toL = (ms) => -0.691 + 10 * Math.log10(ms + 1e-12);
  const abs = blocks.filter((ms) => toL(ms) > -70);
  if (!abs.length) return -70;
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const relGate = toL(meanAbs) - 10;
  const rel = abs.filter((ms) => toL(ms) > relGate);
  const mean = rel.length ? rel.reduce((a, b) => a + b, 0) / rel.length : meanAbs;
  return toL(mean);
}

export function peakAbs(signal) {
  let p = 0;
  for (let i = 0; i < signal.length; i++) { const a = Math.abs(signal[i]); if (a > p) p = a; }
  return p;
}

/** Scale to a loudness target (LUFS) without exceeding a peak ceiling (dBFS). Returns the applied gain. */
export function normalizeInPlace(signal, fs, { targetLufs = -16, ceilingDb = -1 } = {}) {
  const lufs = measureLoudness(signal, fs);
  let g = Math.pow(10, (targetLufs - lufs) / 20);
  const peak = peakAbs(signal);
  const ceiling = Math.pow(10, ceilingDb / 20);
  if (peak * g > ceiling) g = ceiling / Math.max(peak, 1e-9);
  for (let i = 0; i < signal.length; i++) signal[i] *= g;
  return g;
}

export function peakNormalizeInPlace(signal, ceilingDb = -1) {
  const peak = peakAbs(signal);
  const g = peak > 1e-9 ? Math.pow(10, ceilingDb / 20) / peak : 1;
  for (let i = 0; i < signal.length; i++) signal[i] *= g;
  return g;
}
