// Generate Microsoft Store listing assets: framed marketing screenshots (AR/EN), hero art, poster art,
// box art and tile icons. Run: node test/store_assets.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire('/home/claude/.npm-global/lib/node_modules/');
const { chromium } = require('playwright');
const sharp = require('sharp');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.join(root, 'store');
const RAW = path.join(OUT, 'raw');
for (const d of [OUT, RAW, path.join(OUT, 'screenshots-ar'), path.join(OUT, 'screenshots-en'), path.join(OUT, 'logos')]) fs.mkdirSync(d, { recursive: true });

const PORT = 8771;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', root], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(root, 'test/data/demo_speech.wav')}`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, permissions: ['microphone'], locale: 'ar' });
const page = await context.newPage();
await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.__voxmorph && window.__voxmorph.state.support);
const rendered = () => page.waitForFunction(() => { const vm = window.__voxmorph; return vm.state.converted && vm.state.convertedKey === vm.settingsKey(); }, null, { timeout: 90000 });
const mixed = () => page.waitForFunction(() => { const vm = window.__voxmorph; return vm.state.mixed && vm.state.mixedKey === vm.mixKey(); }, null, { timeout: 90000 });
const pick = async (cat, id) => { await page.click(`#presetTabs button[data-category="${cat}"]`); await page.click(`.preset[data-preset="${id}"]`); await rendered(); };
const shot = async (name) => { await page.waitForTimeout(350); const p = path.join(RAW, name + '.png'); await page.screenshot({ path: p }); return p; };
const hideToast = () => page.evaluate(() => { document.getElementById('toast').hidden = true; });

// ---------------------------------------------------------------- raw captures (both languages)
await page.setInputFiles('#fileInput', path.join(root, 'test/data/demo_speech.wav'));
await rendered();
await page.setInputFiles('#musicInput', path.join(root, 'test/data/music.mp3'));
await mixed();
await page.evaluate(() => { document.getElementById('fileName').value = 'my-video-voiceover'; });

const raw = {};
for (const lang of ['ar', 'en']) {
  if ((await page.evaluate(() => document.documentElement.lang)) !== lang) { await page.click('#langBtn'); await page.waitForTimeout(300); }
  await page.evaluate(() => { document.getElementById('fileName').value = 'my-video-voiceover'; });
  await pick('man', 'broadcaster'); await mixed(); await hideToast();
  raw[lang + '_overview'] = await shot(lang + '_overview');
  await pick('woman', 'woman_anchor'); await mixed();
  raw[lang + '_woman'] = await shot(lang + '_woman');
  await pick('child', 'child'); await mixed();
  await page.evaluate(() => { document.getElementById('fineDetails').open = true; });
  raw[lang + '_fine'] = await shot(lang + '_fine');
  await page.evaluate(() => { document.getElementById('fineDetails').open = false; });
  await pick('fx', 'fx_robot'); await mixed();
  raw[lang + '_fx'] = await shot(lang + '_fx');
  // AI voices tab (real manifest: voice cards with download buttons, runtime status chip)
  await page.click('#presetTabs button[data-category="ai"]');
  await page.waitForFunction(() => window.__voxmorph.ai.state.available || window.__voxmorph.ai.state.reason, null, { timeout: 60000 });
  await page.waitForSelector('.ai-panel .preset.ai-style');
  await page.waitForTimeout(400);
  // bring the voice-model cards and the derived styles into the cropped area
  await page.evaluate(() => { const el = document.querySelector('.ai-panel .ai-section'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 92); });
  await page.waitForTimeout(300);
  raw[lang + '_ai'] = await shot(lang + '_ai');
  await page.evaluate(() => window.scrollTo(0, 0));
  await pick('man', 'man_narrator'); await mixed();
  raw[lang + '_music'] = await shot(lang + '_music');
  // live preview + recording state
  await page.click('label:has(#liveToggle) .slider');
  await page.waitForTimeout(600);
  await page.click('#recordBtn');
  await page.waitForTimeout(2600);
  raw[lang + '_recording'] = await shot(lang + '_recording');
  await page.click('#recordBtn');
  await page.waitForFunction(() => window.__voxmorph.state.clipId >= 2, null, { timeout: 15000 });
  await page.click('label:has(#liveToggle) .slider');
  // restore the demo clip for the next language
  await page.setInputFiles('#fileInput', path.join(root, 'test/data/demo_speech.wav'));
  await rendered();
  await page.evaluate(() => { document.getElementById('fileName').value = 'my-video-voiceover'; });
  await pick('man', 'broadcaster'); await mixed();
}
await browser.close();

