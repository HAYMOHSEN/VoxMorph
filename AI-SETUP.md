# VoxMorph — أصوات الذكاء الاصطناعي (دليل التشغيل والنشر)

<div dir="rtl">

هذا الدليل يشرح كيف تعمل **أصوات الذكاء الاصطناعي** في VoxMorph، وما الملفات التي يجب أن تكون في المستودع، وكيف تضيف أصواتاً جديدة، وكيف تتأكد أن كل شيء يعمل قبل النشر على المتجر.

## 1. كيف تعمل؟

تبويب **ذكاء اصطناعي** في التطبيق يحوّل الصوت بنماذج عصبية من نوع **RVC v2** تعمل داخل المتصفح (Edge/Chrome أو التطبيق المغلّف من المتجر) عبر مكتبة **onnxruntime-web**. لا يوجد خادم ولا اشتراك: المعالجة كلها على جهاز المستخدم.

سلسلة التحويل (كلها في `js/ai/rvc.js`):

1. **تهيئة الإدخال**: إعادة عيّنة إلى 16 kHz، مرشّح تمرير عالٍ 48 Hz، وضبط المستوى إلى −23 dBFS (يُحسب مرة واحدة للمقطع كله كي تبقى العلاقة بين الجمل الهادئة والعالية).
2. **ContentVec** (378 MB): يستخرج «محتوى الكلام» (الحروف والنبرة) بمعزل عن هوية المتحدث — 768 قيمة لكل 10 مللي ثانية.
3. **طبقة الصوت**: **RMVPE** (362 MB، اختياري وأدق) أو **YIN** المدمج. في الوضع التلقائي يُستخدم RMVPE، ويُرجَع إلى YIN إذا اختلف الاثنان بأكثر من ربع أوكتاف.
4. **الإزاحة التلقائية**: يقيس التطبيق طبقة صوت المتحدث ويحرّكها نحو `targetF0` الخاص بالصوت الهدف (رجل → امرأة ≈ +7 نصف درجة … إلخ)، ويمكنك تعديلها بمنزلق الطبقة.
5. **المولّد** (نموذج الصوت، ≈110 MB لكل صوت): يُنتج الكلام بصوت الهدف عند 40 kHz، ثم يُعاد إلى معدّل المشروع.
6. **ما بعد المعالجة**: تقليل الضوضاء قبل التحويل، ثم السطوع/الدفء/المعالجة الإذاعية/الضغط/التسوية من محرك VoxMorph نفسه، والموسيقى الخلفية كالمعتاد.

**الأنماط المشتقّة (طفلة، طفل، امرأة مسنّة، رجل عجوز)** — `js/ai/styles.js`: تُبنى على نموذج المرأة أو الرجل العصبي. يطلب التطبيق من المولّد العصبي طبقة الهدف مباشرة (`targetF0`: طفلة 275، طفل 245، امرأة مسنّة 170، رجل عجوز 125 Hz — فالتغيير في الطبقة يُولَّد ولا يُركَّب لاحقاً)، ثم تُطبَّق طبقة الشخصية من محرك VoxMorph على الناتج: نسبة حجم الحنجرة (formant ×1.14 للطفلة، ×1.07 للطفل، ×0.97/0.98 لكبار السن)، التنفّس، اهتزاز الشيخوخة، الخشونة، السطوع والدفء. كل منزلقات الضبط الدقيق تعمل معها (تُضاف إلى قيم النمط)، ومنزلق «شدة التحويل» يضبط مقدار الشخصية. يختار النمط تلقائياً النموذج المنزَّل من فئته (`category: woman` أو `man`)؛ وإن أضفت لاحقاً نموذج RVC مدرَّباً على طفل أو مسنّ حقيقي فيظهر كصوت مستقل في التبويب ويمكن أيضاً جعله أساساً لنمط بتغيير `base` في `styles.js`.

