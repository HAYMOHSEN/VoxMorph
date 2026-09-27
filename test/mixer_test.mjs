import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav } from './wav.mjs';
import { mixWithMusic, duckingEnvelope, musicLoudness } from '../js/dsp/mixer.js';
import { measureLoudness, peakAbs } from '../js/dsp/analysis.js';
import { renderOffline, analyzeVoice } from '../js/dsp/pipeline.js';
import { defaultSettings, PRESETS, resolveSettings } from '../js/dsp/presets.js';
import { estimatePitch } from '../js/dsp/analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fs48 = 48000;
let failures = 0;
const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failures++; };

// voice: converted broadcaster from the male test clip; music: stereo test track
const { samples: male } = readWav(path.join(here, 'data/male.wav'));
const info = analyzeVoice(male, fs48);
const s = defaultSettings(); s.preset = 'broadcaster';
const voice = renderOffline(male, fs48, s, { voiceInfo: info }).audio;
// stereo music from file (readWav mixes to mono; make a fake stereo by delaying the right channel a bit)
const { samples: musicMono } = readWav(path.join(here, 'data/music.wav'));
const R = new Float32Array(musicMono.length); R.set(musicMono.subarray(0, musicMono.length - 200), 200);
const music = { L: musicMono, R };
const lufs = musicLoudness(music.L, music.R, fs48);
console.log(`voice ${(voice.length / fs48).toFixed(2)} s @ ${measureLoudness(voice, fs48).toFixed(1)} LUFS; music ${(music.L.length / fs48).toFixed(2)} s @ ${lufs.toFixed(1)} LUFS`);

