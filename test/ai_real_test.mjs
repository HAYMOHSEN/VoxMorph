// Real-runtime test: onnxruntime-web (vendor/ort) in headless Chromium with the real RVC voice models,
// and — when the shared engine models are present in test/real-models/ — the full ContentVec → f0 → RVC
// conversion of the Arabic reference clip, compared against the reference conversions.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimatePitch } from '../js/dsp/analysis.js';
import { readWav, writeWav } from './wav.mjs';

const require = createRequire('/home/claude/.npm-global/lib/node_modules/');
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 8777;
const REAL = path.join(root, 'test/real-models');
const hasFile = (f) => fs.existsSync(path.join(REAL, f));
let failures = 0;
const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failures++; };

const server = spawn('node', [path.join(root, 'test/serve.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
// a persistent profile gives Cache Storage a disk-backed quota (an incognito context tops out below the 377 MB ContentVec model)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voxmorph-real-'));
const browser = await chromium.launchPersistentContext(profile, { args: ['--autoplay-policy=no-user-gesture-required', '--enable-features=SharedArrayBuffer'], viewport: { width: 1200, height: 900 } });
const page = browser.pages()[0] || await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('crash', () => { console.log('✗ the page crashed (out of memory?)'); process.exit(2); });
await page.addInitScript(() => { try { localStorage.setItem('voxmorph.ai.manifest', './test/real-models/manifest.json'); } catch {} });
await page.goto(`http://localhost:${PORT}/ai-test.html`);
await page.waitForFunction(() => window.__aiTest && (window.__aiTest.ai.state.available || window.__aiTest.ai.state.reason), null, { timeout: 60000 });
// second load so the service worker controls the page (cross-origin isolation → threads)
await page.waitForTimeout(1500);
await page.reload();
await page.waitForFunction(() => window.__aiTest && (window.__aiTest.ai.state.available || window.__aiTest.ai.state.reason), null, { timeout: 60000 });
const st = await page.evaluate(() => ({ ...window.__aiTest.ai.state, coi: window.crossOriginIsolated, voices: window.__aiTest.ai.voices.map((v) => v.id), manifestError: window.__aiTest.ai.manifestError }));
check(st.available, `real onnxruntime-web loaded in the worker: ${st.ortSource || ''} version ${st.ortVersion} ep=${st.ep} threads=${st.threads} (crossOriginIsolated=${st.coi})`);
console.log('  manifest voices:', st.voices, st.manifestError || '');

// ---- generator-only test with the real male voice (served from the test manifest)
const voiceId = 'male-p226';
await page.evaluate(async (id) => { const ai = window.__aiTest.ai; const v = ai.voiceById(id); await ai.install(v); }, voiceId);
check(await page.evaluate((id) => window.__aiTest.ai.isInstalled(id), voiceId), 'voice model downloaded into Cache Storage (110 MB, 5 parts)');
const gen = await page.evaluate(async (id) => { const ai = window.__aiTest.ai; const t0 = performance.now(); const r = await ai.generatorTest(ai.voiceById(id), 2); r.total = performance.now() - t0; return r; }, voiceId);
check(gen.nan === 0 && gen.hop === 400 && gen.samples === gen.frames * 400 && gen.peak > 0.01, `generator ran in the browser: ${gen.frames} frames → ${gen.samples} samples (hop ${gen.hop}, 40 kHz), peak ${gen.peak.toFixed(3)}, ${gen.ms} ms compute (${(2000 / gen.ms).toFixed(2)}× realtime), load+run ${Math.round(gen.total)} ms`);

// ---- full pipeline when ContentVec (+ RMVPE) are available
if (hasFile('vec-768-layer-12.onnx')) {
  await page.evaluate(async () => { const ai = window.__aiTest.ai; await ai.install(ai.manifest.engine.contentvec); if (ai.manifest.engine.rmvpe && ai.manifest.engine.rmvpe.url) { try { await ai.install(ai.manifest.engine.rmvpe); } catch (e) { console.warn('rmvpe install failed', e.message); } } });
  const { rate, samples } = readWav(path.join(REAL, 'arabic-female-16s-original.wav'));
  const arr = Array.from(samples);
  const singles = [['female-p231', 0, 'arabic-converted-female-p231.wav'], ['male-p226', -12, 'arabic-converted-male-p226.wav']];
  for (const [vid, transpose, refFile] of process.argv.includes('--long-only') ? [] : singles) {
    const t0 = Date.now();
    await page.evaluate(async (id) => { const ai = window.__aiTest.ai; if (!ai.isInstalled(id)) await ai.install(ai.voiceById(id)); }, vid);
    const r = await page.evaluate(async ({ vid, transpose, arr, rate }) => {
      const ai = window.__aiTest.ai;
      const x = new Float32Array(arr);
      const res = await ai.convert(ai.voiceById(vid), x, rate, { transpose, f0Method: 'auto' }, (p, l) => { window.__lastProgress = [p, l]; });
      return { audio: Array.from(res.audio), f0Method: res.f0Method, chunks: res.chunks, ms: res.ms, rmvpe: ai.state.rmvpe };
    }, { vid, transpose, arr, rate }).catch((e) => ({ error: e.message }));
    if (r.error) { check(false, `${vid}: conversion failed: ${r.error}`); continue; }
    const out = new Float32Array(r.audio);
    const outFile = path.join(root, 'test/out', `real_ai_${vid}.wav`);
    writeWav(outFile, out, rate, 16);
    const pOut = estimatePitch(out, rate);
    const ref = readWav(path.join(REAL, refFile));
    const pRef = estimatePitch(ref.samples, ref.rate);
    const pIn = estimatePitch(samples, rate);
    const expected = pIn.f0Median * Math.pow(2, transpose / 12);
    check(out.length === samples.length, `${vid}: output length ${out.length} = input length (${(out.length / rate).toFixed(2)} s), ${r.chunks} chunk(s), f0 ${r.f0Method}${r.rmvpe ? ' (RMVPE loaded)' : ''}, ${(r.ms / 1000).toFixed(1)} s compute (${(samples.length / rate / (r.ms / 1000)).toFixed(2)}× realtime)`);
    // ground truth is the input pitch shifted by the transpose (the pack's reference conversions were rendered with the
    // original export, whose sine source drifts after silences — see tools/fix_rvc_onnx_sine.py)
    check(Math.abs(pOut.f0Median - expected) / expected < 0.06, `${vid}: output pitch ${pOut.f0Median.toFixed(1)} Hz vs expected ${expected.toFixed(1)} Hz (input ${pIn.f0Median.toFixed(1)} Hz ${transpose >= 0 ? '+' : ''}${transpose} st); pack reference conversion ${pRef.f0Median.toFixed(1)} Hz`);
    // spectral similarity against the reference (long-term spectrum correlation, 0..1)
    const sim = (() => {
      const specOf = (x) => { const N = 2048; const acc = new Float64Array(N / 2); let n = 0; const re = new Float64Array(N), im = new Float64Array(N); const w = Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); for (let s = 0; s + N <= x.length; s += N) { for (let i = 0; i < N; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; } naiveFft(re, im); for (let k = 0; k < N / 2; k++) acc[k] += Math.hypot(re[k], im[k]); n++; } for (let k = 0; k < N / 2; k++) acc[k] = Math.log10(acc[k] / n + 1e-9); return acc; };
      const a = specOf(out), b = specOf(ref.rate === rate ? ref.samples : ref.samples);
      let ma = 0, mb = 0; for (let k = 0; k < a.length; k++) { ma += a[k]; mb += b[k]; } ma /= a.length; mb /= b.length;
      let num = 0, da = 0, db = 0; for (let k = 2; k < a.length / 2; k++) { num += (a[k] - ma) * (b[k] - mb); da += (a[k] - ma) ** 2; db += (b[k] - mb) ** 2; }
      return num / Math.sqrt(da * db);
    })();
    console.log(`  ${vid}: long-term spectrum correlation with the reference conversion: ${sim.toFixed(3)}`);
    console.log(`  wrote ${path.relative(root, outFile)} (${Math.round((Date.now() - t0) / 1000)} s wall)`);
  }
  // ---- optional long-input stage (--long): three copies of the clip with gaps → several chunks; the output must be
  // continuous (same level in every copy, no gaps at the joins) and each copy must match the single-clip conversion.
  if (process.argv.includes('--long') || process.argv.includes('--long-only')) {
    await page.evaluate(async () => { const ai = window.__aiTest.ai; if (!ai.isInstalled('female-p231')) await ai.install(ai.voiceById('female-p231')); });
    const gap = new Float32Array(Math.round(0.4 * rate));
    const long = new Float32Array(samples.length * 3 + gap.length * 2);
    for (let k = 0; k < 3; k++) long.set(samples, k * (samples.length + gap.length));
    const t0 = Date.now();
    const r = await page.evaluate(async ({ arr, rate }) => {
      const ai = window.__aiTest.ai;
      const res = await ai.convert(ai.voiceById('female-p231'), new Float32Array(arr), rate, { transpose: 0, f0Method: 'auto' }, () => {});
      return { audio: Array.from(res.audio), chunks: res.chunks, chunkInfo: res.chunkInfo, ms: res.ms, logs: ai.logs.slice(-12) };
    }, { arr: Array.from(long), rate }).catch((e) => ({ error: e.message }));
    if (!r.error) { console.log('  chunks:', JSON.stringify(r.chunkInfo)); console.log('  worker log:', r.logs.join(' | ')); }
    if (r.error) check(false, `long input: conversion failed: ${r.error}`);
    else {
      const out = new Float32Array(r.audio);
      writeWav(path.join(root, 'test/out', 'real_ai_long_female-p231.wav'), out, rate, 16);
      check(out.length === long.length && r.chunks >= 2, `long input ${(long.length / rate).toFixed(1)} s → ${r.chunks} chunks, length kept, ${(r.ms / 1000).toFixed(0)} s compute (${Math.round((Date.now() - t0) / 1000)} s wall)`);
      const rmsDb = (x) => { let sq = 0; for (let i = 0; i < x.length; i++) sq += x[i] * x[i]; return 10 * Math.log10(sq / x.length + 1e-12); };
      const levels = [0, 1, 2].map((k) => rmsDb(out.subarray(k * (samples.length + gap.length), k * (samples.length + gap.length) + samples.length)));
      check(Math.max(...levels) - Math.min(...levels) < 1.5, `same level in each copy: ${levels.map((l) => l.toFixed(1)).join(' / ')} dBFS (spread ${(Math.max(...levels) - Math.min(...levels)).toFixed(2)} dB)`);
      const single = readWav(path.join(root, 'test/out', 'real_ai_female-p231.wav')).samples;
      const pitches = [0, 1, 2].map((k) => estimatePitch(out.subarray(k * (samples.length + gap.length), k * (samples.length + gap.length) + samples.length), rate).f0Median);
      const pSingle = estimatePitch(single, rate).f0Median;
      check(pitches.every((p) => Math.abs(p - pSingle) / pSingle < 0.05), `each copy keeps the pitch of the single-clip conversion: ${pitches.map((p) => p.toFixed(1)).join(' / ')} Hz vs ${pSingle.toFixed(1)} Hz`);
      // no gaps: the quietest 50 ms inside speech regions of the joined output must not be silent where the single conversion is not
      let worst = 0;
      for (let k = 0; k < 3; k++) { const seg = out.subarray(k * (samples.length + gap.length), k * (samples.length + gap.length) + samples.length); const w = Math.round(0.05 * rate); for (let s0 = 0; s0 + w <= seg.length; s0 += w) { const a = rmsDb(seg.subarray(s0, s0 + w)), b = rmsDb(single.subarray(s0, s0 + w)); if (b > -30) worst = Math.max(worst, b - a); } }
      check(worst < 12, `no dropouts at the joins: worst 50 ms window is ${worst.toFixed(1)} dB below the single-clip conversion`);
    }
  }
} else {
  console.log('  (ContentVec not present in test/real-models — full conversion test skipped)');
}

function naiveFft(re, im) { // iterative radix-2
  const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; const wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j]; const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci; const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr; re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
}

console.log('\nconsole errors:', logs.length ? '\n  ' + logs.join('\n  ') : 'none');
await browser.close();
fs.rmSync(profile, { recursive: true, force: true });
server.kill();
console.log(failures ? `\n${failures} FAILED` : '\nREAL-RUNTIME CHECKS PASSED');
process.exit(failures ? 1 : 0);
