// VoxMorph — browser audio engine: decoding, microphone capture, live monitoring, playback,
// and the render worker bridge. Everything runs at a fixed internal rate of 48 kHz.

export const RATE = 48000;

function concatChunks(chunks) {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Float32Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export class RenderWorker {
  constructor(url) { this.url = url; this.worker = null; this.pending = new Map(); this.nextId = 1; }
  _ensure() {
    if (this.worker) return;
    this.worker = new Worker(this.url, { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data, p = this.pending.get(m.id);
      if (!p) return;
      if (m.progress !== undefined && !m.done) { p.onProgress && p.onProgress(m.progress); return; }
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'));
      this.pending.clear();
      this.worker = null;
    };
  }
  /** Cancel everything in flight (terminates the worker). */
  cancelAll() {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }
  get busy() { return this.pending.size > 0; }
  analyze(audio, fs) {
    this._ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (m) => resolve(m.info), reject });
      const copy = audio.slice();
      this.worker.postMessage({ id, cmd: 'analyze', audio: copy, fs }, [copy.buffer]);
    });
  }
  render(audio, fs, settings, voiceInfo, onProgress) {
    this._ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const copy = audio.slice();
      this.worker.postMessage({ id, cmd: 'render', audio: copy, fs, settings, voiceInfo }, [copy.buffer]);
    });
  }
}

