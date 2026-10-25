# VoxMorph — Voice Changer for Voice-over

<div dir="rtl">

**VoxMorph** تطبيق ويب تقدّمي (PWA) يحوّل أي صوت — من المايكروفون أو من ملف بأي صيغة — إلى صوت آخر لاستخدامه في التعليق الصوتي على الفيديوهات: **طفل، امرأة، رجل عجوز، مذيع (رجل إعلامي)**، إضافة إلى **تحسين صوتي** و**مخصص**، و**أصوات ذكاء اصطناعي** بنماذج عصبية (RVC) تعمل على الجهاز بلا خادم ولا اشتراك. كل المعالجة تتم على الجهاز، والصوت لا يغادر الجهاز أبداً.

## المزايا

- تسجيل من المايكروفون (مع اختيار الجهاز ومقياس مستوى الصوت) أو استيراد ملف صوت/فيديو بأي صيغة يقرؤها المتصفح (MP3, WAV, M4A/AAC, OGG/Opus, FLAC, WebM, MP4 …) بالسحب والإفلات أيضاً.
- **19 نمط صوت** في خمس فئات: **طفل** (طفل صغير، طفل، طفلة، مراهق)، **امرأة** (امرأة، شابة، مذيعة، امرأة هادئة، امرأة مسنّة)، **رجل** (مذيع، راوٍ، شاب، صوت عميق، رجل عجوز)، **مؤثرات** (روبوت، عملاق، كرتوني)، و**أخرى** (تحسين صوتي، مخصص) — مع منزلق **شدة التحويل**.
- **أصوات الذكاء الاصطناعي (تبويب «ذكاء اصطناعي»)**: تحويل عصبي حقيقي (RVC v2 عبر onnxruntime-web) يُنطق كلامك بصوت امرأة أو رجل طبيعي مع الحفاظ على النبرة، وأنماط مشتقّة منهما: **طفلة، طفل، امرأة مسنّة، رجل عجوز** (المولّد العصبي يعطي طبقة الهدف ثم تُضاف شخصية الصوت: حجم الحنجرة، التنفّس، الاهتزاز، الخشونة)؛ يعمل على المعالج (WebAssembly متعدد الخيوط) أو على كرت الشاشة (WebGPU) داخل التطبيق، وتُنزَّل النماذج مرة واحدة ثم تعمل دون إنترنت. التفاصيل الكاملة (الملفات، إضافة أصوات، التراخيص، الاختبارات) في **`AI-SETUP.md`**.
- **موسيقى خلفية**: استورد أي ملف موسيقى؛ يُخفَّض مستواها تلقائياً أثناء الكلام (ducking) ويعود بين الجمل، مع مقدمة وخاتمة موسيقية، تلاشٍ في النهاية، تكرار تلقائي إن كانت أقصر من الكلام، وضبط مستوى الموسيقى — والنتيجة ستيريو في كل صيغ الحفظ.
- **ملاءمة تلقائية لصوتك**: يقيس التطبيق طبقة صوت المتحدث ويختار مقدار التحويل المناسب (رجل أو امرأة أو طفل يحصلون على نفس الصوت الهدف).
- **ضبط دقيق**: طبقة الصوت، الرنين (حجم الحنجرة)، التنفّس، الاهتزاز، الخشونة، السطوع، الدفء، المعالجة الإذاعية، الضغط الديناميكي، وحفظ قالب خاص.
- **تنظيف الصوت**: تقليل ضوضاء طيفي، بوابة ضوضاء، تسوية مستوى الصوت إلى LUFS مستهدف (−14 … −23).
- **قص المقطع** (بداية/نهاية) ومعاينة A/B فورية بين الأصلي والمحوَّل.
- **معاينة حية**: اسمع صوتك المحوَّل في السماعة أثناء الكلام (AudioWorklet، تأخير ≈ 100 مللي ثانية).
- **حفظ بأي صيغة**: WAV (16/24 بت)، FLAC (بلا فقد)، M4A/AAC، OGG/Opus، WebM/Opus — وMP3 عند إضافة مكتبة lamejs الاختيارية (انظر `vendor/README.md`). الحفظ عبر نافذة "حفظ باسم" الأصلية في Windows.
- واجهة عربية (RTL) وإنجليزية، تعمل دون اتصال، وجاهزة للتغليف لمتجر Microsoft عبر PWABuilder.

## طريقة عمل المحرك (باختصار)

