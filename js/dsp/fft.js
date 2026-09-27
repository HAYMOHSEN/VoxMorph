// VoxMorph DSP — radix-2 complex FFT (in-place) with precomputed tables.
// Works in the main thread, Web Workers, AudioWorklets and Node (pure ES module).

export class FFT {
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cosT = new Float64Array(n / 2);
    this.sinT = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      const a = (2 * Math.PI * i) / n;
      this.cosT[i] = Math.cos(a);
      this.sinT[i] = Math.sin(a);
    }
    const bits = Math.log2(n) | 0;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
  }

  // Forward transform, in place. re/im: Float64Array or Float32Array of length n.
  forward(re, im) { this._transform(re, im, false); }
  // Inverse transform, in place, scaled by 1/n.
  inverse(re, im) { this._transform(re, im, true); }

  _transform(re, im, inverse) {
    const n = this.n, rev = this.rev, cosT = this.cosT, sinT = this.sinT;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        let k = 0;
        for (let j = i; j < i + half; j++) {
          const c = cosT[k], s = sign * sinT[k];
          const l = j + half;
          const tr = re[l] * c - im[l] * s;
          const ti = re[l] * s + im[l] * c;
          re[l] = re[j] - tr; im[l] = im[j] - ti;
          re[j] += tr; im[j] += ti;
          k += step;
        }
      }
    }
    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
    }
  }
}

// Periodic Hann window (sums to a constant when overlap-added at hop n/2, n/4, ...)
export function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// Growable FIFO of samples with absolute indexing (index of the first sample ever written is 0).
export class SampleFifo {
  constructor(initial = 1 << 15) {
    this.buf = new Float32Array(initial);
    this.base = 0;      // absolute index of buf[0]
    this.length = 0;    // valid samples in buf
  }
  get end() { return this.base + this.length; }   // absolute index one past the last sample
  write(chunk) {
    const need = this.length + chunk.length;
    if (need > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < need) cap *= 2;
      const nb = new Float32Array(cap);
      nb.set(this.buf.subarray(0, this.length));
      this.buf = nb;
    }
    this.buf.set(chunk, this.length);
    this.length += chunk.length;
  }
  writeZeros(n) {
    const z = new Float32Array(n);
    this.write(z);
  }
  // Drop everything before absolute index `abs` (keeps memory bounded).
  discardBefore(abs) {
    const drop = abs - this.base;
    if (drop <= 0) return;
    if (drop >= this.length) { this.base += this.length; this.length = 0; return; }
    this.buf.copyWithin(0, drop, this.length);
    this.length -= drop;
    this.base += drop;
  }
  // Absolute read (returns 0 outside the valid range).
  at(abs) {
    const i = abs - this.base;
    return i >= 0 && i < this.length ? this.buf[i] : 0;
  }
  // Direct offset for hot loops: buf[abs - base]
}
