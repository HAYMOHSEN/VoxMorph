// VoxMorph DSP — pitch shifting = WSOLA time-stretch followed by resampling.
//   pitch ratio P > 1 raises the voice: stretch by P (same pitch, longer), then read P× faster.
// Both stages are streaming so the same code serves offline rendering and live monitoring.

import { hannPeriodic, SampleFifo } from './fft.js';

export class WSOLA {
  constructor(fs, opts = {}) {
    this.fs = fs;
    const frameMs = opts.frameMs || 30;
    this.L = 2 * Math.round((fs * frameMs / 1000) / 2);   // frame length (even)
    this.Hs = this.L >> 1;                                 // synthesis hop (50% overlap)
    this.tol = Math.round(fs * (opts.toleranceMs || 8) / 1000);
    this.win = hannPeriodic(this.L);
    this.setRatio(opts.ratio || 1);
    this.input = new SampleFifo();
    this.m = 0;                 // synthesis frame index
    this.prevSel = 0;           // input position of the previously selected frame
    this.ola = new Float64Array(this.L + this.Hs);
    this.flushed = false;
    this.inputLength = Infinity;
  }

  setRatio(r) {
    this.ratio = Math.max(0.25, Math.min(4, r));
    this.Ha = this.Hs / this.ratio;
  }

  process(chunk) {
    this.input.write(chunk);
    return this._run();
  }

  flush() {
    if (this.flushed) return new Float32Array(0);
    this.flushed = true;
    this.inputLength = this.input.end;
    this.input.writeZeros(this.L + this.tol + this.Hs + 8);
    return this._run(true);
  }

  _run(final = false) {
    const L = this.L, Hs = this.Hs, tol = this.tol, win = this.win, ola = this.ola;
    const out = [];
    for (;;) {
      const pa = Math.round(this.m * this.Ha);
      if (final && pa >= this.inputLength) break;
      const needEnd = pa + tol + L;
      if (needEnd > this.input.end) break;
      let sel;
      if (this.m === 0) {
        sel = 0;
      } else {
        // Template: the natural continuation of the previous frame (its overlap region)
        const tStart = this.prevSel + Hs;
        if (tStart + Hs > this.input.end) break;
        sel = this._search(pa, tStart);
      }
      // Overlap-add the selected frame
      const buf = this.input.buf, off = sel - this.input.base;
      for (let i = 0; i < L; i++) ola[i] += buf[off + i] * win[i];
      // The first Hs samples of the OLA buffer are final
      const chunk = new Float32Array(Hs);
      for (let i = 0; i < Hs; i++) chunk[i] = ola[i];
      out.push(chunk);
      ola.copyWithin(0, Hs, L + Hs);
      ola.fill(0, L);
      this.prevSel = sel;
      this.m++;
      // Keep memory bounded: nothing before min(prevSel, next nominal - tol) is needed
      const nextPa = Math.round(this.m * this.Ha);
      const keepFrom = Math.min(this.prevSel, nextPa - tol) - 4;
      if (keepFrom - this.input.base > (1 << 14)) this.input.discardBefore(keepFrom);
    }
    let total = 0;
    for (const c of out) total += c.length;
    const res = new Float32Array(total);
    let o = 0;
    for (const c of out) { res.set(c, o); o += c.length; }
    return res;
  }

