// Render test signals through the DSP pipeline and write results for analysis.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav } from './wav.mjs';
import { renderOffline, analyzeVoice, VoicePipeline, resolveSettings } from '../js/dsp/pipeline.js';
import { defaultSettings } from '../js/dsp/presets.js';
import { estimatePitch } from '../js/dsp/analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

function settingsFor(preset, extra = {}) {
  const s = defaultSettings();
  s.preset = preset;
  Object.assign(s, extra);
  return s;
}

function stats(a) {
  let peak = 0, sq = 0, nan = 0;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (Number.isNaN(v)) nan++; const x = Math.abs(v); if (x > peak) peak = x; sq += v * v; }
  return { peak: peak.toFixed(3), rmsDb: (10 * Math.log10(sq / a.length + 1e-12)).toFixed(1), nan };
}

const results = [];
for (const file of ['male.wav', 'female.wav', 'male_noisy.wav']) {
  const { rate, samples } = readWav(path.join(dataDir, file));
  const info = analyzeVoice(samples, rate);
  console.log(`\n== ${file}: f0 median ${info.f0Median.toFixed(1)} Hz, voiced ${(info.voicedRatio * 100).toFixed(0)}%, ${info.lufs.toFixed(1)} LUFS`);
  const base = file.replace('.wav', '');
  const cases = [
    ['child', settingsFor('child')],
    ['woman', settingsFor('woman')],
    ['oldman', settingsFor('oldman')],
    ['broadcaster', settingsFor('broadcaster')],
    ['enhance', settingsFor('enhance')],
    // controlled: fixed +7.02 semitones (x1.5) and formants +20% with no extra effects
    ['ctrl_p150_f120', settingsFor('custom', { auto: false, pitchOffset: 12 * Math.log2(1.5), formantOffset: 20, breath: 0, tremor: 0, rough: 0, brightness: 0, warmth: 0, radio: false, compress: 0, nr: { enabled: false, strength: 0 }, normalize: { enabled: false, targetLufs: -16 } })],
    ['ctrl_p070_f090', settingsFor('custom', { auto: false, pitchOffset: 12 * Math.log2(0.7), formantOffset: -10, breath: 0, tremor: 0, rough: 0, brightness: 0, warmth: 0, radio: false, compress: 0, nr: { enabled: false, strength: 0 }, normalize: { enabled: false, targetLufs: -16 } })],
    ['ctrl_p100_f130', settingsFor('custom', { auto: false, pitchOffset: 0, formantOffset: 30, breath: 0, tremor: 0, rough: 0, brightness: 0, warmth: 0, radio: false, compress: 0, nr: { enabled: false, strength: 0 }, normalize: { enabled: false, targetLufs: -16 } })],
  ];
  if (file === 'male_noisy.wav') {
    cases.length = 0;
    cases.push(['nr_only', settingsFor('custom', { auto: false, breath: 0, tremor: 0, rough: 0, brightness: 0, warmth: 0, radio: false, compress: 0, nr: { enabled: true, strength: 0.8 }, normalize: { enabled: false, targetLufs: -16 } })]);
    cases.push(['broadcaster', settingsFor('broadcaster')]);
  }
  for (const [name, settings] of cases) {
    const t0 = Date.now();
    const r = renderOffline(samples, rate, settings, { voiceInfo: info });
    const ms = Date.now() - t0;
    const st = stats(r.audio);
    const pitch = estimatePitch(r.audio, rate);
    const out = path.join(outDir, `${base}_${name}.wav`);
    writeWav(out, r.audio, rate, 16);
    const line = `${base}_${name}: P=${r.params.pitchRatio.toFixed(3)} F=${r.params.formantRatio.toFixed(3)} semis=${r.params.semitones.toFixed(2)} | out f0=${pitch.f0Median.toFixed(1)} (expected ${(info.f0Median * r.params.pitchRatio).toFixed(1)}) | peak=${st.peak} rms=${st.rmsDb}dB nan=${st.nan} len=${r.audio.length}/${samples.length} | ${ms} ms`;
    console.log(line);
    results.push({ file: base, name, params: r.params, outF0: pitch.f0Median, inF0: info.f0Median, len: r.audio.length, inLen: samples.length, nan: st.nan, ms });
  }
}

// Streaming equivalence: feeding 128-sample blocks (live-style chunking) must give the same output as 8192 blocks
{
  const { rate, samples } = readWav(path.join(dataDir, 'male.wav'));
  const info = analyzeVoice(samples, rate);
  const params = resolveSettings(settingsFor('child'), info);
  const run = (chunk) => {
    const p = new VoicePipeline(rate, 'offline');
    p.configure(params, info, null);
    const parts = [];
    for (let i = 0; i < samples.length; i += chunk) parts.push(p.process(samples.subarray(i, Math.min(samples.length, i + chunk))));
    parts.push(p.flush());
    let n = 0; for (const x of parts) n += x.length;
    const out = new Float32Array(n); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  };
  const a = run(128), b = run(8192);
  let maxDiff = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  console.log(`\nstreaming equivalence: len ${a.length} vs ${b.length}, max abs diff ${maxDiff.toExponential(2)}`);
  results.push({ streamingMaxDiff: maxDiff, lenA: a.length, lenB: b.length });
}

// Live-mode pipeline sanity (1024-point frames) at 128-sample blocks + timing
{
  const { rate, samples } = readWav(path.join(dataDir, 'male.wav'));
  const info = analyzeVoice(samples, rate);
  const params = resolveSettings(settingsFor('oldman'), info);
  const p = new VoicePipeline(rate, 'live');
  p.configure(params, info, null);
  const t0 = Date.now();
  let produced = 0;
  for (let i = 0; i + 128 <= samples.length; i += 128) produced += p.process(samples.subarray(i, i + 128)).length;
  const ms = Date.now() - t0;
  console.log(`live pipeline: ${produced} samples out of ${samples.length} in ${ms} ms (${(samples.length / rate / (ms / 1000)).toFixed(1)}x realtime)`);
}

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