المقاطع الطويلة تُقسَّم إلى قطع ≈20 ثانية تُقطع عند أهدأ نقطة، مع سياق 0.35 ثانية حول كل قطعة ودمج متقاطع 20 مللي ثانية عند الوصلات.

**الأداء**: على المعالج (WebAssembly متعدد الخيوط) يستغرق التحويل تقريباً 1–2 ثانية لكل ثانية صوت على جهاز حديث (8 أنوية)، وعلى كرت الشاشة عبر **WebGPU** أسرع بكثير. يختار التطبيق WebGPU تلقائياً إن وُجد، ويتحقّق أولاً أن المولّد يعطي صوتاً صحيحاً، وإلا يرجع إلى المعالج. يمكن للمستخدم إجبار «المعالج فقط» من تبويب الذكاء الاصطناعي → **الحساب**.

## 2. الملفات اللازمة في المستودع

### أ) مكتبة التشغيل `vendor/ort/` (onnxruntime-web 1.30.0)

| الملف | الحجم | الغرض |
|---|---|---|
| `ort.wasm.bundle.min.mjs` | 73 KB | حزمة المعالج (WebAssembly) |
| `ort-wasm-simd-threaded.wasm` | 14.2 MB | محرك المعالج |
| `ort.bundle.min.mjs` | 414 KB | حزمة كرت الشاشة (WebGPU/JSEP) + المعالج |
| `ort-wasm-simd-threaded.jsep.wasm.000` و`.001` | 24 + 3 MB | محرك WebGPU مقسوماً إلى جزأين (الملف الأصلي 28.3 MB أكبر من حد الرفع 25 MB في موقع GitHub؛ التطبيق يجمعهما تلقائياً عند التحميل) |
| `LICENSE.txt`, `ONNXRUNTIME-README.md` | — | ترخيص MIT وملاحظات المكتبة |

كل هذه الملفات مأخوذة من حزمة npm الرسمية `onnxruntime-web@1.30.0` (مجلد `dist/`). ملفات الـglue (`ort-wasm-simd-threaded*.mjs`) غير لازمة لأن حزم `*.bundle.min.mjs` تحتويها. لتقسيم ملف كبير إلى أجزاء: `python tools/split_model_parts.py <file> --out vendor/ort --mb 24` (أو أي أداة تقسيم ثنائية — المهم اللاحقة `.000`, `.001` …).

التطبيق يحمّل مكتبة التشغيل مرة واحدة ويخزّنها في كاش عامل الخدمة؛ لا تُحمَّل إلا عند أول استخدام لتبويب الذكاء الاصطناعي، فلا تؤثر على سرعة فتح التطبيق.

### ب) حزمة النماذج `models/`

- `models/manifest.json` — قائمة المحرك والأصوات (الروابط، الأحجام، sha256، معدل العيّنة، `targetF0`، الفئة، الترخيص). التطبيق يقرأها عبر الشبكة أولاً ثم من الكاش.
- `models/parts/` — ملفات الأصوات مقسومة إلى أجزاء ≤24 MB: `female-p231.onnx.000…004` و`male-p226.onnx.000…004` (الأصل 110.8 MB لكل صوت).
- `models/licenses/` و`models/voices-provenance.json` — التراخيص ومصادر النماذج (انظر §6).

**المحرك** (ContentVec وRMVPE) غير موجود في المستودع لأن حجمه ≈740 MB، وحد موقع GitHub Pages الكلي 1 GB. يُنزَّل عند أول استخدام من Hugging Face (الروابط في `manifest.json`، مع sha256 للتحقق) ويُخزَّن على جهاز المستخدم. بدائل:

