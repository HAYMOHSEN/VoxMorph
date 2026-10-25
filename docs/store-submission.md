# VoxMorph — حزمة النشر الكاملة في متجر Microsoft (Partner Center)

<div dir="rtl">

هذا الملف يجمع كل ما تحتاجه لإرسال النسخة الكاملة: الصور بالأحجام المطلوبة، ونصوص القائمة بالعربية والإنجليزية بحدود الأحرف الرسمية، وإجابات التصنيف العمري، وخطة السعر، وملاحظات فريق الاعتماد. انسخ كل حقل كما هو.

## 1) الملفات الجاهزة (مجلد `store/`)

| الاستخدام في Partner Center | الملف | الحجم |
|---|---|---|
| Screenshots — القائمة العربية (Desktop، حتى 10) | `store/screenshots-ar/01…08-*.png` | 1920×1080 |
| Screenshots — القائمة الإنجليزية | `store/screenshots-en/01…08-*.png` | 1920×1080 |
| Store logos → **1:1 App tile icon** (موصى به بشدة) | `store/logos/app-tile-icon-1x1-300x300.png` | 300×300 |
| Store logos → **1:1 Box art** (عربي / إنجليزي) | `store/logos/box-art-1x1-1080x1080-ar.png` / `-en.png` | 1080×1080 |
| Store logos → **2:3 Poster art** (عربي / إنجليزي) | `store/logos/poster-art-2x3-720x1080-ar.png` / `-en.png` | 720×1080 |
| Trailers & additional assets → **16:9 Super hero art** | `store/logos/super-hero-art-16x9-1920x1080-ar.png` / `-en.png` | 1920×1080 |
| صورة مربعة بلا عنوان (للترويج/Featured) | `store/logos/promotional-square-1080x1080-no-title.png` | 1080×1080 |
| أيقونة التطبيق النقية (لأي استخدام آخر) | `store/logos/app-icon-1080x1080.png` | 1080×1080 |

كل الصور PNG وأقل من 50 MB (المتطلب الرسمي). لقطات الشاشة يجب ألا تقل عن 1366×768 — لقطاتنا 1920×1080. تعليقات كل لقطة (≤ 200 حرف) موجودة في القسم 4 وفي `store/captions.json`.

الأيقونات داخل حزمة MSIX نفسها يولّدها PWABuilder تلقائياً من `manifest.json` (الأيقونة 512×512 موجودة في `icons/`)، فلا تحتاج لرفعها يدوياً.

## 2) الحزم (Packages)

1. في PWABuilder أدخل `https://haymohsen.github.io/VoxMorph/` → Package for stores → Windows → الصق **Package ID** و**Publisher ID** و**Publisher display name** من Partner Center → Product management → Product identity.
2. ارفع في قسم Packages الملفين: `VoxMorph.msixbundle` و`VoxMorph.classic.appxbundle`.
3. قبل الرفع جرّب الحزمة محلياً عبر `install.ps1` الموجود في الملف المضغوط (زر الفأرة الأيمن → Run with PowerShell).

## 3) القائمة العربية — Store listing (Arabic)

**Product name:** VoxMorph

**Short title (≤ 50):** VoxMorph — محوّل الصوت

**Sort title:** VoxMorph

**Voice title (≤ 255):** فوكس مورف

**Short description (≤ 1000، تظهر أول 270 حرفاً):**
حوّل صوتك إلى طفل أو امرأة أو مذيع أو روبوت بنقرة واحدة — 19 نمط صوت وأصوات ذكاء اصطناعي طبيعية تعمل على جهازك بلا اشتراك، للتعليق الصوتي على الفيديوهات، مع موسيقى خلفية تنخفض تلقائياً أثناء الكلام. الصوت لا يغادر جهازك.

**Description (≤ 10,000):**

VoxMorph يحوّل أي صوت — من المايكروفون مباشرة أو من ملف صوت أو فيديو بأي صيغة — إلى صوت آخر جاهز للتعليق الصوتي على فيديوهاتك، بلا إنترنت وبخصوصية كاملة.

19 نمط صوت في خمس فئات:
• طفل: طفل صغير، طفل، طفلة، مراهق
• امرأة: امرأة، شابة، مذيعة، امرأة هادئة، امرأة مسنّة
• رجل: مذيع، راوٍ، شاب، صوت عميق، رجل عجوز
• مؤثرات: روبوت، عملاق، كرتوني
• أخرى: تحسين صوتي (صوتك نفسه بجودة استوديو) ومخصص (تحكّم كامل)