// ---------------------------------------------------------------- composition
const b64 = (file) => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
const logo = b64(path.join(root, 'icons/icon-512.png'));
const crop = async (file, rect) => sharp(file).extract(rect).png().toBuffer();

const TEXT = {
  ar: {
    font: '"DejaVu Sans", "Noto Sans Arabic", sans-serif', dir: 'rtl',
    title: 'VoxMorph', tagline: 'حوّل صوتك إلى صوت آخر للتعليق الصوتي على الفيديوهات',
    shots: [
      { key: 'overview', h: 'حوّل صوتك إلى 19 صوتاً مختلفاً', s: 'طفل · امرأة · رجل · مؤثرات — يعمل بلا إنترنت وبخصوصية كاملة', caption: 'الشاشة الرئيسية: سجّل أو استورد، اختر الصوت، اسمع، واحفظ' },
      { key: 'woman', h: 'خمسة أصوات نسائية بنقرة واحدة', s: 'امرأة · شابة · مذيعة · امرأة هادئة · امرأة مسنّة', crop: 'voice', caption: 'أنماط الأصوات النسائية' },
      { key: 'ai', h: 'أصوات ذكاء اصطناعي تعمل على جهازك', s: 'امرأة · رجل · طفلة · طفل · امرأة مسنّة · رجل عجوز — نماذج عصبية بلا خادم ولا اشتراك، تُنزَّل مرة واحدة ثم تعمل دون إنترنت', crop: 'voice', caption: 'أصوات الذكاء الاصطناعي المحلية (بلا اشتراك)' },
      { key: 'fine', h: 'ملاءمة تلقائية لصوتك + ضبط دقيق', s: 'يقيس طبقة صوتك ويختار مقدار التحويل، وتتحكم أنت بالطبقة والرنين والتنفّس والسطوع', crop: 'voice', caption: 'الضبط الدقيق والملاءمة التلقائية' },
      { key: 'fx', h: 'مؤثرات: روبوت، عملاق، كرتوني', s: 'إلى جانب أصوات الأطفال والرجال: مذيع، راوٍ، شاب، صوت عميق، رجل عجوز', crop: 'voice', caption: 'المؤثرات الصوتية' },
      { key: 'music', h: 'موسيقى خلفية تنخفض تلقائياً أثناء الكلام', s: 'مقدمة وخاتمة موسيقية، تلاشٍ، تكرار تلقائي — والنتيجة ستيريو جاهزة للفيديو', crop: 'music', caption: 'الموسيقى الخلفية مع الخفض التلقائي' },
      { key: 'recording', h: 'سجّل من المايكروفون أو استورد أي ملف', s: 'معاينة حية لصوتك المحوَّل أثناء الكلام، وقصّ المقطع قبل الحفظ', crop: 'source', caption: 'التسجيل والمعاينة الحية' },
      { key: 'overview', h: 'احفظ بأي صيغة تريدها', s: 'WAV · FLAC · M4A · OGG · WebM — من نافذة الحفظ المعتادة في Windows', crop: 'export', caption: 'الحفظ بصيغ متعددة' },
    ],
  },
  en: {
    font: 'Poppins, "Segoe UI", sans-serif', dir: 'ltr',
    title: 'VoxMorph', tagline: 'Turn your voice into another voice for video voice-overs',
    shots: [
      { key: 'overview', h: 'Turn your voice into 19 different voices', s: 'Child · Woman · Man · Effects — works offline, audio never leaves your PC', caption: 'Main screen: record or import, pick a voice, listen, save' },
      { key: 'woman', h: 'Five female voices, one click', s: 'Woman · Young woman · Female anchor · Soft woman · Elderly woman', crop: 'voice', caption: 'Female voice styles' },
      { key: 'ai', h: 'AI voices that run on your own PC', s: 'Woman · Man · Girl · Boy · Elderly woman · Old man — neural models with no server and no subscription, downloaded once, then offline', crop: 'voice', caption: 'Local AI voices (no subscription)' },
      { key: 'fine', h: 'Adapts to your voice + fine tuning', s: 'Measures your pitch and picks the right amount of change; you control pitch, resonance, breath and brightness', crop: 'voice', caption: 'Fine tuning and auto-adapt' },
      { key: 'fx', h: 'Effects: robot, giant, cartoon', s: 'Plus child and male voices: broadcaster, narrator, young man, deep voice, old man', crop: 'voice', caption: 'Voice effects' },
      { key: 'music', h: 'Background music that ducks while you speak', s: 'Music intro and outro, fade-out, auto-loop — stereo result ready for your video', crop: 'music', caption: 'Background music with automatic ducking' },
      { key: 'recording', h: 'Record from the microphone or import any file', s: 'Live preview of your converted voice while speaking, and trimming before saving', crop: 'source', caption: 'Recording and live preview' },
      { key: 'overview', h: 'Save in any format you need', s: 'WAV · FLAC · M4A · OGG · WebM — through the normal Windows save dialog', crop: 'export', caption: 'Export formats' },
    ],
  },
};
// crop rectangles (px on the 1920x1080 raw shots); the layout is mirrored in RTL
const CROPS1 = {
  ar: { voice: { left: 270, top: 76, width: 648, height: 620 }, music: { left: 908, top: 684, width: 744, height: 340 }, source: { left: 908, top: 76, width: 744, height: 620 }, export: { left: 270, top: 684, width: 648, height: 340 } },
  en: { voice: { left: 1004, top: 76, width: 648, height: 620 }, music: { left: 270, top: 684, width: 744, height: 340 }, source: { left: 270, top: 76, width: 744, height: 620 }, export: { left: 1004, top: 684, width: 648, height: 340 } },
};
// raw shots are captured at 2x device pixels
const CROPS = {};
for (const lang of Object.keys(CROPS1)) { CROPS[lang] = {}; for (const [k, r] of Object.entries(CROPS1[lang])) CROPS[lang][k] = { left: r.left * 2, top: r.top * 2, width: r.width * 2, height: r.height * 2 }; }