- **استضافة ذاتية**: ضع الملفين على أي استضافة ثابتة تسمح بـ CORS (مثل مستودع ثانٍ على GitHub Pages أو Cloudflare R2) مقسومين بأداة `split_model_parts.py`، وغيّر `url` إلى `parts: [...]` في المانيفست. ملفات الأجزاء الكاملة: ContentVec 377,655,729 بايت (16 جزءاً) وRMVPE 361,688,443 بايت (15 جزءاً).
- **استيراد يدوي**: من تبويب الذكاء الاصطناعي يمكن للمستخدم اختيار ملف `.onnx` من جهازه (ContentVec أو RMVPE أو أي صوت) ليُخزَّن محلياً دون تنزيل.

### ج) ملفات التطبيق

`js/ai/` (rvc.js, model-store.js, ai-worker.js, ai-client.js) و`ai-test.html` (صفحة التشخيص) مضافة إلى `sw.js`. مع كل تحديث غيّر `VERSION` في `sw.js` (الآن `voxmorph-v1.3.0`).

## 3. الرفع إلى GitHub

ارفع المستودع كما هو مع الحفاظ على بنية المجلدات. حد موقع GitHub للرفع عبر المتصفح هو 25 MB للملف الواحد؛ كل ملف هنا أصغر من ذلك (أكبرها `ort-wasm-simd-threaded.jsep.wasm.000` = 24 MB و`ort-wasm-simd-threaded.wasm` = 14.2 MB). لو كان لديك git على الجهاز فالحد 100 MB ولا تحتاج التقسيم للمكتبة، لكن أبقِ الأجزاء كما هي لأن المانيفست يشير إليها.

بعد الرفع افتح `https://haymohsen.github.io/VoxMorph/ai-test.html`:

1. يجب أن يظهر «runtime: ort.wasm.bundle.min.mjs …» أو «ort.bundle.min.mjs …» في السجل، مع عدد الخيوط (crossOriginIsolated = true يعني أن تعدد الخيوط يعمل).
2. اضغط **Download** للمحرك ثم لصوت، ثم **Benchmark**: يطبع زمن التحويل ونسبة السرعة إلى الزمن الحقيقي، وطريقة كشف الطبقة (rmvpe/yin).
3. سجّل جملة وحوّلها واستمع.

## 4. إضافة أصوات جديدة (طفل، رجل عجوز، مذيع …)

أي نموذج **RVC v2** (768، f0) يعمل. الطريقة الموثوقة:

