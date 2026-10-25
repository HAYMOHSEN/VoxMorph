// Unit tests for the AI (RVC) front-end math and the engine flow with the mock runtime.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav } from './wav.mjs';
import { htkMelFilterbank, rmvpeMel, rmvpeDecode, f0ToCoarse, planChunks, resampleTo, RvcEngine, yinTrack16k, CV_RATE } from '../js/ai/rvc.js';
import { estimatePitch } from '../js/dsp/analysis.js';
import * as mockOrt from './mock-ort/ort.bundle.min.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failures++; };

// ---- 1. mel filterbank + log-mel vs an independent numpy implementation of librosa's HTK/slaney mel
const { samples: male } = readWav(path.join(here, 'data/male.wav'));
const x16 = resampleTo(male, 48000, CV_RATE);
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out/ai_x16.bin'), Buffer.from(x16.buffer, x16.byteOffset, x16.byteLength));
const fb = htkMelFilterbank(CV_RATE, 1024, 128, 30, 8000);
const { mel, frames } = rmvpeMel(x16.subarray(0, CV_RATE), fb); // first second
fs.writeFileSync(path.join(here, 'out/ai_fb.bin'), Buffer.from(fb.weights.buffer));
fs.writeFileSync(path.join(here, 'out/ai_mel.bin'), Buffer.from(mel.buffer));
const py = `
import numpy as np, sys, struct, wave
sr=16000; n_fft=1024; hop=160; n_mels=128; fmin=30.0; fmax=8000.0
def hz2mel(f): return 2595.0*np.log10(1.0+np.asarray(f)/700.0)
def mel2hz(m): return 700.0*(10.0**(np.asarray(m)/2595.0)-1.0)
mels=np.linspace(hz2mel(fmin),hz2mel(fmax),n_mels+2); mel_f=mel2hz(mels)
fftfreqs=np.linspace(0,sr/2,1+n_fft//2)
fdiff=np.diff(mel_f); ramps=np.subtract.outer(mel_f,fftfreqs)
w=np.zeros((n_mels,1+n_fft//2))
for i in range(n_mels):
    lower=-ramps[i]/fdiff[i]; upper=ramps[i+2]/fdiff[i+1]; w[i]=np.maximum(0,np.minimum(lower,upper))
enorm=2.0/(mel_f[2:n_mels+2]-mel_f[:n_mels]); w*=enorm[:,None]
js=np.fromfile(sys.argv[1],dtype=np.float32).reshape(n_mels,-1)
print('fb_maxdiff', float(np.max(np.abs(js-w))))
# log-mel of the first second (centre + reflect, periodic hann, magnitude)
x=np.fromfile(sys.argv[2],dtype=np.float32)[:sr].astype(np.float64)
pad=n_fft//2; xp=np.pad(x,(pad,pad),mode='reflect')
frames=1+len(x)//hop
win=0.5-0.5*np.cos(2*np.pi*np.arange(n_fft)/n_fft)
spec=np.stack([np.abs(np.fft.rfft(xp[t*hop:t*hop+n_fft]*win)) for t in range(frames)],axis=1)
melspec=np.log(np.maximum(w@spec,1e-5))
jm=np.fromfile(sys.argv[3],dtype=np.float32).reshape(n_mels,-1)
print('frames', frames, jm.shape[1])
print('mel_maxdiff', float(np.max(np.abs(jm-melspec))))
`;
const out = execFileSync('python3', ['-I', '-c', py, path.join(here, 'out/ai_fb.bin'), path.join(here, 'out/ai_x16.bin'), path.join(here, 'out/ai_mel.bin')]).toString();
const fbDiff = Number(out.match(/fb_maxdiff ([\d.e-]+)/)[1]), melDiff = Number(out.match(/mel_maxdiff ([\d.e-]+)/)[1]);
check(fbDiff < 1e-6, `HTK/slaney mel filterbank matches the numpy reference (max diff ${fbDiff.toExponential(2)})`);
check(melDiff < 1e-3, `RMVPE log-mel matches the numpy reference (max diff ${melDiff.toExponential(2)}, ${frames} frames)`);

// ---- 2. coarse pitch mapping vs the RVC formula
{
  const f0MelMin = 1127 * Math.log(1 + 50 / 700), f0MelMax = 1127 * Math.log(1 + 1100 / 700);
  let ok = true;
  for (const f0 of [0, 20, 50, 80, 117, 150, 210, 300, 440, 800, 1100, 2000]) {
    let ref;
    if (f0 <= 0) ref = 1; else { let m = 1127 * Math.log(1 + f0 / 700); m = (m - f0MelMin) * 254 / (f0MelMax - f0MelMin) + 1; ref = m <= 1 ? 1 : m > 255 ? 255 : Math.round(m); }
    if (f0ToCoarse(f0) !== ref) ok = false;
  }
  check(ok, 'coarse pitch codes match the RVC mapping (1..255)');
}