  // Find the candidate near `pa` most similar to the template (normalised cross-correlation),
  // coarse search with a stride of 4 followed by a fine search around the best coarse hit.
  _search(pa, tStart) {
    const Hs = this.Hs, tol = this.tol, buf = this.input.buf, base = this.input.base;
    const lo = Math.max(this.input.base, pa - tol);
    const hi = Math.min(this.input.end - this.L, pa + tol);
    if (hi <= lo) return Math.max(lo, Math.min(hi, pa));
    const tOff = tStart - base;
    let tEnergy = 0;
    for (let i = 0; i < Hs; i += 4) { const v = buf[tOff + i]; tEnergy += v * v; }
    if (tEnergy < 1e-9) return pa; // silence in the template: nothing to align
    let best = pa, bestScore = -Infinity;
    for (let c = lo; c <= hi; c += 4) {
      const cOff = c - base;
      let dot = 0, e = 0;
      for (let i = 0; i < Hs; i += 4) { const a = buf[tOff + i], b = buf[cOff + i]; dot += a * b; e += b * b; }
      const score = e > 1e-9 ? dot / Math.sqrt(e * tEnergy) : -1;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    // Fine search ±3 with full-resolution correlation
    let tE = 0;
    for (let i = 0; i < Hs; i++) { const v = buf[tOff + i]; tE += v * v; }
    let fineBest = best, fineScore = -Infinity;
    for (let c = Math.max(lo, best - 3); c <= Math.min(hi, best + 3); c++) {
      const cOff = c - base;
      let dot = 0, e = 0;
      for (let i = 0; i < Hs; i++) { const a = buf[tOff + i], b = buf[cOff + i]; dot += a * b; e += b * b; }
      const score = e > 1e-9 ? dot / Math.sqrt(e * tE) : -1;
      if (score > fineScore) { fineScore = score; fineBest = c; }
    }
    return fineBest;
  }
}

// Windowed-sinc (Kaiser) polyphase resampler with a constant ratio.
// ratio = input samples consumed per output sample (ratio > 1 → faster playback → higher pitch).
export class Resampler {
  constructor(ratio = 1, opts = {}) {
    this.taps = opts.taps || 32;            // even
    this.half = this.taps >> 1;
    this.phases = opts.phases || 512;
    this.ratio = ratio;
    this.table = Resampler._buildTable(this.taps, this.phases, opts.beta || 8);
    this.input = new SampleFifo();
    this.pos = 0;                            // absolute fractional read position
    this.flushed = false;
    this.inputLength = Infinity;
  }

  static _buildTable(taps, phases, beta) {
    const half = taps >> 1;
    const I0 = (x) => { // modified Bessel function of the first kind, order 0
      let sum = 1, term = 1, k = 1;
      const y = (x * x) / 4;
      while (term > 1e-12 * sum && k < 200) { term *= y / (k * k); sum += term; k++; }
      return sum;
    };
    const table = new Float32Array((phases + 1) * taps);
    const denom = I0(beta);
    for (let p = 0; p <= phases; p++) {
      const frac = p / phases;
      let sum = 0;
      for (let t = 0; t < taps; t++) {
        const x = (t - half + 1) - frac;      // kernel argument
        const r = x / half;
        let w = 0;
        if (Math.abs(r) < 1) w = I0(beta * Math.sqrt(1 - r * r)) / denom;
        const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const v = s * w;
        table[p * taps + t] = v;
        sum += v;
      }
      // Normalise DC gain to 1 for each phase
      for (let t = 0; t < taps; t++) table[p * taps + t] /= sum;
    }
    return table;
  }

  setRatio(r) { this.ratio = Math.max(0.1, Math.min(8, r)); }

  process(chunk) {
    this.input.write(chunk);
    return this._run();
  }

  flush() {
    if (this.flushed) return new Float32Array(0);
    this.flushed = true;
    this.inputLength = this.input.end;
    this.input.writeZeros(this.taps + 2);
    return this._run(true);
  }

  _run(final = false) {
    const taps = this.taps, half = this.half, phases = this.phases, table = this.table;
    const buf = this.input.buf, base = this.input.base, ratio = this.ratio;
    const avail = this.input.end;
    // number of outputs we can produce: need pos + half + 1 < avail
    const maxPos = avail - half - 2;
    let count = 0;
    if (maxPos > this.pos) count = Math.floor((maxPos - this.pos) / ratio) + 1;
    if (final) {
      const lim = Math.floor((this.inputLength - this.pos) / ratio);
      count = Math.max(0, Math.min(count, lim));
    }
    const out = new Float32Array(Math.max(0, count));
    let pos = this.pos;
    for (let n = 0; n < count; n++) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const pf = frac * phases;
      const p = pf | 0;
      const wf = pf - p;
      const row = p * taps, row2 = row + taps;
      const start = i0 - half + 1 - base;
      let acc = 0;
      for (let t = 0; t < taps; t++) {
        const idx = start + t;
        if (idx >= 0) acc += buf[idx] * (table[row + t] + (table[row2 + t] - table[row + t]) * wf);
      }
      out[n] = acc;
      pos += ratio;
    }
    this.pos = pos;
    const keepFrom = Math.floor(this.pos) - half - 2;
    if (keepFrom - this.input.base > 1 << 14) this.input.discardBefore(keepFrom);
    return out;
  }
}
