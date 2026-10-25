// VoxMorph AI — Worker that hosts onnxruntime-web and the RVC engine.
// Messages: init, status, install, remove, loadEngine, loadVoice, unloadVoice, convert, benchmark.
import { RvcEngine } from './rvc.js';
import { installedModels, installModel, installFromBuffer, removeModel, loadModelBytes, storageEstimate } from './model-store.js';

let ort = null, engine = null;
const state = { ep: null, threads: 1, ortVersion: '', engineLoaded: false, rmvpe: false, voiceId: null, ortSource: '', build: '', gpuChecked: false };
const loaded = { contentvecId: null, dims: 768, rmvpeId: null, voice: null };
const aborts = new Map();

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const log = (text) => post({ type: 'log', text });

// onnxruntime-web 1.30 ships one bundle per backend set; each bundle is tied to one WebAssembly build
// (bundle → glue .mjs → .wasm). vendor/ort/ may hold any subset of these; files above GitHub's 25 MB
// web-upload limit may be published as parts (name.wasm.000, .001 …) which are stitched at load time.
const ORT_BUILDS = {
  jsep:   { bundle: 'ort.bundle.min.mjs',        wasm: 'ort-wasm-simd-threaded.jsep.wasm',     gpu: true  }, // wasm + WebGPU (JSEP) + WebNN — the default build
  all:    { bundle: 'ort.all.bundle.min.mjs',    wasm: 'ort-wasm-simd-threaded.jsep.wasm',     gpu: true  }, // + WebGL
  webgpu: { bundle: 'ort.webgpu.bundle.min.mjs', wasm: 'ort-wasm-simd-threaded.asyncify.wasm', gpu: true  }, // wasm + native WebGPU EP
  wasm:   { bundle: 'ort.wasm.bundle.min.mjs',   wasm: 'ort-wasm-simd-threaded.wasm',          gpu: false }, // CPU only (14 MB)
};

/** Fetch the .wasm of a build — published either as parts (name.000, .001 …) or as one file. Returns { bytes, parts } | null. */
async function fetchWasm(base, name) {
  const parts = [];
  for (let i = 0; i < 40; i++) {
    const r = await fetch(base + name + '.' + String(i).padStart(3, '0')).catch(() => null);
    if (!r || !r.ok) break;
    parts.push(new Uint8Array(await r.arrayBuffer()));
  }
  if (!parts.length) {
    const r = await fetch(base + name).catch(() => null);
    if (!r || !r.ok) return null;
    parts.push(new Uint8Array(await r.arrayBuffer()));
  }
  let n = 0; for (const p of parts) n += p.length;
  const bytes = parts.length === 1 ? parts[0] : new Uint8Array(n);
  if (parts.length > 1) { let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; } }
  // WebAssembly magic number: a 404 page or a truncated upload must not reach the runtime
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error(`${name} is not a WebAssembly file (${parts.length} part(s), ${n} bytes)`);
  return { bytes, parts: parts.length };
}

