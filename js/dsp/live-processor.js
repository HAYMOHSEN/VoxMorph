// VoxMorph — AudioWorklet processor: captures raw microphone audio for recording and
// (optionally) runs the voice pipeline in real time for live monitoring.
import { VoicePipeline } from './pipeline.js';

class VoxMorphLiveProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pipe = null;
    this.monitor = false;
    this.recording = false;
    this.mono = new Float32Array(128);
    this.fifo = new Float32Array(1 << 16);
    this.fifoMask = this.fifo.length - 1;
    this.fifoW = 0; this.fifoR = 0;
    this.primed = false;
    this.targetLatency = 2048;
    this.recBuf = new Float32Array(4096);
    this.recPos = 0;
    this.meterCount = 0;
    this.meterPeak = 0; this.meterSq = 0; this.meterN = 0;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(m) {
    switch (m.type) {
      case 'configure': {
        const p = new VoicePipeline(sampleRate, 'live');
        p.configure(m.params, m.voiceInfo || null, null);
        this.pipe = p;
        this._resetFifo();
        break;
      }
      case 'monitor':
        this.monitor = !!m.on;
        this._resetFifo();
        break;
      case 'record':
        if (m.on && !this.recording) { this.recording = true; this.recPos = 0; }
        else if (!m.on && this.recording) {
          this.recording = false;
          if (this.recPos > 0) { const d = this.recBuf.slice(0, this.recPos); this.recPos = 0; this.port.postMessage({ type: 'rec', data: d }, [d.buffer]); }
          this.port.postMessage({ type: 'rec-end' });
        }
        break;
      default: break;
    }
  }

  _resetFifo() { this.fifoW = 0; this.fifoR = 0; this.primed = false; }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output && output[0] ? output[0].length : 128;
    const mono = this.mono.length === n ? this.mono : (this.mono = new Float32Array(n));
    if (input && input.length) {
      const ch = input.length;
      const a = input[0];
      if (ch === 1) mono.set(a);
      else { for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += input[c][i]; mono[i] = s / ch; } }
    } else mono.fill(0);

    // level meter (~ every 12 blocks ≈ 32 ms)
    for (let i = 0; i < n; i++) { const v = mono[i]; const a = v < 0 ? -v : v; if (a > this.meterPeak) this.meterPeak = a; this.meterSq += v * v; }
    this.meterN += n;
    if (++this.meterCount >= 12) {
      this.port.postMessage({ type: 'level', peak: this.meterPeak, rms: Math.sqrt(this.meterSq / this.meterN) });
      this.meterCount = 0; this.meterPeak = 0; this.meterSq = 0; this.meterN = 0;
    }

    if (this.recording) {
      if (this.recPos + n > this.recBuf.length) {
        const d = this.recBuf.slice(0, this.recPos);
        this.port.postMessage({ type: 'rec', data: d }, [d.buffer]);
        this.recPos = 0;
      }
      this.recBuf.set(mono, this.recPos);
      this.recPos += n;
    }

    if (output && output.length) {
      if (this.monitor && this.pipe) {
        const y = this.pipe.process(mono);
        for (let i = 0; i < y.length; i++) { this.fifo[this.fifoW & this.fifoMask] = y[i]; this.fifoW++; }
        let level = this.fifoW - this.fifoR;
        if (level > this.fifo.length - 256) { this.fifoR = this.fifoW - this.targetLatency; level = this.targetLatency; }
        if (!this.primed && level >= this.targetLatency) this.primed = true;
        const out0 = output[0];
        if (this.primed && level >= n) {
          for (let i = 0; i < n; i++) { out0[i] = this.fifo[this.fifoR & this.fifoMask]; this.fifoR++; }
        } else out0.fill(0);
        for (let c = 1; c < output.length; c++) output[c].set(out0);
      } else {
        for (let c = 0; c < output.length; c++) output[c].fill(0);
      }
    }
    return true;
  }
}

registerProcessor('voxmorph-live', VoxMorphLiveProcessor);