أصوات الذكاء الاصطناعي (جديد): نماذج عصبية تعمل على جهازك — بالمعالج أو بكرت الشاشة — تنطق كلامك نفسه بصوت امرأة أو رجل طبيعي مع الحفاظ على النبرة والإيقاع، ومنها أنماط طفلة وطفل وامرأة مسنّة ورجل عجوز. لا خادم ولا اشتراك ولا حساب: تُنزَّل النماذج مرة واحدة عند طلبك (نحو 1 GB) ثم تعمل دون إنترنت، ويمكن إضافة أصوات جديدة بصيغة RVC.

ملاءمة تلقائية لصوتك: يقيس التطبيق طبقة صوت المتحدث ويختار مقدار التحويل المناسب، فيصل الرجل والمرأة والطفل إلى الصوت الهدف نفسه. ومنزلق "شدة التحويل" يحدد مقدار التغيير.

ضبط دقيق: طبقة الصوت، الرنين (حجم الحنجرة)، التنفّس، الاهتزاز، الخشونة، السطوع، الدفء، المعالجة الإذاعية، والضغط الديناميكي — واحفظ قالبك الخاص.

موسيقى خلفية: أضف أي ملف موسيقى تحت صوتك؛ يُخفَّض مستواها تلقائياً أثناء الكلام ويعود بين الجمل، مع مقدمة وخاتمة موسيقية، تلاشٍ في النهاية، وتكرار تلقائي إن كانت أقصر من الكلام. النتيجة ستيريو جاهزة للفيديو.

معاينة حية: فعّل المعاينة واسمع صوتك المحوَّل في سماعة الرأس أثناء الكلام.

تنظيف الصوت: تقليل الضوضاء، بوابة الصمت، وتسوية مستوى الصوت إلى المستوى القياسي للفيديو (LUFS).

قصّ المقطع واحفظه بالصيغة التي تريدها: WAV (16/24 بت) وFLAC بلا فقد، أو M4A/AAC وOGG وWebM بحجم أصغر — عبر نافذة الحفظ المعتادة في Windows.

خصوصية كاملة: كل المعالجة تتم على جهازك. لا حسابات ولا إعلانات، ولا يغادر الصوت جهازك أبداً. الإنترنت لازم فقط للتنزيل الاختياري لنماذج الذكاء الاصطناعي مرة واحدة.

واجهة عربية وإنجليزية، سحب وإفلات، اختصارات لوحة مفاتيح، ويعمل دون اتصال.

**What's new in this version (≤ 1500):**
جديد: أصوات ذكاء اصطناعي طبيعية (امرأة، رجل، طفلة، طفل، امرأة مسنّة، رجل عجوز) تعمل على جهازك بلا اشتراك، مع تسريع بكرت الشاشة عند توفره. إضافة إلى 19 نمط صوت (طفل، امرأة، رجل، مؤثرات)، ملاءمة تلقائية لطبقة صوتك، موسيقى خلفية بخفض تلقائي أثناء الكلام، معاينة حية، تقليل ضوضاء وتسوية مستوى الصوت، وحفظ بصيغ WAV وFLAC وM4A وOGG وWebM.

**Product features (حتى 20، ≤ 200 حرف لكل واحدة):**
1. 19 نمط صوت: طفل، طفلة، مراهق، امرأة، شابة، مذيعة، امرأة مسنّة، مذيع، راوٍ، شاب، صوت عميق، رجل عجوز، روبوت، عملاق، كرتوني وغيرها
2. أصوات ذكاء اصطناعي طبيعية (امرأة، رجل، طفلة، طفل، امرأة مسنّة، رجل عجوز) بنماذج عصبية تعمل على جهازك — بلا خادم ولا اشتراك، وتعمل دون إنترنت بعد تنزيل واحد
3. ملاءمة تلقائية: يقيس طبقة صوتك ويختار مقدار التحويل المناسب لأي متحدث
4. موسيقى خلفية تنخفض تلقائياً أثناء الكلام مع مقدمة وخاتمة وتلاشٍ — نتيجة ستيريو
5. معاينة حية لصوتك المحوَّل في السماعة أثناء الكلام
6. تسجيل من المايكروفون أو استيراد أي ملف صوت أو فيديو (MP3, WAV, M4A, OGG, FLAC, MP4, WebM…)
7. ضبط دقيق: طبقة الصوت، الرنين، التنفّس، الاهتزاز، السطوع، الدفء، المعالجة الإذاعية، الضغط
8. تنظيف الصوت: تقليل الضوضاء، بوابة الصمت، وتسوية المستوى إلى LUFS مستهدف
9. قص المقطع ومقارنة فورية بين الأصلي والمحوَّل
10. حفظ بصيغ WAV (16/24 بت)، FLAC، M4A/AAC، OGG، WebM
11. يعمل بلا إنترنت — الصوت لا يغادر جهازك ولا حسابات ولا إعلانات
12. واجهة عربية وإنجليزية