1. **تقليل الضوضاء** طيفي (Wiener بقرار موجّه) مع بروفايل ضوضاء يُقاس من أهدأ إطارات المقطع.
2. **إزاحة الرنين (formants)**: يُقدَّر الغلاف الطيفي بالكبستروم المُرشَّح ويُعاد رسمه بنسبة الهدف — فيتغيّر "حجم الحنجرة" دون المساس بطبقة الصوت.
3. **تغيير الطبقة**: تمديد زمني WSOLA ثم إعادة عيّنة بمرشح sinc متعدد الأطوار (32 tap, Kaiser).
4. **الطابع**: اهتزاز الشيخوخة (تأخير مُعدَّل + تريمولو غير منتظم)، تنفّس (ضوضاء مشكّلة بالغلاف)، خشونة، معادل صوتي، سلسلة إذاعية (HPF، رفوف، حضور، de-ess)، ضاغط، محدّد قمم بنظر مسبق.
5. **تسوية** إلى LUFS مستهدف (وفق ITU-R BS.1770 تقريبياً) مع سقف −1 dBFS.
6. **مزج الموسيقى** (`js/dsp/mixer.js`): تُقاس شدة الموسيقى وتُضبط عند مرجع −22 LUFS، ثم يُطبَّق غلاف خفض (ducking) يستبق الكلام بـ 60 مللي ثانية ويعود خلال ~0.7 ثانية، مع تكرار بتقاطع ناعم ومحدّد قمم ستيريو مرتبط.

المحرك مكتوب بالكامل بـ JavaScript خالص (بدون مكتبات خارجية) في `js/dsp/` ويُستخدم نفسه في العامل (Worker) للتحويل الكامل وفي AudioWorklet للمعاينة الحية.

7. **أصوات الذكاء الاصطناعي** (`js/ai/`): تهيئة 16 kHz → ContentVec (محتوى الكلام) → RMVPE/YIN (طبقة الصوت) مع إزاحة تلقائية نحو طبقة الصوت الهدف → مولّد RVC (40 kHz) → معالجة VoxMorph اللاحقة والموسيقى. النماذج تُخزَّن في Cache Storage بعد التحقق من sha256، والتشغيل في Worker منفصل عبر onnxruntime-web (`vendor/ort/`).

## النشر على GitHub Pages ثم متجر Microsoft

الطريقة نفسها التي استخدمتها في تطبيقاتك السابقة:

1. أنشئ مستودعاً عاماً باسم **`VoxMorph`** على GitHub وارفع كل الملفات (احفظ بنية المجلدات كما هي). كل ملف أصغر من 25 MB (حد الرفع عبر المتصفح)؛ الملفات الكبيرة (مكتبة WebGPU ونماذج الأصوات) مقسومة إلى أجزاء `.000`, `.001` … يجمعها التطبيق تلقائياً.
2. فعّل **GitHub Pages** من الفرع الرئيسي (مجلد الجذر). سيكون العنوان: `https://haymohsen.github.io/VoxMorph/` — العنوان **حساس لحالة الأحرف** (كما حدث مع Rfoof).
3. افتح العنوان في Edge وتأكد أن التطبيق يعمل، واختبر التسجيل والتحويل والحفظ. (يجب أن يكون العنوان HTTPS حتى يعمل المايكروفون وعامل الخدمة.)
4. في **Partner Center**: أنشئ منتجاً جديداً (MSIX or PWA app) واحجز الاسم **VoxMorph** (وإن كان محجوزاً جرّب مثلاً `VoxMorph Voice Changer`)، ثم انسخ **Package ID** و**Publisher ID** و**Publisher display name** من Product identity.
5. في **PWABuilder** (pwabuilder.com): أدخل العنوان → Package for stores → Windows → الصق القيم الثلاث → Download package. ستحصل على ملف `.msixbundle` و`.classic.appxbundle`.
6. **اختبر الحزمة محلياً قبل الرفع**: ثبّت الحزمة على جهازك (الملف `.msixbundle` يفتح بمثبّت التطبيقات، أو PowerShell: `Add-AppxPackage .\VoxMorph.msixbundle`) وتأكد أن طلب إذن المايكروفون يظهر عند الضغط على "تسجيل"، وأن الحفظ يفتح نافذة "حفظ باسم". التطبيق المغلّف يعمل داخل Edge، فإذن المايكروفون هو إذن Edge نفسه، وإعدادات Windows → الخصوصية → المايكروفون يجب أن تسمح لتطبيقات سطح المكتب.
7. في **Submission**: ارفع الحزمتين، السعر (شراء لمرة واحدة)، التصنيف العمري، ورابط سياسة الخصوصية (إلزامي لأن التطبيق يستخدم المايكروفون): `https://haymohsen.github.io/VoxMorph/privacy.html`.
8. حزمة النشر الكاملة في `docs/store-submission.md` (نصوص القائمة بالعربية والإنجليزية بحدود الأحرف الرسمية، تعليقات اللقطات، الفئة، التصنيف العمري، السعر، وملاحظات الاعتماد) والصور الجاهزة بالأحجام المطلوبة في `store/` (لقطات 1920×1080 لكل لغة، وشعارات 300×300 و1080×1080 و720×1080 و1920×1080).

