import { SpectralStage } from '../js/dsp/spectral.js';
import { writeWav } from './wav.mjs';
// noise through 3 resonators (no harmonics), then warp by 1.3 and 0.85
const fs = 48000, n = fs * 2;
let seed = 1; const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296 * 2 - 1; };
function resonate(x, f, bw) { const r = Math.exp(-Math.PI * bw / fs), th = 2 * Math.PI * f / fs; const a1 = -2 * r * Math.cos(th), a2 = r * r; const y = new Float32Array(x.length); let y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = x[i] - a1 * y1 - a2 * y2; y[i] = v; y2 = y1; y1 = v; } return y; }
let x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = rnd();
for (const [f, bw] of [[700, 80], [1200, 100], [2600, 140]]) x = resonate(x, f, bw);
let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v)); for (let i = 0; i < n; i++) x[i] /= peak * 2;
writeWav('test/out/noise_in.wav', x, fs);
for (const w of [1.3, 0.85]) {
  const st = new SpectralStage(fs, { frameSize: 2048 });
  st.setWarp(w); st.setLifter(120);
  const parts = []; for (let i = 0; i < n; i += 4096) parts.push(st.process(x.subarray(i, Math.min(n, i + 4096)))); parts.push(st.flush());
  let t = 0; for (const p of parts) t += p.length; const y = new Float32Array(t); let o = 0; for (const p of parts) { y.set(p, o); o += p.length; }
  writeWav(`test/out/noise_w${w}.wav`, y.subarray(0, n), fs);
}
console.log('done');