**Search terms (حتى 7، ≤ 40 حرفاً، ≤ 21 كلمة إجمالاً):**
محول الصوت · تغيير الصوت · تعليق صوتي · صوت طفل · صوت امرأة · صوت مذيع · ذكاء اصطناعي

**Copyright and trademark info (≤ 200):** © 2026 Hani Muhsen. جميع الحقوق محفوظة.

**Developed by (≤ 255):** Hani Muhsen

**Privacy policy URL:** https://haymohsen.github.io/VoxMorph/privacy.html

**Website:** https://haymohsen.github.io/VoxMorph/

**Support contact info:** haymohsen@gmail.com

**Additional system requirements:** مايكروفون للتسجيل والمعاينة الحية؛ يُنصح بسماعة رأس للمعاينة الحية. Windows 10 (May 2020 Update) أو أحدث. لأصوات الذكاء الاصطناعي: نحو 1 GB مساحة فارغة لتنزيل النماذج مرة واحدة، وذاكرة 8 GB موصى بها؛ كرت شاشة يدعم WebGPU يسرّع التحويل.

## 4) تعليقات لقطات الشاشة (Captions، ≤ 200 حرف)

| الملف (عربي) | التعليق |
|---|---|
| 01-overview.png | الشاشة الرئيسية: سجّل أو استورد، اختر الصوت، اسمع، واحفظ |
| 02-woman-voice.png | أنماط الأصوات النسائية |
| 03-ai-voice.png | أصوات الذكاء الاصطناعي المحلية (بلا اشتراك) |
| 04-fine-voice.png | الضبط الدقيق والملاءمة التلقائية |
| 05-fx-voice.png | المؤثرات الصوتية |
| 06-music-music.png | الموسيقى الخلفية مع الخفض التلقائي |
| 07-recording-source.png | التسجيل والمعاينة الحية |
| 08-overview-export.png | الحفظ بصيغ متعددة |

| File (English) | Caption |
|---|---|
| 01-overview.png | Main screen: record or import, pick a voice, listen, save |
| 02-woman-voice.png | Female voice styles |
| 03-ai-voice.png | Local AI voices (no subscription) |
| 04-fine-voice.png | Fine tuning and auto-adapt |
| 05-fx-voice.png | Voice effects |
| 06-music-music.png | Background music with automatic ducking |
| 07-recording-source.png | Recording and live preview |
| 08-overview-export.png | Export formats |

## 5) القائمة الإنجليزية — Store listing (English, en-US)

**Short title:** VoxMorph — Voice Changer

**Sort title:** VoxMorph

**Voice title:** VoxMorph voice changer

**Short description:**
Turn your voice into a child, woman, announcer or robot with one click — 19 voice styles plus natural AI voices that run on your own PC with no subscription, for video voice-overs, with background music that ducks automatically while you speak. Your audio never leaves your PC.

**Description:**

VoxMorph turns any voice — straight from your microphone or from an audio/video file in any format — into another voice, ready to be used as a voice-over on your videos. Fully offline, fully private.

19 voice styles in five groups:
• Child: young child, child, girl, teen boy
• Woman: woman, young woman, female anchor, soft woman, elderly woman
• Man: broadcaster, narrator, young man, deep voice, old man
• Effects: robot, giant, cartoon
• Other: Enhance (your own voice with studio polish) and Custom (full control)

AI voices (new): neural models run on your device — on the CPU or the graphics card — and speak your exact words in a natural female or male voice, keeping your intonation and timing, with derived girl, boy, elderly-woman and old-man styles. No server, no subscription, no account: the models are downloaded once when you ask for them (about 1 GB) and then work offline, and new voices in the RVC format can be added.