**التحديثات لاحقاً**: أي تعديل في الملفات يُنشر تلقائياً للمستخدمين بمجرد رفعه إلى GitHub (غيّر رقم `VERSION` في `sw.js` مع كل تحديث ليتم تحميل الملفات الجديدة). إعادة التغليف في PWABuilder لازمة فقط عند تغيير `manifest.json` (الاسم، الأيقونات …).

## البنية

```
index.html            الواجهة (عربي/إنجليزي)
css/app.css           التصميم
js/app.js             منطق التطبيق
js/i18n.js            النصوص بالعربية والإنجليزية
js/audio-engine.js    المايكروفون، التشغيل، فك الترميز، جسر العامل
js/dsp/               المحرك: fft, spectral (تقليل ضوضاء + رنين), timescale (WSOLA + resampler),
                      effects, analysis (YIN, LUFS), presets (19 نمطاً), pipeline, mixer (الموسيقى),
                      render-worker, live-processor
js/export/            pcm (WAV, FLAC), mux (Ogg, WebM, MP4), index (WebCodecs + حفظ)
js/ai/                أصوات الذكاء الاصطناعي: rvc (السلسلة العصبية), styles (الأنماط المشتقّة), model-store, ai-worker, ai-client
vendor/ort/           onnxruntime-web 1.30 (حزمة المعالج + حزمة WebGPU مقسومة)
models/               manifest.json (المحرك والأصوات)، parts/ (نماذج الأصوات مقسومة)، licenses/
ai-test.html          صفحة تشخيص الذكاء الاصطناعي (الحالة، التنزيل، التحويل، قياس السرعة)
tools/                تصدير نماذج RVC/ContentVec إلى ONNX، التحقق المرجعي في Python، تقسيم الملفات
manifest.json, sw.js  PWA (عمل دون اتصال)
privacy.html          سياسة الخصوصية (عربي/إنجليزي)
icons/, screenshots/  أصول المتجر
docs/                 حزمة النشر في المتجر (store-submission.md)
store/                لقطات الشاشة والشعارات الجاهزة للمتجر
test/                 اختبارات Node وPlaywright (اختيارية)
```

## الاختبارات (اختياري)

```
python3 test/synth_speech.py      # يولّد إشارات كلام اصطناعية
node test/render_test.mjs         # يقيس طبقة الصوت والطول لكل قالب
python3 test/analyze.py           # يقيس نسب الرنين (LPC)
node test/mux_test.mjs            # يتحقق من الحاويات والمشفّرات بـ ffmpeg
node test/mixer_test.mjs          # يختبر مزج الموسيقى (الخفض، الطول، الستيريو) وكل الأنماط
node test/e2e.mjs --screens       # اختبار كامل في Chromium + لقطات الشاشة
node test/store_assets.mjs        # يولّد صور المتجر (لقطات مؤطرة عربي/إنجليزي + الشعارات)
node test/ai_test.mjs             # وحدات الذكاء الاصطناعي مع محاكاة onnxruntime
node test/ort_build_smoke.mjs     # مكتبة التشغيل الحقيقية في Chromium
node test/ai_real_test.mjs --long # التحويل العصبي الحقيقي ومقارنته بالمرجع (يحتاج النماذج في test/real-models/)
```

## الترخيص

كود VoxMorph ملك لصاحبه (Prof. Hani Muhsen) — جميع الحقوق محفوظة. محرك DSP لا يستخدم أي مكتبة خارجية؛ مكتبة MP3 الاختيارية (lamejs, LGPL-3.0) غير مضمّنة، وطريقة إضافتها في `vendor/README.md`. أصوات الذكاء الاصطناعي تستخدم onnxruntime-web (MIT) ونماذج بترخيص Apache-2.0 مدرَّبة على VCTK (CC BY 4.0) — النسب الكامل في `models/licenses/ATTRIBUTION.txt` و`AI-SETUP.md`.

</div>

---

## English summary

VoxMorph is an offline PWA that converts microphone or file audio into 19 voice styles (child ×4, woman ×5, man ×5, effects ×3, enhance, custom) plus neural **AI voices** (RVC v2 running in the browser through onnxruntime-web on CPU or WebGPU, no server or subscription; woman and man models plus derived girl, boy, elderly-woman and old-man styles — see `AI-SETUP.md`) for video voice-overs, and can lay the result over a background-music bed with automatic ducking, intro/outro and fades (stereo output). The pure-JavaScript engine (`js/dsp/`) does spectral noise reduction, cepstral formant warping, WSOLA + polyphase-sinc pitch shifting, character effects (tremor, breath, roughness, EQ, radio chain, compressor, look-ahead limiter) and BS.1770-style loudness normalisation; the same code powers the render Worker and the real-time AudioWorklet monitor. Exports: WAV, FLAC, M4A/AAC, OGG/Opus, WebM/Opus (MP3 via optional lamejs). Publish with GitHub Pages + PWABuilder; the Store listing text is in `docs/store-listing.md`, the privacy policy in `privacy.html`.
