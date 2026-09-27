# Optional encoders

VoxMorph exports WAV, FLAC, M4A (AAC), OGG (Opus) and WebM (Opus) with no extra files.

## MP3 (optional)

MP3 encoding is not built into browsers. To offer MP3 export, drop the LGPL-licensed
**lamejs** encoder here as `vendor/lame.min.js`:

1. Download `lame.min.js` from https://github.com/zhuker/lamejs (or `npm pack lamejs` → `lame.min.js`).
2. Replace the placeholder `vendor/lame.min.js` with it (same file name) and bump `VERSION` in `sw.js`.
3. Reload the app — the MP3 option becomes enabled automatically.

lamejs is licensed under the LGPL-3.0. Keep it as a separate, unmodified file and mention the
licence in your Store listing / about page (the "About / Licences" section in the README has the text).