Adapts to your voice: the app measures the speaker's pitch and picks the right amount of change, so a man, a woman or a child all land on the same target voice. An intensity slider sets how far to go.

Fine tuning: pitch, resonance (vocal-tract size), breathiness, tremor, roughness, brightness, warmth, radio processing and compression — and save your own preset.

Background music: add any music file under your voice; it is lowered automatically while you speak and comes back between sentences, with a music intro and outro, fade-out and automatic looping when the music is shorter than the voice. The result is a stereo file ready for your video.

Live preview: switch it on and hear your converted voice in your headphones while you speak.

Clean-up: noise reduction, silence gate and loudness normalisation to the standard video level (LUFS).

Trim the clip and save it in the format you need: WAV (16/24-bit) and FLAC lossless, or M4A/AAC, OGG and WebM for smaller files — through the normal Windows save dialog.

Complete privacy: everything is processed on your device. No accounts, no ads, and your audio never leaves your PC. Internet is needed only for the optional one-time download of the AI models.

Arabic and English interface, drag & drop, keyboard shortcuts, works offline.

**What's new in this version:**
New: natural AI voices (woman, man, girl, boy, elderly woman, old man) that run on your own PC with no subscription, accelerated by the graphics card when available. Plus 19 voice styles (child, woman, man, effects), automatic adaptation to your pitch, background music with automatic ducking, live preview, noise reduction and loudness normalisation, and export to WAV, FLAC, M4A, OGG and WebM.

**Product features:**
1. 19 voice styles: child, girl, teen, woman, young woman, female anchor, elderly woman, broadcaster, narrator, young man, deep voice, old man, robot, giant, cartoon and more
2. Natural AI voices (woman, man, girl, boy, elderly woman, old man) from neural models that run on your PC — no server, no subscription; works offline after a one-time download
3. Adapts to your voice: measures your pitch and picks the right amount of change for any speaker
4. Background music that ducks automatically while you speak, with intro, outro and fade-out — stereo result
5. Live preview of your converted voice in your headphones while you speak
6. Record from the microphone or import any audio/video file (MP3, WAV, M4A, OGG, FLAC, MP4, WebM…)
7. Fine tuning: pitch, resonance, breathiness, tremor, brightness, warmth, radio processing, compression
8. Clean-up: noise reduction, silence gate and loudness normalisation to a target LUFS
9. Trim the clip and A/B-compare the original with the converted voice instantly
10. Save as WAV (16/24-bit), FLAC, M4A/AAC, OGG or WebM
11. Works offline — audio never leaves your PC; no accounts, no ads
12. Arabic and English interface

**Search terms:** voice changer · voice over · child voice · female voice · announcer voice · AI voice changer · background music

**Copyright and trademark info:** © 2026 Hani Muhsen. All rights reserved.

**Developed by:** Hani Muhsen

**Privacy policy URL:** https://haymohsen.github.io/VoxMorph/privacy.html · **Website:** https://haymohsen.github.io/VoxMorph/ · **Support:** haymohsen@gmail.com

**Additional system requirements:** Microphone for recording and live preview; headphones recommended for live preview. Windows 10 (May 2020 Update) or later. For the AI voices: about 1 GB of free disk space for the one-time model download and 8 GB RAM recommended; a WebGPU-capable graphics card speeds up the conversion.

## 6) Properties (الخصائص)

- **Category:** Multimedia design → **Subcategory:** Photo & video production (بديل مقبول: Music production).
- **Privacy policy URL:** الرابط أعلاه (إلزامي لأن التطبيق يستخدم المايكروفون).
- **Product declarations:** لا تحدد أي خيار (لا مشتريات داخل التطبيق، لا إمكانية وصول مُعلنة، لا Xbox).
- **System requirements:** الحد الأدنى: Windows 10 19041، ذاكرة 4 GB، مايكروفون؛ الموصى به: 8 GB، سماعة رأس، كرت شاشة يدعم WebGPU (لأصوات الذكاء الاصطناعي) ونحو 1 GB مساحة فارغة.
- **Display mode / Game settings:** غير مطلوبة.

## 7) Age ratings (التصنيف العمري — استبيان IARC)