// ---- 3. RMVPE decoder on a synthetic salience peak at 150 Hz
{
  const framesN = 10, hidden = new Float32Array(framesN * 360);
  const cents = 1200 * Math.log2(150 / 10), cb = (cents - 1997.3794084376191) / 20;
  for (let f = 0; f < framesN; f++) for (let b = 0; b < 360; b++) hidden[f * 360 + b] = f < 8 ? Math.exp(-0.5 * Math.pow((b - cb) / 1.2, 2)) : 0.01;
  const f0 = rmvpeDecode(hidden, framesN, 0.03);
  check(Math.abs(f0[0] - 150) < 1.5 && f0[9] === 0, `RMVPE decode → ${f0[0].toFixed(1)} Hz for a 150 Hz peak, 0 for silence`);
}

// ---- 4. chunk planning on a long signal
{
  const long = new Float32Array(48000 * 45);
  for (let i = 0; i < long.length; i++) long[i] = (Math.floor(i / 48000) % 5 === 4) ? 0 : 0.3 * Math.sin(i * 0.02);
  const chunks = planChunks(long, 48000, { chunkSec: 20 });
  const covered = chunks.every((c, i) => i === 0 ? c.start === 0 : c.start === chunks[i - 1].end) && chunks[chunks.length - 1].end === long.length;
  const quietCuts = chunks.slice(1).every((c) => Math.abs(long[c.start]) < 1e-6);
  check(chunks.length === 3 && covered && quietCuts, `45 s split into ${chunks.length} contiguous chunks cut inside silent seconds`);
}

// ---- 5. YIN track on 16 kHz speech
{
  const f0 = yinTrack16k(x16, Math.floor(x16.length / 160) * 1 + 1);
  const v = Array.from(f0).filter((x) => x > 0).sort((a, b) => a - b);
  check(v.length > f0.length * 0.5 && Math.abs(v[v.length >> 1] - 116.6) < 3, `YIN track: median ${v[v.length >> 1].toFixed(1)} Hz, ${Math.round(v.length / f0.length * 100)}% voiced`);
}

// ---- 6. engine flow with the mock runtime: pitch follows the transpose, length preserved, chunking works
{
  const ort = mockOrt;
  const engine = new RvcEngine(ort, { executionProviders: ['wasm'], log: () => {} });
  await engine.loadContentVec(new TextEncoder().encode('{"kind":"contentvec","dims":768}'));
  await engine.loadVoice(new TextEncoder().encode('{"kind":"rvc","sampleRate":40000}'), { id: 'v', sampleRate: 40000 });
  const r = await engine.convert(male, 48000, { transpose: 12, f0Method: 'yin' });
  const p = estimatePitch(r.audio, 48000);
  check(r.audio.length === male.length, `output length ${r.audio.length} = input length`);
  check(Math.abs(p.f0Median - 2 * 116.6) / 233.2 < 0.05, `+12 st transpose → output pitch ${p.f0Median.toFixed(1)} Hz (expected ≈ 233)`);
  check(r.f0Method === 'yin' && r.chunks === 1, `f0 method ${r.f0Method}, ${r.chunks} chunk`);
  // RMVPE path with the mock (fixed 150 Hz salience) and the YIN sanity check
  await engine.loadRmvpe(new TextEncoder().encode('{"kind":"rmvpe","hz":150}'));
  const r2 = await engine.convert(male, 48000, { transpose: 0, f0Method: 'rmvpe' });
  const p2 = estimatePitch(r2.audio, 48000);
  check(Math.abs(p2.f0Median - 150) < 5, `RMVPE path drives the generator (mock 150 Hz → output ${p2.f0Median.toFixed(1)} Hz)`);
  const r3 = await engine.convert(male, 48000, { transpose: 0, f0Method: 'auto' });
  check(r3.f0Method === 'yin', `auto mode falls back to YIN when RMVPE disagrees (${r3.f0Method})`);
  // long input → several chunks, 48 kHz model
  const long = new Float32Array(48000 * 45);
  for (let i = 0; i < long.length; i++) long[i] = (Math.floor(i / 48000) % 5 === 4) ? 0 : male[i % male.length];
  await engine.loadVoice(new TextEncoder().encode('{"kind":"rvc","sampleRate":48000}'), { id: 'v48', sampleRate: 48000 });
  const r4 = await engine.convert(long, 48000, { transpose: -5, f0Method: 'yin' });
  const p4 = estimatePitch(r4.audio.subarray(0, 48000 * 3), 48000);
  check(r4.chunks === 3 && r4.audio.length === long.length && Math.abs(p4.f0Median - 116.6 * Math.pow(2, -5 / 12)) < 5, `45 s clip: ${r4.chunks} chunks, length kept, −5 st → ${p4.f0Median.toFixed(1)} Hz`);
  // ContentVec (1,C,T) layout and rank-2 input fallback
  const engine2 = new RvcEngine(ort, { executionProviders: ['wasm'], log: () => {} });
  await engine2.loadContentVec(new TextEncoder().encode('{"kind":"contentvec","dims":768,"layoutBct":true,"rejectRank3":true}'));
  await engine2.loadVoice(new TextEncoder().encode('{"kind":"rvc","sampleRate":40000}'), { id: 'v', sampleRate: 40000 });
  const r5 = await engine2.convert(male.subarray(0, 48000), 48000, { transpose: 0, f0Method: 'yin' });
  check(engine2.cv.layout === 'bn' && r5.audio.length === 48000, 'ContentVec variants: (1,N) input fallback and (1,C,T) output transpose');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL AI CHECKS PASSED');
process.exit(failures ? 1 : 0);
