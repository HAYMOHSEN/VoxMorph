// Smoke test of one onnxruntime-web build in headless Chromium: node test/ort_build_smoke.mjs [hideRegex]
// e.g. `node test/ort_build_smoke.mjs 'ort-wasm-simd-threaded\.wasm$'` hides the CPU wasm so the JSEP build (stitched parts) must load.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire('/home/claude/.npm-global/lib/node_modules/');
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8778;
const hide = process.argv[2];
const server = spawn('node', [path.join(root, 'test/serve.mjs'), String(PORT), ...(hide ? ['--hide=' + hide] : [])], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voxmorph-smoke-'));
const browser = await chromium.launchPersistentContext(profile);
const page = browser.pages()[0] || await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
await page.addInitScript(() => { try { localStorage.setItem('voxmorph.ai.manifest', './test/real-models/manifest.json'); } catch {} });
await page.goto(`http://localhost:${PORT}/ai-test.html`);
await page.waitForFunction(() => window.__aiTest && (window.__aiTest.ai.state.available || window.__aiTest.ai.state.reason), null, { timeout: 60000 });
await page.waitForTimeout(1000); await page.reload();
await page.waitForFunction(() => window.__aiTest && (window.__aiTest.ai.state.available || window.__aiTest.ai.state.reason), null, { timeout: 60000 });
const st = await page.evaluate(() => ({ ...window.__aiTest.ai.state, coi: window.crossOriginIsolated }));
console.log('state:', JSON.stringify({ available: st.available, reason: st.reason, build: st.build, ortSource: st.ortSource, ep: st.ep, threads: st.threads, version: st.ortVersion, coi: st.coi }));
let ok = st.available;
if (ok) {
  const gen = await page.evaluate(async () => { const ai = window.__aiTest.ai; const v = ai.voiceById('male-p226'); await ai.install(v); const t0 = performance.now(); const r = await ai.generatorTest(v, 1); r.total = Math.round(performance.now() - t0); return r; }).catch((e) => ({ error: e.message }));
  console.log('generator:', JSON.stringify(gen));
  ok = !gen.error && gen.nan === 0 && gen.samples === gen.frames * 400;
}
console.log(logs.filter((l) => /runtime|session|error|Error/.test(l)).join('\n'));
await browser.close(); fs.rmSync(profile, { recursive: true, force: true }); server.kill();
console.log(ok ? 'BUILD SMOKE OK' : 'BUILD SMOKE FAILED');
process.exit(ok ? 0 : 1);
