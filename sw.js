// VoxMorph service worker — offline-first app shell with a versioned precache.
const VERSION = 'voxmorph-v1.3.2';
// Cross-origin isolation lets onnxruntime-web use several CPU threads (SharedArrayBuffer).
const COI = true;
const ASSETS = [
  './', './index.html', './privacy.html', './manifest.json',
  './css/app.css',
  './js/app.js', './js/i18n.js', './js/audio-engine.js',
  './js/dsp/fft.js', './js/dsp/spectral.js', './js/dsp/timescale.js', './js/dsp/effects.js', './js/dsp/analysis.js',
  './js/dsp/presets.js', './js/dsp/pipeline.js', './js/dsp/mixer.js', './js/dsp/render-worker.js', './js/dsp/live-processor.js',
  './js/export/pcm.js', './js/export/mux.js', './js/export/index.js', './vendor/lame.min.js',
  './js/ai/rvc.js', './js/ai/model-store.js', './js/ai/ai-worker.js', './js/ai/ai-client.js', './js/ai/styles.js', './models/manifest.json', './ai-test.html',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function withIsolation(res) {
  if (!COI || !res || res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // model downloads from other hosts go straight to the network
  if (/\/models\/(parts\/|.*\.onnx)/.test(url.pathname)) return; // neural models are stored once, by the model store (Cache Storage 'voxmorph-models')
  const networkFirst = /\/models\/manifest\.json$/.test(url.pathname);
  const immutable = /\/vendor\//.test(url.pathname);          // runtime files: cache-first, no background revalidation (they change with VERSION)
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    const fromNetwork = async () => {
      const res = await fetch(req);
      if (res && res.ok && res.status === 200 && url.pathname.indexOf('/test/') === -1) { try { await cache.put(req, res.clone()); } catch { /* storage full */ } }
      return res;
    };
    if (networkFirst) {
      try { return withIsolation(await fromNetwork()); } catch { return withIsolation(cached); }
    }
    if (cached) { if (!immutable) fromNetwork().catch(() => {}); return withIsolation(cached); }
    try { return withIsolation(await fromNetwork()); } catch (e) { return cached ? withIsolation(cached) : Response.error(); }
  })());
});