async function loadOrt(prefer) {
  if (ort) return;
  const base = new URL('../../vendor/ort/', import.meta.url).href;
  let webgpu = false;
  if (prefer !== 'wasm' && typeof navigator !== 'undefined' && navigator.gpu) {
    try { const adapter = await navigator.gpu.requestAdapter(); webgpu = !!adapter; } catch { webgpu = false; }
  }
  const order = webgpu ? ['jsep', 'webgpu', 'all', 'wasm'] : ['wasm', 'jsep', 'all', 'webgpu'];
  let lastErr = null, chosen = null, wasm = null;
  for (const id of order) {
    const b = ORT_BUILDS[id];
    try {
      const present = await fetch(base + b.bundle, { method: 'HEAD' }).then((r) => r.ok).catch(() => false)
        || await fetch(base + b.bundle).then((r) => r.ok).catch(() => false); // (HEAD may be unavailable offline; the GET is answered by the service worker cache)
      if (!present) continue;
      const w = await fetchWasm(base, b.wasm);
      if (!w) { lastErr = new Error(`${b.bundle} is present but ${b.wasm} (or its parts .000, .001 …) is missing`); continue; }
      const mod = await import(/* @vite-ignore */ base + b.bundle);
      ort = mod.default && mod.default.InferenceSession ? mod.default : mod;
      chosen = { id, ...b }; wasm = w; state.ortSource = b.bundle;
      break;
    } catch (e) { lastErr = e; ort = null; }
  }
  if (!ort) { const err = new Error('onnxruntime-web was not found in vendor/ort/ (' + (lastErr && lastErr.message) + ')'); err.code = 'ort-missing'; throw err; }
  try {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    state.threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, cores - 1)) : 1;
    ort.env.wasm.numThreads = state.threads;
    ort.env.wasm.proxy = false;
    // The bundle embeds its Emscripten glue; handing it the binary avoids a second fetch and lets us serve parts.
    ort.env.wasm.wasmBinary = wasm.bytes;
    log(`runtime: ${chosen.bundle} + ${chosen.wasm} (${(wasm.bytes.length / 1e6).toFixed(1)} MB${wasm.parts > 1 ? `, stitched from ${wasm.parts} parts` : ''}), ${state.threads} thread(s)`);
  } catch (e) { log('runtime env setup: ' + (e.message || e)); }
  state.ortVersion = (ort.env && ort.env.versions && (ort.env.versions.web || ort.env.versions.common)) || '';
  state.ep = webgpu && chosen.gpu ? 'webgpu' : 'wasm';
  state.build = chosen.id;
  const eps = state.ep === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
  engine = new RvcEngine(ort, { executionProviders: eps, log, onFallback: (ep) => { state.ep = ep; } });
}

async function loadEngineModels(contentvecId, dims, rmvpeId) {
  const cvBytes = await loadModelBytes(contentvecId);
  await engine.loadContentVec(cvBytes, { dims });
  state.engineLoaded = true; loaded.contentvecId = contentvecId; loaded.dims = dims;
  state.rmvpe = false; loaded.rmvpeId = null;
  if (rmvpeId) {
    try { await engine.loadRmvpe(await loadModelBytes(rmvpeId)); state.rmvpe = true; loaded.rmvpeId = rmvpeId; }
    catch (err) { log('RMVPE not loaded: ' + (err.message || err)); }
  }
}

/** First time a voice runs on WebGPU: make sure the generator produces sound (finite, not silent); otherwise rebuild everything on the CPU. */
async function gpuSelfCheck() {
  if (state.ep !== 'webgpu' || state.gpuChecked) return;
  state.gpuChecked = true;
  let bad = null;
  try {
    const r = await engine.testGenerator(0.5);
    if (r.nan > 0 || !(r.peak > 1e-4) || !(r.samples > 0)) bad = `generator output on WebGPU: nan=${r.nan} peak=${r.peak}`;
    else log(`WebGPU self-check passed (${r.ms} ms for 0.5 s)`);
  } catch (e) { bad = e.message || String(e); }
  if (!bad) return;
  log(`WebGPU self-check failed (${bad}); switching to the CPU runtime`);
  engine.eps = ['wasm']; state.ep = 'wasm';
  engine.unloadVoice();
  for (const k of ['cv', 'rmvpe']) { try { engine[k] && engine[k].session.release && engine[k].session.release(); } catch { /* ignore */ } engine[k] = null; }
  state.engineLoaded = false;
  if (loaded.contentvecId) await loadEngineModels(loaded.contentvecId, loaded.dims, loaded.rmvpeId);
  if (loaded.voice) await engine.loadVoice(await loadModelBytes(loaded.voice.id), loaded.voice);
}