const opts = { musicDb: 0, duckDb: 12, introSec: 1.5, outroSec: 2, fadeOutSec: 2, loop: true };
const t0 = Date.now();
const mix = mixWithMusic(voice, music, fs48, opts);
console.log(`mix took ${Date.now() - t0} ms`);
const expectedLen = Math.round(1.5 * fs48) + voice.length + Math.round(2 * fs48);
check(mix.L.length === expectedLen && mix.R.length === expectedLen, `mix length ${mix.L.length} = intro + voice + outro (${expectedLen})`);
check(mix.voiceStart === Math.round(1.5 * fs48), `voice starts at ${mix.voiceStart} samples (1.5 s)`);
check(peakAbs(mix.L) <= Math.pow(10, -1 / 20) + 1e-3 && peakAbs(mix.R) <= Math.pow(10, -1 / 20) + 1e-3, `peaks limited to -1 dBFS (L ${(20 * Math.log10(peakAbs(mix.L))).toFixed(2)} dB, R ${(20 * Math.log10(peakAbs(mix.R))).toFixed(2)} dB)`);
// stereo: channels differ (music is stereo) but voice is centred
let diff = 0; for (let i = 0; i < 48000; i++) diff += Math.abs(mix.L[i] - mix.R[i]);
check(diff > 1, 'output is genuinely stereo during the intro');
// ducking: music level in the intro (no voice) vs during a voiced vowel (0.25-0.5 s into the voice)
const rms = (a, s0, s1) => { let e = 0; for (let i = s0; i < s1; i++) e += a[i] * a[i]; return 10 * Math.log10(e / (s1 - s0) + 1e-12); };
const musicOnly = mixWithMusic(new Float32Array(voice.length), music, fs48, opts); // same timeline, silent voice → no ducking
const introDb = rms(mix.L, Math.round(0.6 * fs48), Math.round(1.3 * fs48));
const introRef = rms(musicOnly.L, Math.round(0.6 * fs48), Math.round(1.3 * fs48));
const a0 = mix.voiceStart + Math.round(0.4 * fs48), a1 = mix.voiceStart + Math.round(0.6 * fs48);
const duringRef = rms(musicOnly.L, a0, a1);
// compare the music-only bed under speech with the bed while ducked (mix minus voice ≈ ducked bed)
const bedDucked = new Float32Array(a1 - a0); for (let i = a0; i < a1; i++) bedDucked[i - a0] = mix.L[i] - voice[i - mix.voiceStart];
const duckedDb = rms(bedDucked, 0, bedDucked.length);
console.log(`  music in intro: ${introDb.toFixed(1)} dB (unducked ref ${introRef.toFixed(1)}), bed under speech: ${duckedDb.toFixed(1)} dB vs unducked ${duringRef.toFixed(1)} dB`);
check(Math.abs(introDb - introRef) < 0.5, 'no ducking before the voice starts');
check(duringRef - duckedDb > 9 && duringRef - duckedDb < 15, `music ducked by ~12 dB under speech (measured ${(duringRef - duckedDb).toFixed(1)} dB)`);
// fade out: last 100 ms nearly silent
check(rms(mix.L, mix.L.length - Math.round(0.1 * fs48), mix.L.length) < -40, 'fade-out reaches silence at the end');
// loop: with a 3.1 s voice + 3.5 s of intro/outro the 7.4 s music barely loops; test a long voice explicitly
const shortMusic = { L: music.L.subarray(0, fs48 * 8), R: music.R.subarray(0, fs48 * 8) };
const longVoice = new Float32Array(fs48 * 20);
const longMix = mixWithMusic(longVoice, shortMusic, fs48, { musicDb: 0, duckDb: 0, introSec: 0, outroSec: 0, fadeOutSec: 0.5, loop: true });
const seam = shortMusic.L.length; // first loop point
let maxJump = 0; for (let i = seam - 5; i < seam + 5; i++) maxJump = Math.max(maxJump, Math.abs(longMix.L[i + 1] - longMix.L[i]));
check(rms(longMix.L, seam + fs48, seam + 2 * fs48) > -40, 'music keeps playing after the loop point');
check(maxJump < 0.2, `loop seam is smooth (max sample jump ${maxJump.toFixed(3)})`);
const noLoop = mixWithMusic(longVoice, shortMusic, fs48, { musicDb: 0, duckDb: 0, introSec: 0, outroSec: 0, fadeOutSec: 0.5, loop: false });
check(rms(noLoop.L, seam + fs48, seam + 2 * fs48) < -60, 'loop=false: music stops after it ends');
// music level control
const louder = mixWithMusic(new Float32Array(voice.length), music, fs48, { ...opts, musicDb: 6 });
check(Math.abs((rms(louder.L, Math.round(0.6 * fs48), Math.round(1.3 * fs48)) - introRef) - 6) < 0.6, 'musicDb +6 raises the bed by 6 dB');
writeWav(path.join(here, 'out/mix_L.wav'), mix.L, fs48);
fs.writeFileSync(path.join(here, 'out/mix_stereo.raw'), Buffer.concat([Buffer.from(mix.L.buffer), Buffer.from(mix.R.buffer)]));

// ---- new presets: every preset renders and lands on its pitch target (auto mode, male source)
console.log('\npresets (male source, auto):');
for (const id of Object.keys(PRESETS)) {
  const st = defaultSettings(); st.preset = id;
  const r = renderOffline(male, fs48, st, { voiceInfo: info });
  const p = estimatePitch(r.audio, fs48);
  const expected = info.f0Median * r.params.pitchRatio;
  const pitchOk = id === 'fx_robot' ? true : Math.abs(p.f0Median - expected) / expected < 0.05; // ring modulation deliberately breaks the harmonic pitch
  const ok = r.audio.length === male.length && pitchOk && !Number.isNaN(peakAbs(r.audio));
  check(ok, `${id.padEnd(13)} P=${r.params.pitchRatio.toFixed(2)} F=${r.params.formantRatio.toFixed(2)} → f0 ${p.f0Median.toFixed(0)} Hz (expected ${expected.toFixed(0)}), peak ${peakAbs(r.audio).toFixed(2)}`);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL MIXER/PRESET CHECKS PASSED');
process.exit(failures ? 1 : 0);
