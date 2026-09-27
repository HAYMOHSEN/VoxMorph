// End-to-end test of the VoxMorph app in headless Chromium (Playwright).
// Usage: node test/e2e.mjs [--screens]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimatePitch } from '../js/dsp/analysis.js';
import { writeWav } from './wav.mjs';

const require = createRequire('/home/claude/.npm-global/lib/node_modules/');
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 8765;
const takeScreens = process.argv.includes('--screens');

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', root], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(root, 'test/data/male.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'], locale: 'ar' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });

await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.__voxmorph && window.__voxmorph.state.support, null, { timeout: 20000 });
check(await page.evaluate(() => document.documentElement.dir) === 'rtl', 'Arabic RTL by default (locale ar)');
const support = await page.evaluate(() => window.__voxmorph.state.support);
console.log('  encoder support:', JSON.stringify(support));

// ---- import a file
await page.setInputFiles('#fileInput', path.join(root, 'test/data/male.wav'));
await page.waitForFunction(() => document.getElementById('renderStatus').classList.contains('ok'), null, { timeout: 60000 });
const s1 = await page.evaluate(() => { const s = window.__voxmorph.state; return { len: s.audio.length, f0: s.voiceInfo && s.voiceInfo.f0Median, conv: s.converted && s.converted.length, preset: s.settings.preset, detected: document.getElementById('detectedInfo').textContent }; });
check(s1.len === 149760, `imported clip has ${s1.len} samples`);
check(Math.abs(s1.f0 - 116.6) < 3, `analysed pitch ${s1.f0 && s1.f0.toFixed(1)} Hz`);
check(s1.conv === s1.len, `converted clip rendered (${s1.conv} samples) with preset ${s1.preset}`);
console.log('  detected label:', s1.detected);

// ---- each preset renders and pitch lands on target
const waitRendered = async () => {
  await page.waitForFunction(() => { const vm = window.__voxmorph; return vm.state.converted && vm.state.convertedKey === vm.settingsKey(); }, null, { timeout: 90000 });
};
const CAT = { child: 'child', child_girl: 'child', woman: 'woman', woman_anchor: 'woman', oldman: 'man', broadcaster: 'man', man_deep: 'man', fx_giant: 'fx', enhance: 'other' };
for (const preset of ['child', 'child_girl', 'woman', 'woman_anchor', 'oldman', 'broadcaster', 'man_deep', 'fx_giant', 'enhance']) {
  await page.click(`#presetTabs button[data-category="${CAT[preset]}"]`);
  await page.click(`.preset[data-preset="${preset}"]`);
  await waitRendered();
  const { arr, expected } = await page.evaluate(() => { const vm = window.__voxmorph; const p = vm.resolveSettings(vm.state.settings, vm.state.voiceInfo); return { arr: Array.from(vm.state.converted), expected: vm.state.voiceInfo.f0Median * p.pitchRatio }; });
  const f = new Float32Array(arr);
  const p = estimatePitch(f, 48000);
  check(Math.abs(p.f0Median - expected) / expected < 0.04, `preset ${preset}: output pitch ${p.f0Median.toFixed(1)} Hz (expected ${expected.toFixed(1)})`);
  writeWav(path.join(root, 'test/out', `e2e_${preset}.wav`), f, 48000);
}

// ---- category tabs render all styles
const tabInfo = await page.evaluate(() => [...document.querySelectorAll('#presetTabs button')].map((b) => b.dataset.category + ':' + b.querySelector('.count').textContent).join(' '));
check(tabInfo === 'child:4 woman:5 man:5 fx:3 other:2', `category tabs: ${tabInfo}`);

// ---- trim + fine control
await page.click('#presetTabs button[data-category="man"]');
await page.click('.preset[data-preset="broadcaster"]');
await waitRendered();
await page.evaluate(() => { const el = document.getElementById('trimEnd'); el.value = 500; el.dispatchEvent(new Event('input', { bubbles: true })); });
await waitRendered();
const trimLen = await page.evaluate(() => window.__voxmorph.state.converted.length);
check(Math.abs(trimLen - 149760 / 2) < 200, `trimmed render length ${trimLen} ≈ half`);
await page.click('#resetTrim');
await waitRendered();