const frameHtml = (lang, img, h, s, wide, box) => `<!doctype html><html lang="${lang}" dir="${TEXT[lang].dir}"><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#0f1117;font-family:${TEXT[lang].font};color:#fff}
  .bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 15% 0%,rgba(124,92,255,.35),transparent 60%),radial-gradient(900px 500px at 85% 100%,rgba(34,211,238,.25),transparent 60%),linear-gradient(180deg,#141827,#0f1117)}
  .head{position:absolute;top:56px;left:90px;right:90px;display:flex;align-items:center;gap:26px}
  .head img{width:84px;height:84px;border-radius:20px;box-shadow:0 10px 30px rgba(0,0,0,.5)}
  h1{margin:0;font-size:${wide ? 58 : 54}px;font-weight:800;line-height:1.15;letter-spacing:-.01em}
  p{margin:8px 0 0;font-size:27px;color:#b7bfd1;line-height:1.35}
  .win{position:absolute;left:50%;transform:translateX(-50%);top:${wide ? 246 : 250}px;width:${box.w}px;height:${box.h}px;border-radius:22px;border:1px solid rgba(255,255,255,.12);background:#171b26;box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 0 8px rgba(255,255,255,.03);overflow:hidden;display:flex;align-items:center;justify-content:center}
  .win img{width:100%;height:100%;object-fit:contain;display:block}
</style></head><body><div class="bg"></div>
<div class="head"><img src="${logo}"><div><h1>${h}</h1><p>${s}</p></div></div>
<div class="win ${wide ? '' : 'crop'}"><img src="${img}"></div>
</body></html>`;

const heroHtml = (lang) => `<!doctype html><html lang="${lang}" dir="${TEXT[lang].dir}"><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#0f1117;font-family:${TEXT[lang].font};color:#fff}
  .bg{position:absolute;inset:0;background:radial-gradient(1000px 700px at 20% 30%,rgba(124,92,255,.45),transparent 60%),radial-gradient(1000px 700px at 85% 80%,rgba(34,211,238,.35),transparent 60%),linear-gradient(180deg,#141827,#0f1117)}
  .wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:80px}
  .wrap img{width:380px;height:380px;border-radius:84px;box-shadow:0 40px 90px rgba(0,0,0,.6)}
  h1{margin:0;font-size:150px;font-weight:800;letter-spacing:-.02em;background:linear-gradient(135deg,#a78bfa,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent;line-height:1}
  p{margin:20px 0 0;font-size:44px;color:#d5dbea;max-width:1000px;line-height:1.35}
  .chips{margin-top:34px;display:flex;gap:14px;flex-wrap:wrap}
  .chip{font-size:26px;padding:10px 22px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e9ecf3}
</style></head><body><div class="bg"></div><div class="wrap"><img src="${logo}"><div><h1>${TEXT[lang].title}</h1><p>${TEXT[lang].tagline}</p>
<div class="chips">${(lang === 'ar' ? ['19 نمط صوت', 'أصوات ذكاء اصطناعي', 'موسيقى خلفية', 'يعمل بلا إنترنت', 'عربي / English'] : ['19 voice styles', 'AI voices', 'Background music', 'Works offline', 'Arabic / English']).map((c) => `<span class="chip">${c}</span>`).join('')}</div></div></div></body></html>`;

