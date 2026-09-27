// VoxMorph service worker — offline-first app shell with a versioned precache.
const VERSION = 'voxmorph-v1.1.0';
const ASSETS = [
  './', './index.html', './privacy.html', './manifest.json',
  './css/app.css',
  './js/app.js', './js/i18n.js', './js/audio-engine.js',
  './js/dsp/fft.js', './js/dsp/spectral.js', './js/dsp/timescale.js', './js/dsp/effects.js', './js/dsp/analysis.js',
  './js/dsp/presets.js', './js/dsp/pipeline.js', './js/dsp/mixer.js', './js/dsp/render-worker.js', './js/dsp/live-processor.js',
  './js/export/pcm.js', './js/export/mux.js', './js/export/index.js', './vendor/lame.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
