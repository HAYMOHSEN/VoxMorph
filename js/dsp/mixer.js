// VoxMorph DSP — background-music mixer: places the converted voice over a stereo music bed with
// automatic ducking (the music dips while the voice speaks), an intro/outro, fades, seamless looping
// and a stereo-linked look-ahead limiter. Pure JS, used inside the render worker.

import { Limiter } from './effects.js';
import { measureLoudness } from './analysis.js';

export const DEFAULT_MIX = { enabled: false, musicDb: 0, duckDb: 12, introSec: 1.5, outroSec: 2, fadeOutSec: 2, loop: true };
const MUSIC_REF_LUFS = -22;   // music level at musicDb = 0 (voice is normalised to about -16 LUFS)

/** Integrated loudness of a stereo track (mono downmix), for level-referencing the music. */
export function musicLoudness(L, R, fs) {
  const n = L.length;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = 0.5 * (L[i] + (R ? R[i] : L[i]));
  return measureLoudness(m, fs);
}

/**
 * Ducking envelope: 1 where the voice is silent, `duckGain` where it speaks, with smooth transitions.
 * @returns Float32Array(voice.length)
 */
export function duckingEnvelope(voice, fs, duckDb) {
  const n = voice.length;
  const out = new Float32Array(n);
  const duckGain = Math.pow(10, -Math.max(0, duckDb) / 20);
  const thr = Math.pow(10, -45 / 20);
  const envAtt = Math.exp(-1 / (fs * 0.005)), envRel = Math.exp(-1 / (fs * 0.08));
  const gAtt = Math.exp(-1 / (fs * 0.06)), gRel = Math.exp(-1 / (fs * 0.7));
  let env = 0, g = 1;
  // look-ahead: run the presence detector 60 ms ahead so the music is already down when speech starts
  const ahead = Math.round(fs * 0.06);
  const pres = new Uint8Array(n + ahead);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(voice[i]);
    env = a > env ? envAtt * env + (1 - envAtt) * a : envRel * env + (1 - envRel) * a;
    pres[i] = env > thr ? 1 : 0;
  }
  for (let i = 0; i < n; i++) {
    let target = 1;
    // present now or within the look-ahead window → duck
    if (pres[i]) target = duckGain;
    else if (pres[Math.min(n - 1, i + ahead)]) target = duckGain;
    g = target < g ? gAtt * g + (1 - gAtt) * target : gRel * g + (1 - gRel) * target;
    out[i] = g;
  }
  return out;
}

/**
 * Mix a mono voice with a stereo music bed.
 * @param {Float32Array} voice mono, already loudness-normalised
 * @param {{L: Float32Array, R: Float32Array, lufs?: number}} music
 * @param {number} fs
 * @param {object} opts see DEFAULT_MIX
 * @returns {{ L: Float32Array, R: Float32Array, voiceStart: number }}
 */
export function mixWithMusic(voice, music, fs, opts = {}) {
  const o = Object.assign({}, DEFAULT_MIX, opts);
  const intro = Math.round(Math.max(0, o.introSec) * fs), outro = Math.round(Math.max(0, o.outroSec) * fs);
  const fadeIn = Math.round(0.4 * fs), fadeOut = Math.round(Math.max(0.05, o.fadeOutSec) * fs);
  const total = intro + voice.length + outro;
  const mL = music.L, mR = music.R || music.L, mLen = mL.length;
  const lufs = Number.isFinite(music.lufs) ? music.lufs : musicLoudness(mL, mR, fs);
  const musicGain = Math.pow(10, (MUSIC_REF_LUFS - lufs + o.musicDb) / 20);
  const L = new Float32Array(total), R = new Float32Array(total);
  // ducking envelope over the whole timeline (voice padded with silence)
  const padded = new Float32Array(total);
  padded.set(voice, intro);
  const duck = duckingEnvelope(padded, fs, o.duckDb);
  const xf = Math.min(Math.round(0.03 * fs), Math.floor(mLen / 4)); // loop cross-fade
  const loop = o.loop !== false && mLen > 0;
  for (let i = 0; i < total; i++) {
    let ml = 0, mr = 0;
    if (mLen > 0 && (loop || i < mLen)) {
      const j = loop ? i % mLen : i;
      if (loop && j < xf && i >= mLen) {
        const w = j / xf;
        const k = mLen - xf + j;
        ml = mL[j] * w + mL[k] * (1 - w);
        mr = mR[j] * w + mR[k] * (1 - w);
      } else { ml = mL[j]; mr = mR[j]; }
      if (!loop && j >= mLen - xf) { const w = (mLen - j) / xf; ml *= w; mr *= w; }
    }
    let g = musicGain * duck[i];
    if (i < fadeIn) g *= i / fadeIn;
    if (i >= total - fadeOut) g *= (total - i) / fadeOut;
    L[i] = ml * g; R[i] = mr * g;
  }
  for (let i = 0; i < voice.length; i++) { const v = voice[i]; L[intro + i] += v; R[intro + i] += v; }
  const lim = new Limiter(fs, { ceilingDb: -1, lookaheadMs: 5 });
  // push the delay through by processing extra silence, then realign
  const extra = lim.latency;
  const L2 = new Float32Array(total + extra), R2 = new Float32Array(total + extra);
  L2.set(L); R2.set(R);
  lim.processStereoInPlace(L2, R2);
  return { L: L2.subarray(extra, extra + total), R: R2.subarray(extra, extra + total), voiceStart: intro };
}