// ---- background music: import, mix, play, export stereo
await page.setInputFiles('#musicInput', path.join(root, 'test/data/music.mp3'));
await page.waitForFunction(() => { const vm = window.__voxmorph; return vm.state.music && vm.state.mixed && vm.state.mixedKey === vm.mixKey(); }, null, { timeout: 60000 });
const mixInfo = await page.evaluate(() => { const s = window.__voxmorph.state; return { musicLen: s.music.L.length, mixLen: s.mixed.L.length, voiceStart: s.mixed.voiceStart, convLen: s.converted.length, label: document.querySelector('#playConvBtn span').textContent, status: document.getElementById('mixStatus').textContent }; });
check(mixInfo.musicLen > 48000 * 20, `music decoded to stereo 48 kHz (${(mixInfo.musicLen / 48000).toFixed(1)} s)`);
check(mixInfo.mixLen === mixInfo.voiceStart + mixInfo.convLen + 48000 * 2, `mix length = intro + voice + outro (${mixInfo.mixLen})`);
console.log('  converted button:', mixInfo.label, '| mix status:', mixInfo.status);
await page.click('#playConvBtn');
await page.waitForTimeout(500);
check(await page.evaluate(() => window.__voxmorph.engine.playing && window.__voxmorph.engine.player.buffer.numberOfChannels === 2), 'converted playback uses the stereo mix');
await page.click('#playConvBtn');
for (const format of ['wav', 'ogg']) {
  const b64 = await page.evaluate(async (f) => {
    const vm = window.__voxmorph;
    const out = await vm.ensureOutput();
    const { blob } = await vm.encodeAudio(out, 48000, { format: f, bits: 16, sampleRate: 48000, bitrate: 128 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, format);
  const file = path.join(root, 'test/out', `e2e_mix.${format}`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  try {
    const probe = execSync(`ffprobe -v error -show_entries stream=codec_name,sample_rate,channels:format=duration -of csv=p=0 "${file}"`).toString().trim().replace(/\n/g, ' | ');
    execSync(`ffmpeg -v error -y -i "${file}" -f null - 2>&1`);
    check(/,2 \|/.test(probe) || /,2\|/.test(probe) || probe.includes(',2'), `stereo mix export ${format}: ${probe}`);
  } catch (e) { check(false, `stereo mix export ${format} failed: ${e.stdout || e.message}`); }
}
// music level change re-mixes; disabling music returns to the mono voice
await page.evaluate(() => { const el = document.getElementById('musicDb'); el.value = 6; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForFunction(() => { const vm = window.__voxmorph; return vm.state.mixed && vm.state.mixedKey === vm.mixKey() && vm.state.mix.musicDb === 6; }, null, { timeout: 60000 });
check(true, 'changing the music level re-mixes');
await page.click('label:has(#musicToggle) .slider');
await page.waitForTimeout(200);
check(await page.evaluate(() => { const vm = window.__voxmorph; return !vm.state.mix.enabled && document.querySelector('#playConvBtn span').textContent === 'المحوَّل'; }), 'music switched off → converted voice only');
await page.click('label:has(#musicToggle) .slider');
await page.waitForFunction(() => { const vm = window.__voxmorph; return vm.state.mix.enabled && vm.state.mixed && vm.state.mixedKey === vm.mixKey(); }, null, { timeout: 60000 });

// ---- export every available format through the real export path (voice only)
await page.click('label:has(#musicToggle) .slider');
await page.waitForTimeout(200);
const formats = ['wav', 'flac', 'ogg', 'webm', 'm4a'];
for (const format of formats) {
  const available = await page.evaluate((f) => { const o = [...document.querySelectorAll('#formatSelect option')].find((x) => x.value === f); return o && !o.disabled; }, format);
  if (!available) { console.log(`  · ${format}: not available in this browser (${JSON.stringify(support)})`); continue; }
  const b64 = await page.evaluate(async (f) => {
    const vm = window.__voxmorph;
    const audio = await vm.ensureConvertedFull();
    const { blob } = await vm.encodeAudio(audio, 48000, { format: f, bits: 24, sampleRate: f === 'ogg' || f === 'webm' ? 48000 : 44100, bitrate: 128 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, format);
  const file = path.join(root, 'test/out', `e2e_export.${format}`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  let probe = '';
  try { probe = execSync(`ffprobe -v error -show_entries stream=codec_name,sample_rate,channels:format=duration -of csv=p=0 "${file}"`).toString().trim().replace(/\n/g, ' | '); execSync(`ffmpeg -v error -y -i "${file}" -f null - 2>&1`); check(true, `export ${format}: ${probe} (${fs.statSync(file).size} bytes) decodes with ffmpeg`); }
  catch (e) { check(false, `export ${format} failed: ${e.stdout || e.message}`); }
}

// ---- save button (headless Chromium auto-cancels the native picker, so exercise the download fallback)
await page.evaluate(() => { window.showSaveFilePicker = undefined; });
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.click('#saveBtn'),
]);
const dlPath = path.join(root, 'test/out', 'e2e_download.wav');
await download.saveAs(dlPath);
check(fs.statSync(dlPath).size > 100000, `save button produced ${download.suggestedFilename()} (${fs.statSync(dlPath).size} bytes)`);

// ---- playback controls
await page.click('#playConvBtn');
await page.waitForTimeout(700);
const playing = await page.evaluate(() => window.__voxmorph.engine.playing);
check(playing, 'converted playback started');
await page.click('#playOrigBtn');
await page.waitForTimeout(300);
check(await page.evaluate(() => window.__voxmorph.engine.player.which) === 'orig', 'A/B switch to original');
await page.click('#playOrigBtn');
await page.waitForTimeout(200);
check(!(await page.evaluate(() => window.__voxmorph.engine.playing)), 'pause works');

// ---- live monitoring
await page.click('label:has(#liveToggle) .slider');
await page.waitForTimeout(1500);
const liveOn = await page.evaluate(() => window.__voxmorph.state.live && window.__voxmorph.engine.micOpen);
check(liveOn, 'live preview enabled with microphone open');
await page.click('label:has(#liveToggle) .slider');
await page.waitForTimeout(300);

// ---- recording from the (fake) microphone
const clipBefore = await page.evaluate(() => window.__voxmorph.state.clipId);
await page.click('#recordBtn');
await page.waitForTimeout(3000);
await page.click('#recordBtn');
await page.waitForFunction((c) => window.__voxmorph.state.clipId > c, clipBefore, { timeout: 10000 });
await waitRendered();
const rec = await page.evaluate(() => { const s = window.__voxmorph.state; return { len: s.audio.length, f0: s.voiceInfo && s.voiceInfo.f0Median, peak: s.voiceInfo && s.voiceInfo.peak }; });
check(rec.len > 48000 * 2.5 && rec.len < 48000 * 4, `recorded ${(rec.len / 48000).toFixed(2)} s from the microphone`);
check(rec.f0 > 100 && rec.f0 < 135, `recorded voice analysed at ${rec.f0 && rec.f0.toFixed(1)} Hz (peak ${rec.peak && rec.peak.toFixed(2)})`);

// ---- language toggle + screenshots
if (takeScreens) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setInputFiles('#fileInput', path.join(root, 'test/data/male.wav'));
  await page.waitForFunction(() => document.getElementById('renderStatus').classList.contains('ok'), null, { timeout: 60000 });
  await page.click('#presetTabs button[data-category="man"]');
  await page.click('.preset[data-preset="broadcaster"]');
  await waitRendered();
  await page.click('label:has(#musicToggle) .slider');
  await page.waitForFunction(() => { const vm = window.__voxmorph; return vm.state.mix.enabled && vm.state.mixed && vm.state.mixedKey === vm.mixKey(); }, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(root, 'screenshots', 'voxmorph-ar-1.png') });
  await page.evaluate(() => document.getElementById('fineDetails').open = true);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(root, 'screenshots', 'voxmorph-ar-2.png') });
  await page.evaluate(() => document.getElementById('fineDetails').open = false);
  await page.click('#langBtn');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => document.documentElement.dir) === 'ltr', 'language switched to English (LTR)');
  await page.click('#presetTabs button[data-category="woman"]');
  await page.click('.preset[data-preset="woman_anchor"]');
  await waitRendered();
  await page.waitForFunction(() => { const vm = window.__voxmorph; return vm.state.mixed && vm.state.mixedKey === vm.mixKey(); }, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(root, 'screenshots', 'voxmorph-en-1.png') });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(root, 'screenshots', 'voxmorph-en-1366.png') });
  await page.click('#langBtn');
}

// ---- offline reload through the service worker
await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
await context.setOffline(true);
await page.reload();
const offlineOk = await page.waitForFunction(() => window.__voxmorph && window.__voxmorph.state.support, null, { timeout: 20000 }).then(() => true).catch(() => false);
check(offlineOk, 'app loads offline from the service worker cache');
await context.setOffline(false);

console.log('\nconsole errors/warnings:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
await browser.close();
server.kill();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