const posterHtml = (lang, w, h, withTitle) => `<!doctype html><html lang="${lang}" dir="${TEXT[lang].dir}"><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#0f1117;font-family:${TEXT[lang].font};color:#fff}
  .bg{position:absolute;inset:0;background:radial-gradient(70% 50% at 30% 20%,rgba(124,92,255,.45),transparent 65%),radial-gradient(70% 50% at 80% 90%,rgba(34,211,238,.35),transparent 65%),linear-gradient(180deg,#141827,#0f1117)}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(h * 0.04)}px;text-align:center;padding:0 ${Math.round(w * 0.08)}px}
  .wrap img{width:${Math.round(Math.min(w, h) * 0.46)}px;height:${Math.round(Math.min(w, h) * 0.46)}px;border-radius:${Math.round(Math.min(w, h) * 0.1)}px;box-shadow:0 30px 70px rgba(0,0,0,.6)}
  h1{margin:0;font-size:${Math.round(w * 0.13)}px;font-weight:800;letter-spacing:-.02em;background:linear-gradient(135deg,#a78bfa,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent;line-height:1.1}
  p{margin:0;font-size:${Math.round(w * 0.04)}px;color:#d5dbea;line-height:1.35}
</style></head><body><div class="bg"></div><div class="wrap"><img src="${logo}">${withTitle ? `<h1>${TEXT[lang].title}</h1><p>${TEXT[lang].tagline}</p>` : ''}</div></body></html>`;

const browser2 = await chromium.launch();
const render = async (html, w, h, file) => {
  const p = await browser2.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: 'load' });
  await p.waitForTimeout(150);
  await p.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
  await p.close();
};

const captions = { ar: [], en: [] };
for (const lang of ['ar', 'en']) {
  let i = 0;
  for (const s of TEXT[lang].shots) {
    i++;
    const rawFile = raw[`${lang}_${s.key}`];
    let img, box;
    if (s.crop) {
      const r = CROPS[lang][s.crop];
      const buf = await crop(rawFile, r); img = 'data:image/png;base64,' + buf.toString('base64');
      const scale = Math.min(1640 / r.width, 790 / r.height);
      box = { w: Math.round(r.width * scale), h: Math.round(r.height * scale) };
    } else { img = b64(rawFile); box = { w: 1640, h: 790 }; }
    const file = path.join(OUT, `screenshots-${lang}`, `${String(i).padStart(2, '0')}-${s.key}${s.crop ? '-' + s.crop : ''}.png`);
    await render(frameHtml(lang, img, s.h, s.s, !s.crop, box), 1920, 1080, file);
    captions[lang].push({ file: path.basename(file), caption: s.caption });
    console.log('wrote', path.relative(root, file));
  }
  await render(heroHtml(lang), 1920, 1080, path.join(OUT, 'logos', `super-hero-art-16x9-1920x1080-${lang}.png`));
  await render(posterHtml(lang, 720, 1080, true), 720, 1080, path.join(OUT, 'logos', `poster-art-2x3-720x1080-${lang}.png`));
  await render(posterHtml(lang, 1080, 1080, true), 1080, 1080, path.join(OUT, 'logos', `box-art-1x1-1080x1080-${lang}.png`));
}
await render(posterHtml('en', 1080, 1080, false), 1080, 1080, path.join(OUT, 'logos', 'promotional-square-1080x1080-no-title.png'));
await browser2.close();
// tile icons (no text)
await sharp(path.join(root, 'icons/icon-512.png')).resize(300, 300).png().toFile(path.join(OUT, 'logos', 'app-tile-icon-1x1-300x300.png'));
await sharp(path.join(root, 'icons/icon-512.png')).resize(1080, 1080).png().toFile(path.join(OUT, 'logos', 'app-icon-1080x1080.png'));
// raw (unframed) screenshots are also valid Store screenshots — keep the two overview shots for the manifest
await sharp(raw.ar_overview).resize(1920, 1080).png().toFile(path.join(root, 'screenshots', 'voxmorph-ar-1.png'));
await sharp(raw.en_overview).resize(1920, 1080).png().toFile(path.join(root, 'screenshots', 'voxmorph-en-1.png'));
await sharp(raw.ar_music).resize(1920, 1080).png().toFile(path.join(root, 'screenshots', 'voxmorph-ar-2.png'));
await sharp(raw.en_fine).resize(1920, 1080).png().toFile(path.join(root, 'screenshots', 'voxmorph-en-2.png'));
fs.writeFileSync(path.join(OUT, 'captions.json'), JSON.stringify(captions, null, 2));
server.kill();
console.log('done');
