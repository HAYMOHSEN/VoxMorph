---
license: apache-2.0
datasets:
- CSTR-Edinburgh/vctk
pipeline_tag: audio-to-audio
tags:
- RVC
---

- 01/2025: Add beatrice-v2 (CPU friendly) version 30 Epochs (& [800 epochs-perhaps overcooked.](https://huggingface.co/Nekochu/RVC-VCTK_Voice-sample/commit/e6163c32c81a30f722528a6d71c549b983713591))

Trained using Mangio Fork [easiergui(rejekts)](https://imgur.com/a/4y45yfe) of [RVC WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) `08/2023`:
- Epochs: 250
- Pitch extraction algorithm: `harvest` if not `rmvpe`
- Time estimation: 6h
- Dataset: VCTK - Picked `Voice-sample` -> [JarodMica/audiosplitter_whisper](https://github.com/JarodMica/audiosplitter_whisper) for multi-voice short splits, group by speakers.

Usage:
You can use the models vc2vc with [w-okada/voice-changer](https://github.com/w-okada/voice-changer/blob/master/tutorials/tutorial_rvc_en_latest.md).