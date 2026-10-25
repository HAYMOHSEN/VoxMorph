// VoxMorph AI — main-thread client for the AI worker + model manifest handling.

export class AiClient {
  constructor({ workerUrl = './js/ai/ai-worker.js', manifestUrl = './models/manifest.json', compute = null } = {}) {
    this.workerUrl = workerUrl;
    this.manifestUrl = manifestUrl;
    // 'auto' = WebGPU when the device offers it (CPU fallback), 'cpu' = always the multi-threaded WebAssembly build
    this.compute = compute || (() => { try { return localStorage.getItem('voxmorph.ai.compute') || 'auto'; } catch { return 'auto'; } })();
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.manifest = null;
    this.manifestError = '';
    this.state = { available: false, reason: '', ep: null, threads: 1, installed: [], engineLoaded: false, voiceId: null, rmvpe: false, ortVersion: '', storage: { usage: 0, quota: 0 } };
    this.logs = [];
    this.onLog = null;
    this.onState = null;
    this.initPromise = null;
  }

  _ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'log') { this.logs.push(m.text); if (this.logs.length > 200) this.logs.shift(); this.onLog && this.onLog(m.text); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.progress !== undefined && !m.done) { p.onProgress && p.onProgress(m.progress, m); return; }
      this.pending.delete(m.id);
      if (m.error) { const err = new Error(m.error); err.code = m.code; p.reject(err); } else p.resolve(m);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'AI worker error'));
      this.pending.clear();
    };
  }

  _call(msg, onProgress, transfer) {
    this._ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  _applyState(s) {
    if (!s) return;
    Object.assign(this.state, { ep: s.ep, build: s.build || this.state.build, ortSource: s.ortSource || this.state.ortSource, threads: s.threads, installed: s.installed || this.state.installed, engineLoaded: !!s.engineLoaded, voiceId: s.voiceId ?? this.state.voiceId, rmvpe: !!s.rmvpe, ortVersion: s.ortVersion || this.state.ortVersion, storage: s.storage || this.state.storage });
    this.onState && this.onState(this.state);
  }

  /** Load the manifest and start the runtime. Never throws; see state.available / state.reason. */
  async init(manifestUrl) {
    if (manifestUrl) this.manifestUrl = manifestUrl;
    this.initPromise = (async () => {
      await this.loadManifest();
      try {
        const r = await this._call({ cmd: 'init', prefer: this.compute === 'cpu' ? 'wasm' : 'auto' });
        this.state.available = true; this.state.reason = '';
        this._applyState(r.state);
      } catch (e) {
        this.state.available = false;
        this.state.reason = e.code === 'ort-missing' ? 'ort-missing' : (e.message || 'init-failed');
        this.onState && this.onState(this.state);
      }
      return this.state;
    })();
    return this.initPromise;
  }

  /** Change the compute preference; the worker is restarted so the runtime is reloaded (models stay in storage). */
  async setCompute(mode) {
    this.compute = mode === 'cpu' ? 'cpu' : 'auto';
    try { localStorage.setItem('voxmorph.ai.compute', this.compute); } catch { /* ignore */ }
    this.restartWorker();
    return this.init();
  }

  restartWorker() {
    if (this.worker) { try { this.worker.terminate(); } catch { /* ignore */ } }
    for (const p of this.pending.values()) p.reject(new Error('AI worker restarted'));
    this.pending.clear();
    this.worker = null;
    Object.assign(this.state, { available: false, engineLoaded: false, voiceId: null, rmvpe: false, ep: null });
  }

  async loadManifest() {
    this.manifest = null; this.manifestError = '';
    try {
      const res = await fetch(this.manifestUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = await res.json();
      m.baseUrl = new URL(this.manifestUrl, location.href).href;
      m.voices = Array.isArray(m.voices) ? m.voices : [];
      m.engine = m.engine || {};
      this.manifest = m;
    } catch (e) {
      this.manifestError = e.message || String(e);
    }
    return this.manifest;
  }

  async refresh() { try { const r = await this._call({ cmd: 'status' }); this._applyState(r.state); } catch { /* ignore */ } return this.state; }

  isInstalled(id) { return this.state.installed.some((m) => m.id === id); }

  /** Voices from the manifest plus voices imported from local files. */
  get voices() { return [...(this.manifest ? this.manifest.voices : []), ...this.localVoices]; }
  get localVoices() { try { return JSON.parse(localStorage.getItem('voxmorph.ai.localVoices') || '[]'); } catch { return []; } }
  set localVoices(list) { try { localStorage.setItem('voxmorph.ai.localVoices', JSON.stringify(list)); } catch { /* ignore */ } }
  voiceById(id) { return this.voices.find((v) => v.id === id) || null; }

  /** Put a local ONNX file into the model store (engine or voice). Returns the stored entry. */
  async installFile(file, { id, kind = 'voice', meta = {} } = {}) {
    const modelId = id || `local-${kind}-${file.name.replace(/\.onnx$/i, '').replace(/[^\w.-]+/g, '_')}`;
    const buffer = await file.arrayBuffer();
    const r = await this._call({ cmd: 'installFile', modelId, buffer, meta }, null, [buffer]);
    if (kind === 'voice') {
      const list = this.localVoices.filter((v) => v.id !== modelId);
      list.push(Object.assign({ id: modelId, name: file.name.replace(/\.onnx$/i, ''), category: 'other', local: true, size: r.result.size, version: 2, dims: 768 }, meta));
      this.localVoices = list;
    }
    await this.refresh();
    return { id: modelId, size: r.result.size };
  }
  removeLocalVoice(id) { this.localVoices = this.localVoices.filter((v) => v.id !== id); }

  /** Engine entries: manifest first, otherwise a locally imported ContentVec/RMVPE. */
  get engineItems() {
    const cv = (this.manifest && this.manifest.engine.contentvec) || (this.isInstalled('local-engine-contentvec') ? { id: 'local-engine-contentvec', label: 'ContentVec (local file)', dims: 768, local: true } : null);
    const rm = (this.manifest && this.manifest.engine.rmvpe) || (this.isInstalled('local-engine-rmvpe') ? { id: 'local-engine-rmvpe', label: 'RMVPE (local file)', optional: true, local: true } : null);
    return { contentvec: cv, rmvpe: rm };
  }
  get engineInstalled() { const cv = this.engineItems.contentvec; return !!(cv && this.isInstalled(cv.id)); }
  get rmvpeInstalled() { const rm = this.engineItems.rmvpe; return !!(rm && this.isInstalled(rm.id)); }

  async install(item, onProgress) {
    const r = await this._call({ cmd: 'install', item, baseUrl: this.manifest ? this.manifest.baseUrl : '' }, (p, m) => onProgress && onProgress(p, m.loaded, m.total));
    await this.refresh();
    return r.result;
  }
  async cancelInstall(modelId) { return this._call({ cmd: 'cancel', modelId }); }
  async remove(modelId) { await this._call({ cmd: 'remove', modelId }); if (this.state.voiceId === modelId) this.state.voiceId = null; await this.refresh(); }

  async ensureEngine() {
    const { contentvec: cv, rmvpe: rm } = this.engineItems;
    if (!cv) throw new Error('no engine model available');
    const wantRmvpe = rm && this.isInstalled(rm.id);
    if (this.state.engineLoaded && (!!this.state.rmvpe === !!wantRmvpe)) return;
    const r = await this._call({ cmd: 'loadEngine', contentvecId: cv.id, dims: cv.dims || 768, rmvpeId: wantRmvpe ? rm.id : null });
    this._applyState(r.state);
  }

  async ensureVoice(voice) {
    await this.ensureEngine();
    if (this.state.voiceId === voice.id) return;
    const r = await this._call({ cmd: 'loadVoice', voice: { id: voice.id, sampleRate: voice.sampleRate || 0, version: voice.version || 2, speakerId: voice.speakerId || 0, dims: voice.dims || 768 } });
    this._applyState(r.state);
    if (!voice.sampleRate && r.sampleRate) {
      voice.sampleRate = r.sampleRate;
      if (voice.local) { const list = this.localVoices; const e = list.find((v) => v.id === voice.id); if (e) { e.sampleRate = r.sampleRate; this.localVoices = list; } }
    }
  }

  /**
   * Convert mono audio with the given voice.
   * @returns {{ audio: Float32Array, f0Method: string, chunks: number, ms: number }}
   */
  async convert(voice, audio, rate, opts = {}, onProgress) {
    await this.ensureVoice(voice);
    const copy = audio.slice();
    return this._call({ cmd: 'convert', audio: copy, rate, opts }, (p, m) => onProgress && onProgress(p, m.label), [copy.buffer]);
  }

  async benchmark(voice, seconds = 3) { await this.ensureVoice(voice); return this._call({ cmd: 'benchmark', seconds }); }
  /** Generator-only diagnostic (does not need ContentVec). */
  async generatorTest(voice, seconds = 2) {
    if (!this.state.voiceId || this.state.voiceId !== voice.id) {
      if (!this.state.engineLoaded) { /* load the voice directly */ }
      const r = await this._call({ cmd: 'loadVoice', voice: { id: voice.id, sampleRate: voice.sampleRate || 0, version: voice.version || 2, speakerId: voice.speakerId || 0, dims: voice.dims || 768 } }).catch(async (e) => { throw e; });
      this._applyState(r.state);
    }
    return this._call({ cmd: 'generatorTest', seconds });
  }
}

/** Transpose (semitones) that moves the speaker's measured pitch onto the voice's typical pitch. */
export function autoTranspose(voice, voiceInfo) {
  if (!voice) return 0;
  const f0 = voiceInfo && voiceInfo.f0Median > 0 ? voiceInfo.f0Median : 0;
  if (voice.targetF0 && f0) return Math.max(-24, Math.min(24, Math.round(12 * Math.log2(voice.targetF0 / f0))));
  if (typeof voice.transposeDefault === 'number') return voice.transposeDefault;
  return 0;
}

export function pickText(field, lang) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  return field[lang] || field.en || field.ar || Object.values(field)[0] || '';
}

export function formatBytes(n) {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