export class AudioEngine {
  constructor(opts = {}) {
    this.ctx = null;
    this.workletReady = false;
    this.node = null;
    this.micStream = null;
    this.micSource = null;
    this.monitorGain = null;
    this.recChunks = [];
    this.recording = false;
    this.onLevel = opts.onLevel || (() => {});
    this.onRecordingProgress = opts.onRecordingProgress || (() => {});
    this.recSamples = 0;
    this.player = { source: null, buffer: null, startedAt: 0, offset: 0, playing: false, which: null, onEnded: null };
    this.workletUrl = opts.workletUrl || './js/dsp/live-processor.js';
    this.recEndResolve = null;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE, latencyHint: 'interactive' });
      this.monitorGain = this.ctx.createGain();
      this.monitorGain.gain.value = 1;
      this.monitorGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch { /* ignore */ } }
    if (!this.workletReady) {
      await this.ctx.audioWorklet.addModule(this.workletUrl);
      this.node = new AudioWorkletNode(this.ctx, 'voxmorph-live', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.port.onmessage = (e) => this._onWorkletMessage(e.data);
      this.node.connect(this.monitorGain);
      this.workletReady = true;
    }
    return this.ctx;
  }

  _onWorkletMessage(m) {
    if (m.type === 'level') this.onLevel(m.peak, m.rms);
    else if (m.type === 'rec') {
      this.recChunks.push(m.data);
      this.recSamples += m.data.length;
      this.onRecordingProgress(this.recSamples / RATE);
    } else if (m.type === 'rec-end') {
      if (this.recEndResolve) { this.recEndResolve(); this.recEndResolve = null; }
    }
  }

  async listMicrophones() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audioinput');
    } catch { return []; }
  }

  async openMic(deviceId) {
    await this.ensureContext();
    this.closeMic();
    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 1, sampleRate: RATE,
      },
    };
    this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.micSource.connect(this.node);
    return this.micStream;
  }

  closeMic() {
    if (this.micSource) { try { this.micSource.disconnect(); } catch { /* ignore */ } this.micSource = null; }
    if (this.micStream) { for (const t of this.micStream.getTracks()) t.stop(); this.micStream = null; }
  }

  get micOpen() { return !!this.micStream; }

  startRecording() {
    this.recChunks = [];
    this.recSamples = 0;
    this.recording = true;
    this.node.port.postMessage({ type: 'record', on: true });
  }

  async stopRecording() {
    if (!this.recording) return new Float32Array(0);
    this.recording = false;
    const done = new Promise((resolve) => { this.recEndResolve = resolve; });
    this.node.port.postMessage({ type: 'record', on: false });
    await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
    const audio = concatChunks(this.recChunks);
    this.recChunks = [];
    return audio;
  }

  configureLive(params, voiceInfo) {
    if (this.node) this.node.port.postMessage({ type: 'configure', params, voiceInfo: voiceInfo || null });
  }

  setMonitor(on) {
    if (this.node) this.node.port.postMessage({ type: 'monitor', on: !!on });
  }

  // ---------------- decoding ----------------

  /** Decode any audio/video file to mono Float32Array at 48 kHz. */
  async decodeFile(file, onStatus = () => {}) {
    onStatus('decoding');
    const buf = await file.arrayBuffer();
    try {
      const octx = new OfflineAudioContext(1, 1, RATE);
      const ab = await octx.decodeAudioData(buf.slice(0));
      return this._toMono(ab);
    } catch (e) {
      // Fall back to real-time capture through a media element (handles containers the decoder rejects)
      onStatus('decodingSlow');
      return this._decodeViaMediaElement(file);
    }
  }

  _toMono(ab) {
    const n = ab.length, ch = ab.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i]; }
    if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
    return out;
  }

  async _decodeViaMediaElement(file) {
    await this.ensureContext();
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith('video') ? 'video' : 'audio');
    el.src = url; el.muted = false; el.preload = 'auto';
    el.style.display = 'none';
    document.body.appendChild(el);
    const cleanup = () => { try { el.pause(); } catch { /* ignore */ } el.remove(); URL.revokeObjectURL(url); };
    try {
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('media timeout')), 15000);
        el.onloadedmetadata = () => { clearTimeout(timer); res(); };
        el.onerror = () => { clearTimeout(timer); rej(new Error('media error')); };
      });
      if (!Number.isFinite(el.duration) || el.duration <= 0) throw new Error('unknown duration');
      const src = this.ctx.createMediaElementSource(el);
      const silent = this.ctx.createGain(); silent.gain.value = 0;
      src.connect(this.node);
      src.connect(silent); silent.connect(this.ctx.destination);
      this.recChunks = []; this.recSamples = 0; this.recording = true;
      this.node.port.postMessage({ type: 'record', on: true });
      try {
        await el.play();
        await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('playback timeout')), (el.duration + 8) * 1000);
          el.onended = () => { clearTimeout(timer); res(); };
          el.onerror = () => { clearTimeout(timer); rej(new Error('media error')); };
        });
      } finally {
        src.disconnect(); silent.disconnect();
      }
      const audio = await this.stopRecording();
      return audio;
    } catch (e) {
      if (this.recording) await this.stopRecording();
      throw e;
    } finally {
      cleanup();
    }
  }

  // ---------------- playback ----------------

  async play(samples, which, offsetSec = 0, onEnded = null) {
    await this.ensureContext();
    this.stop();
    const buffer = this.ctx.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const p = this.player;
    p.source = source; p.buffer = buffer; p.offset = Math.max(0, Math.min(offsetSec, buffer.duration)); p.startedAt = this.ctx.currentTime; p.playing = true; p.which = which; p.onEnded = onEnded;
    source.onended = () => { if (p.source === source) { p.playing = false; p.source = null; p.offset = 0; if (p.onEnded) p.onEnded(); } };
    source.start(0, p.offset);
  }

  pause() {
    const p = this.player;
    if (!p.playing) return;
    p.offset = this.position();
    p.onEnded = null;
    try { p.source.stop(); } catch { /* ignore */ }
    p.source = null; p.playing = false;
  }

  stop() {
    const p = this.player;
    p.onEnded = null;
    if (p.source) { try { p.source.stop(); } catch { /* ignore */ } }
    p.source = null; p.playing = false; p.offset = 0;
  }

  position() {
    const p = this.player;
    if (!p.playing || !this.ctx) return p.offset;
    return Math.min(p.buffer.duration, p.offset + (this.ctx.currentTime - p.startedAt));
  }

  get playing() { return this.player.playing; }
}