self.onmessage = async (e) => {
  const m = e.data;
  const id = m.id;
  try {
    switch (m.cmd) {
      case 'init': {
        await loadOrt(m.prefer || 'auto');
        post({ id, done: true, state: { ...state, installed: await installedModels(), storage: await storageEstimate() } });
        break;
      }
      case 'status':
        post({ id, done: true, state: { ...state, installed: await installedModels(), storage: await storageEstimate() } });
        break;
      case 'install': {
        const ac = new AbortController();
        aborts.set(m.item.id, ac);
        try {
          const r = await installModel(m.item, (loaded, total) => post({ id, progress: total ? loaded / total : 0, loaded, total }), ac.signal, m.baseUrl);
          post({ id, done: true, result: r });
        } finally { aborts.delete(m.item.id); }
        break;
      }
      case 'installFile': {
        const r = await installFromBuffer(m.modelId, m.buffer, m.meta || {});
        post({ id, done: true, result: r });
        break;
      }
      case 'cancel': {
        const ac = aborts.get(m.modelId);
        if (ac) ac.abort();
        post({ id, done: true });
        break;
      }
      case 'remove':
        if (state.voiceId === m.modelId && engine) { engine.unloadVoice(); state.voiceId = null; }
        await removeModel(m.modelId);
        post({ id, done: true });
        break;
      case 'loadEngine': {
        if (!engine) await loadOrt(m.prefer || 'auto');
        await loadEngineModels(m.contentvecId, m.dims || 768, m.rmvpeId);
        post({ id, done: true, state: { ...state } });
        break;
      }
      case 'loadVoice': {
        if (!engine) await loadOrt(m.prefer || 'auto');
        let detected = null;
        if (state.voiceId !== m.voice.id || !engine.voice) {
          engine.unloadVoice(); state.voiceId = null;
          const bytes = await loadModelBytes(m.voice.id); // throws "model … is not installed" when the download has not been done
          await engine.loadVoice(bytes, m.voice);
          state.voiceId = m.voice.id; loaded.voice = m.voice;
          await gpuSelfCheck();
          if (!m.voice.sampleRate && state.engineLoaded) detected = await engine.detectSampleRate();
        }
        post({ id, done: true, state: { ...state }, sampleRate: detected || (engine.voice && engine.voice.meta.sampleRate) });
        break;
      }
      case 'unloadVoice':
        if (engine) engine.unloadVoice();
        state.voiceId = null;
        post({ id, done: true });
        break;
      case 'convert': {
        if (!engine || !state.engineLoaded || !state.voiceId || !engine.voice) throw new Error('AI voice not ready');
        const t0 = Date.now();
        const r = await engine.convert(m.audio, m.rate, { ...m.opts, onProgress: (p, label) => post({ id, progress: p, label }) });
        post({ id, done: true, audio: r.audio, f0Method: r.f0Method, chunks: r.chunks, chunkInfo: r.chunkInfo, ms: Date.now() - t0 }, [r.audio.buffer]);
        break;
      }
      case 'generatorTest': {
        if (!engine || !state.voiceId) throw new Error('voice model not loaded');
        const r = await engine.testGenerator(m.seconds || 2);
        post({ id, done: true, ...r });
        break;
      }
      case 'benchmark': {
        if (!engine || !state.engineLoaded || !state.voiceId) throw new Error('AI voice not ready');
        const sec = m.seconds || 3, rate = 48000;
        const x = new Float32Array(sec * rate);
        for (let i = 0; i < x.length; i++) { const t = i / rate; x[i] = 0.3 * Math.sin(2 * Math.PI * 120 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) + 0.1 * Math.sin(2 * Math.PI * 240 * t); }
        const t0 = Date.now();
        const r = await engine.convert(x, rate, { transpose: 0, f0Method: m.f0Method || 'auto' });
        post({ id, done: true, ms: Date.now() - t0, seconds: sec, f0Method: r.f0Method, realtime: (sec * 1000) / Math.max(1, Date.now() - t0) });
        break;
      }
      default:
        throw new Error('unknown command ' + m.cmd);
    }
  } catch (err) {
    post({ id, error: String(err && err.message || err), code: err && err.code });
  }
};
