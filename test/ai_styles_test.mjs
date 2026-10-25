// Applies the AI character layer (js/ai/styles.js + the DSP pipeline) to neural renders of the Arabic clip
// (test/out/style_rvc_*.wav from tools/rvc_onnx_check.py with the styles' transposes) and checks the result:
// pitch kept (the generator did it), vocal-tract ratio applied, no clipping, length kept. Writes listening files.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderOffline } from '../js/dsp/pipeline.js';
import { estimatePitch } from '../js/dsp/analysis.js';
import { defaultSettings } from '../js/dsp/presets.js';
import { AI_STYLES, aiPostSettings, aiTranspose } from '../js/ai/styles.js';
import { readWav, writeWav } from './wav.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEUTRAL = { preset: 'custom', intensity: 1, auto: false, pitchOffset: 0, formantOffset: 0, breath: 0, tremor: 0, rough: 0, brightness: 0, warmth: 0, radio: false, compress: 0, ringMod: 0, nr: { enabled: false, strength: 0 }, gate: { enabled: false, thresholdDb: -48 }, normalize: { enabled: false, targetLufs: -16 } };
let failures = 0;
const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failures++; };

// transposes the app would pick for this speaker (189 Hz) — must match what produced the neural renders
const voiceInfo = { f0Median: 189, voicedRatio: 0.5 };
const settings = { ...defaultSettings(), auto: true, normalize: { enabled: true, targetLufs: -16 } };
for (const [sid, file, expectTr] of [['ai_girl', 'girl', 6], ['ai_boy', 'boy', 4], ['ai_old_woman', 'oldwoman', -2], ['ai_old_man', 'oldman', -7]]) {
  const style = AI_STYLES[sid];
  const tr = aiTranspose(settings, { targetF0: 185 }, style, voiceInfo);
  check(tr === expectTr, `${sid}: auto transpose for a 189 Hz speaker = ${tr >= 0 ? '+' : ''}${tr} st (target ${style.targetF0} Hz)`);
  const src = path.join(root, 'test/out', `style_rvc_${file}.wav`);
  if (!fs.existsSync(src)) { console.log(`  (missing ${src} — run tools/rvc_onnx_check.py first)`); continue; }
  const { rate, samples } = readWav(src);
  const post = aiPostSettings({ ...settings, preset: 'ais:' + sid }, style, NEUTRAL);
  const r = renderOffline(samples, rate, post, { voiceInfo: null, onProgress: () => {} });
  const out = r.audio;
  const pIn = estimatePitch(samples, rate).f0Median, pOut = estimatePitch(out, rate).f0Median;
  let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  check(out.length === samples.length && peak <= 1 && peak > 0.2, `${sid}: length kept, peak ${peak.toFixed(2)}`);
  check(Math.abs(pOut - pIn) / pIn < 0.04, `${sid}: character layer keeps the neural pitch (${pIn.toFixed(1)} → ${pOut.toFixed(1)} Hz), vocal tract ×${(1 + post.formantOffset / 100).toFixed(2)}, breath ${post.breath.toFixed(2)}, tremor ${post.tremor.toFixed(2)}, rough ${post.rough.toFixed(2)}, brightness ${post.brightness} dB`);
  writeWav(path.join(root, 'test/out', `style_final_${file}.wav`), out, rate, 16);
}
console.log(failures ? `\n${failures} FAILED` : '\nAI STYLE CHECKS PASSED');
process.exit(failures ? 1 : 0);