1. **التدريب أو التنزيل**: درّب نموذجاً في [Applio](https://applio.org) أو RVC WebUI على 10–30 دقيقة من كلام نقي للصوت الهدف (طفل/امرأة/رجل عجوز/مذيع)، أو استخدم نموذجاً مرخّصاً تجارياً. تأكد من **ترخيص** النموذج وبيانات التدريب قبل بيع التطبيق، واحتفظ بالمصدر في `models/voices-provenance.json`.
2. **التصدير إلى ONNX** بعقد الإدخالات الستة (`phone, phone_lengths, pitch, pitchf, ds, rnd` → `audio`):
   ```
   pip install torch onnx onnxruntime numpy
   python tools/export_rvc_onnx_compatible.py --pth MyVoice.pth --out myvoice-raw.onnx
   ```
   (الأداة في `tools/` مع المصدر الأصلي `tools/source/` من Mangio-RVC-Fork بترخيص MIT.)
3. **تثبيت مولّد الجيب (إلزامي لكل نموذج RVC مصدَّر)**:
   ```
   python tools/fix_rvc_onnx_sine.py myvoice-raw.onnx myvoice.onnx --check
   ```
   تصدير RVC الأصلي يحسب طور الإثارة (NSF sine) بمجموع تراكمي float32 على كامل المقطع؛ في onnxruntime (على المعالج وفي المتصفح) ينجرف هذا الطور بعد أي صمت يقارب الثانية فتخرج طبقة الصوت ثابتة الخطأ (−5% أو +5.6% أو −15.6%) حتى نهاية المقطع — وهو ما كان يحدث في نسخ التحويل المرجعية داخل حزمة الاختبار. الأداة تستبدل هذا الجزء من الرسم بصيغة محدودة مكافئة رياضياً دون تغيير أي وزن، وتطبع مع `--check` طبقة الصوت بعد فجوة صمت للنموذجين (الأصلي ينجرف، المعدَّل يبقى على 185 Hz). الصوتان المضمّنان في التطبيق معالجان بها (الأحجام وsha256 في `models/voices-provenance.json` مع sha256 التصدير الأصلي).
4. **التحقق** بالتحويل المرجعي في Python (نفس خطوات المتصفح تماماً):
   ```
   python tools/rvc_onnx_check.py --contentvec vec-768-layer-12.onnx --rmvpe rmvpe.onnx \
       --voice myvoice.onnx --input sample.wav --out converted.wav --transpose 0
   ```
5. **التقسيم والإضافة**:
   ```
   python tools/split_model_parts.py myvoice.onnx --out models/parts --mb 24 --base ./parts/
   ```
   تطبع الأداة مقطع JSON (`parts`, `size`, `sha256`) — أضفه إلى `voices` في `models/manifest.json` مع `id`, `name` (ar/en), `category` (`child` | `woman` | `man` | `effects`), `sampleRate` (32000/40000/48000 حسب التدريب), `targetF0` (الطبقة المتوسطة للصوت الهدف بالهرتز: طفل ≈ 260–300، امرأة ≈ 180–220، رجل ≈ 100–130، رجل عجوز ≈ 110–140), و`license`.
6. غيّر `VERSION` في `sw.js` وارفع. يظهر الصوت الجديد في تبويب الذكاء الاصطناعي مع زر تنزيل.

ملاحظة عن **الطفل**: نماذج RVC تُدرَّب على المتحدث الهدف نفسه؛ لصوت طفل واقعي تحتاج تسجيلات طفل بترخيص واضح. البديل الموجود في التطبيق: صوت امرأة بالذكاء الاصطناعي + إزاحة طبقة +3…+5 نصف درجة من المنزلق، أو قوالب «طفل» في محرك DSP.

## 5. الاختبارات

```
node test/ai_test.mjs                       # وحدات: mel/RMVPE/coarse pitch/التقطيع/التحويل مع محاكاة ORT
node test/ai_styles_test.mjs                # الأنماط المشتقّة على مخرجات عصبية حقيقية (بعد tools/rvc_onnx_check.py)
node test/e2e.mjs                           # واجهة كاملة في Chromium مع محاكاة ORT (تشمل تبويب الذكاء الاصطناعي)
node test/ort_build_smoke.mjs               # مكتبة التشغيل الحقيقية: حزمة المعالج
node test/ort_build_smoke.mjs 'ort-wasm-simd-threaded\.wasm$'   # حزمة WebGPU المجمّعة من جزأين (على المعالج)
node test/ai_real_test.mjs [--long]         # التحويل الحقيقي الكامل (يحتاج test/real-models/: ContentVec, RMVPE, الصوتان، العيّنة العربية)
python tools/rvc_onnx_check.py ...          # المرجع في Python للمقارنة
```

نتائج `ai_real_test.mjs` على العيّنة العربية (16 ثانية): المتصفح يعطي نفس نتيجة Python (onnxruntime) على النموذج نفسه — اتفاق التصويت 96–98%، فرق طبقة الصوت الوسيط 0–1 سنت، ارتباط الطيف طويل الأمد ≥0.994 — وبعد تثبيت مولّد الجيب تتبع طبقة الصوت الناتجة طبقة الإدخال (مع الإزاحة المطلوبة) على طول المقطع، كما يُختبر المقطع الطويل (49 ثانية، 3 قطع) للمستوى والاستمرارية عند الوصلات.

## 6. التراخيص والنسب (مهم للمتجر)

| المكوّن | الترخيص | ملاحظات |
|---|---|---|
| onnxruntime-web 1.30.0 | MIT | `vendor/ort/LICENSE.txt` |
| نموذجا الصوت p231 وp226 (Nekochu/RVC-VCTK_Voice-sample) | Apache-2.0 | `models/licenses/Apache-2.0.txt`, `Nekochu-model-card.md` |
| بيانات التدريب VCTK | CC BY 4.0 | `models/licenses/CC-BY-4.0-VCTK.txt` — اذكر المصدر في صفحة «حول» أو الخصوصية |
| العيّنة العربية (Google FLEURS) | CC BY 4.0 | للاختبار فقط، ليست جزءاً من التطبيق المنشور |
| ContentVec (الأوزان الأصلية auspicious3000/contentvec) | MIT | ملف ONNX على Hugging Face (NaruseMioShirakana/MoeSS-SUBModel) تصدير مباشر للأوزان؛ لإصدار تجاري مستقل صدّر نسختك: `tools/export_contentvec_onnx.py --fairseq hubert_base.pt --out vec-768-layer-12.onnx --reference <الملف المعروف>` (الأداة تقارن النتيجة بالمرجع وترفض أي اختلاف) |
| RMVPE (lj1995/VoiceConversionWebUI) | MIT | من مستودع RVC WebUI |
| كود التصدير (Mangio-RVC-Fork) | MIT | `tools/source/LICENSE` |

نص النسب جاهز في `models/licenses/ATTRIBUTION.txt`؛ وصف المتجر المحدَّث في `docs/store-submission.md`.

</div>

---

## English summary

The **AI** tab converts speech with RVC v2 neural models (woman and man) and derives **girl, boy, elderly-woman and old-man** styles from them (`js/ai/styles.js`: the generator is asked for the style's target pitch, then VoxMorph's character layer — vocal-tract ratio, breath, tremor, roughness, tone — runs on the neural output; all fine-tuning sliders apply). It running in the browser through onnxruntime-web 1.30 — no server, no subscription. Pipeline (`js/ai/rvc.js`): 16 kHz conditioning (48 Hz HPF, −23 dBFS computed once per clip) → ContentVec features (768-d, 100 Hz) → RMVPE or YIN pitch with automatic transposition towards the voice's `targetF0` → RVC generator (40 kHz) → VoxMorph post-processing and music bed. Long clips are cut at quiet points into ≈20 s chunks with 0.35 s context and 20 ms cross-fades.

Every exported RVC voice must go through `tools/fix_rvc_onnx_sine.py`: the original export's NSF sine source accumulates phase in float32 and drifts in pitch after ~1 s of silence when run in onnxruntime (the bundled voices are already fixed; weights are unchanged). Ship `vendor/ort/` (`ort.wasm.bundle.min.mjs` + `ort-wasm-simd-threaded.wasm` for CPU; `ort.bundle.min.mjs` + `ort-wasm-simd-threaded.jsep.wasm.000/.001` for WebGPU — the loader stitches split files and falls back to CPU automatically, with a self-check of the generator output on WebGPU) and `models/` (manifest, voice parts ≤24 MB each, licences). The engine models (ContentVec 378 MB, RMVPE 362 MB) are fetched from Hugging Face on first use, checksum-verified and cached on the device; they can also be self-hosted as parts or imported from a local file. New voices: train/export RVC v2 → `tools/export_rvc_onnx_compatible.py` → verify with `tools/rvc_onnx_check.py` → `tools/split_model_parts.py` → add the printed entry to `models/manifest.json` (`category`, `targetF0`, `sampleRate`, `license`) → bump `VERSION` in `sw.js`. Tests: `test/ai_test.mjs`, `test/e2e.mjs`, `test/ort_build_smoke.mjs`, `test/ai_real_test.mjs [--long]`. The browser output matches the Python reference conversions (voicing agreement 96–98 %, median pitch difference ≤1 cent, long-term spectrum correlation ≥0.994).