أجب بـ "لا" على كل الأسئلة: لا عنف، لا محتوى جنسي، لا مواد مخدرة، لا لغة بذيئة، لا مقامرة، لا تفاعل بين المستخدمين، لا مشاركة معلومات شخصية أو موقع، لا مشتريات، لا إعلانات، لا يصل إلى الإنترنت لمحتوى غير مقيّد (التطبيق ينزّل فقط ملفات نماذج ثابتة من عناوين يحددها المطوّر، وهذا ليس محتوى مفتوحاً ولا تفاعلاً بين المستخدمين). النتيجة المتوقعة: **3+ / Everyone (PEGI 3, ESRB E)**.

## 8) Pricing and availability (السعر والتوفر)

- **Base price:** 14.99 USD (فئة سعرية قياسية)، مع **Sale pricing** إلى 9.99 USD لأول 4–6 أسابيع من النشر (أو ابدأ بـ 9.99 مباشرة ثم ارفعه لاحقاً بعد أول 20–30 تقييماً).
- **Markets:** كل الأسواق. اضبط أسعاراً مخفضة (Override base price per market) لأسواق الدخل المنخفض، مثل: الأردن، مصر، المغرب، الجزائر، تونس، العراق، الهند، باكستان، إندونيسيا، تركيا، البرازيل → ما يعادل 4.99–5.99 USD.
- **Free trial:** غير متوفر عملياً لحزم PWABuilder (تحتاج واجهة ترخيص Windows). لا تحدد تجربة.
- **Visibility:** Public audience, discoverable. **Publish date:** فور الاعتماد.
- **Organizational licensing:** يمكن ترك الخيار الافتراضي.

## 9) Submission options — Notes for certification (انسخ كما هو)

```
VoxMorph is an offline voice changer for video voice-overs. No sign-in or account is needed.

How to test:
1. Open the app. Click "Record from microphone" (allow the microphone permission), speak for ~5 seconds, then click "Stop recording". Alternatively click "Import audio or video file" and choose any MP3/WAV.
2. In "New voice", pick a category tab (Child / Woman / Man / Effects) and a style, e.g. "Broadcaster". The conversion runs locally in a few seconds; the "Converted" button plays the result and "Original" plays the source.
3. Optional: in "Background music", choose any music file — the music is mixed under the voice automatically.
4. Click "Save file" to export (WAV by default) through the standard Windows save dialog.
5. Optional AI voices: open the "AI" tab in "New voice", click "Download" next to the engine (about 740 MB, fetched from huggingface.co) and next to a voice (110 MB, from the app's own site), then pick the voice or one of the derived styles (Girl, Boy, Elderly woman, Old man) — the neural conversion runs locally and takes roughly as long as the clip itself on the CPU (faster with WebGPU). Downloaded models can be removed from the same tab.

The interface is available in Arabic (default for Arabic systems) and English — use the language button in the top bar.
All audio processing happens on the device. The only network requests are loading the app's own hosted files and, on the user's explicit request, downloading the AI model files once (from the app's GitHub Pages site and huggingface.co, verified with checksums); the app works offline otherwise. No audio or personal data is ever uploaded. The microphone is used only for recording and the optional live preview. Privacy policy: https://haymohsen.github.io/VoxMorph/privacy.html
```

## 10) قائمة التحقق قبل الضغط على Submit

- [ ] الموقع يعمل على `https://haymohsen.github.io/VoxMorph/` ورابط الخصوصية يفتح.
- [ ] الحزمتان من PWABuilder مرفوعتان ومجرّبتان محلياً (طلب المايكروفون يظهر، الحفظ يعمل).
- [ ] قائمتان لغويتان: العربية والإنجليزية، كل واحدة بنصوصها ولقطاتها الثماني وتعليقاتها.
- [ ] Store logos: أيقونة 300×300 + Box art 1080 + Poster 720×1080، وSuper hero art 1920×1080.
- [ ] Properties: الفئة، رابط الخصوصية، الدعم، الموقع.
- [ ] Age ratings مكتمل (Everyone).
- [ ] Pricing: السعر الأساسي + عرض الإطلاق + الأسواق المخفضة.
- [ ] Notes for certification منسوخة.
- [ ] تبويب الذكاء الاصطناعي: `ai-test.html` يعرض مكتبة التشغيل، وتنزيل المحرك والصوتين يعمل من الموقع المنشور، والتحويل يُسمع صحيحاً (راجع `AI-SETUP.md`).
- [ ] نص النسب (VCTK CC BY 4.0، نماذج Apache-2.0، onnxruntime MIT) موجود في صفحة الخصوصية/حول أو في وصف المتجر إن طُلب.

</div>
