// VoxMorph export — PCM helpers, WAV writer and a FLAC encoder (fixed predictors + Rice coding).
// Pure JS, no dependencies; usable in the browser, a Worker or Node.

export function floatToInt(samples, bits) {
  const max = bits === 16 ? 32767 : bits === 24 ? 8388607 : 2147483647;
  const out = bits === 16 ? new Int16Array(samples.length) : new Int32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    out[i] = Math.round(v * max);
  }
  return out;
}

/** Encode mono/stereo float samples as a WAV file (PCM 16/24-bit or 32-bit float). */
export function encodeWav(channels, sampleRate, bits = 16) {
  const nCh = channels.length, n = channels[0].length;
  const bytesPer = bits / 8;
  const dataLen = n * nCh * bytesPer;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, bits === 32 ? 3 : 1, true); dv.setUint16(22, nCh, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nCh * bytesPer, true); dv.setUint16(32, nCh * bytesPer, true); dv.setUint16(34, bits, true);
  str(36, 'data'); dv.setUint32(40, dataLen, true);
  let p = 44;
  const ints = bits === 32 ? null : channels.map((c) => floatToInt(c, bits));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      if (bits === 16) { dv.setInt16(p, ints[c][i], true); }
      else if (bits === 24) { const x = ints[c][i]; dv.setUint8(p, x & 255); dv.setUint8(p + 1, (x >> 8) & 255); dv.setUint8(p + 2, (x >> 16) & 255); }
      else { dv.setFloat32(p, Math.max(-1, Math.min(1, channels[c][i])), true); }
      p += bytesPer;
    }
  }
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------------------------

class BitWriter {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.pos = 0; this.bit = 0; }
  _grow() { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
  write(value, bits) { // unsigned, up to 32 bits
    for (let i = bits - 1; i >= 0; i--) {
      if (this.pos >= this.buf.length) this._grow();
      const b = (value >>> i) & 1;
      if (b) this.buf[this.pos] |= 0x80 >> this.bit;
      this.bit++;
      if (this.bit === 8) { this.bit = 0; this.pos++; }
    }
  }
  writeSigned(value, bits) { this.write(value < 0 ? (value + (1 << bits)) >>> 0 : value, bits); }
  writeUnary(n) { // n zeros then a one
    while (n > 32) { this.write(0, 32); n -= 32; }
    this.write(1, n + 1);
  }
  align() { if (this.bit) { this.bit = 0; this.pos++; } }
  bytes() { this.align(); return this.buf.subarray(0, this.pos); }
}

const CRC8_TABLE = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; t[i] = c; } return t; })();
const CRC16_TABLE = (() => { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; t[i] = c; } return t; })();
function crc8(bytes) { let c = 0; for (let i = 0; i < bytes.length; i++) c = CRC8_TABLE[c ^ bytes[i]]; return c; }
function crc16(bytes) { let c = 0; for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC16_TABLE[((c >> 8) ^ bytes[i]) & 0xff]) & 0xffff; return c; }

function utf8Number(bw, n) { // FLAC "UTF-8 style" coded frame number
  if (n < 0x80) { bw.write(n, 8); return; }
  const bytes = [];
  let mask, lead;
  if (n < 0x800) { lead = 0xC0; mask = 1; } else if (n < 0x10000) { lead = 0xE0; mask = 2; } else if (n < 0x200000) { lead = 0xF0; mask = 3; } else if (n < 0x4000000) { lead = 0xF8; mask = 4; } else { lead = 0xFC; mask = 5; }
  for (let i = 0; i < mask; i++) { bytes.unshift(0x80 | (n & 0x3f)); n >>>= 6; }
  bytes.unshift(lead | n);
  for (const b of bytes) bw.write(b, 8);
}

const SAMPLE_RATE_CODES = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

function riceCost(residual, start, end, k) {
  let bits = 0;
  for (let i = start; i < end; i++) {
    const r = residual[i];
    const u = r >= 0 ? r << 1 : ((-r) << 1) - 1; // zigzag
    bits += (u >>> k) + 1 + k;
  }
  return bits;
}

function encodeResidual(bw, residual, order, blockSize) {
  // Rice partitioning: try partition orders 0..4 and pick the cheapest
  let bestOrder = 0, bestCost = Infinity, bestParams = null;
  for (let po = 0; po <= 4; po++) {
    const parts = 1 << po;
    if (blockSize % parts !== 0) continue;
    const partSize = blockSize / parts;
    if (partSize <= order) continue;
    let cost = 0;
    const params = [];
    for (let p = 0; p < parts; p++) {
      const start = p === 0 ? order : p * partSize;
      const end = (p + 1) * partSize;
      // estimate k from mean magnitude
      let sum = 0;
      for (let i = start; i < end; i++) sum += Math.abs(residual[i]);
      const mean = sum / Math.max(1, end - start);
      let k = mean > 0 ? Math.max(0, Math.min(14, Math.floor(Math.log2(mean + 1)))) : 0;
      let c = riceCost(residual, start, end, k);
      // refine ±1
      for (const kk of [k - 1, k + 1]) {
        if (kk < 0 || kk > 14) continue;
        const cc = riceCost(residual, start, end, kk);
        if (cc < c) { c = cc; k = kk; }
      }
      params.push(k);
      cost += c + 4;
    }
    if (cost < bestCost) { bestCost = cost; bestOrder = po; bestParams = params; }
  }
  bw.write(0, 2);            // residual coding method: Rice with 4-bit parameters
  bw.write(bestOrder, 4);
  const parts = 1 << bestOrder, partSize = blockSize / parts;
  for (let p = 0; p < parts; p++) {
    const k = bestParams[p];
    bw.write(k, 4);
    const start = p === 0 ? order : p * partSize;
    const end = (p + 1) * partSize;
    for (let i = start; i < end; i++) {
      const r = residual[i];
      const u = r >= 0 ? r << 1 : ((-r) << 1) - 1;
      bw.writeUnary(u >>> k);
      if (k) bw.write(u & ((1 << k) - 1), k);
    }
  }
  return bestCost;
}

/**
 * Encode integer PCM (Int16Array/Int32Array per channel) as a FLAC file.
 * @param {Array<Int16Array|Int32Array>} channels 1 or 2 channels (independent coding)
 */
export function encodeFlac(channels, sampleRate, bits = 16, blockSize = 4096) {
  const nCh = channels.length, total = channels[0].length;
  const out = new BitWriter(1 << 18);
  // "fLaC" marker + STREAMINFO (last metadata block)
  for (const c of 'fLaC') out.write(c.charCodeAt(0), 8);
  out.write(0x80, 8);                 // last block flag + type 0
  out.write(34, 24);                  // length
  out.write(blockSize, 16); out.write(blockSize, 16);   // min/max block size
  out.write(0, 24); out.write(0, 24);                   // min/max frame size (unknown)
  out.write(sampleRate, 20); out.write(nCh - 1, 3); out.write(bits - 1, 5);
  out.write(Math.floor(total / 4294967296), 4); out.write(total >>> 0, 32);
  for (let i = 0; i < 16; i++) out.write(0, 8);         // MD5 unset
  out.align();

  const srCode = SAMPLE_RATE_CODES[sampleRate];
  const bpsCode = bits === 16 ? 4 : bits === 24 ? 6 : bits === 8 ? 1 : 0;
  const residual = new Int32Array(blockSize);
  let frameNo = 0;
  for (let start = 0; start < total; start += blockSize, frameNo++) {
    const n = Math.min(blockSize, total - start);
    const fw = new BitWriter(1 << 14);
    fw.write(0xFFF8, 16);           // sync + fixed block size
    // block size code
    let bsCode, bsExtra = -1;
    if (n === blockSize && blockSize === 4096) bsCode = 12;
    else if (n === blockSize && blockSize === 2048) bsCode = 11;
    else if (n === blockSize && blockSize === 1024) bsCode = 10;
    else if (n <= 256) { bsCode = 6; bsExtra = n - 1; }
    else { bsCode = 7; bsExtra = n - 1; }
    fw.write(bsCode, 4);
    fw.write(srCode !== undefined ? srCode : 12, 4);   // 12 → sample rate in kHz follows (8 bit)
    fw.write(nCh - 1, 4);                              // independent channels
    fw.write(bpsCode, 3);
    fw.write(0, 1);
    utf8Number(fw, frameNo);
    if (bsCode === 6) fw.write(bsExtra, 8);
    else if (bsCode === 7) fw.write(bsExtra, 16);
    if (srCode === undefined) fw.write(Math.round(sampleRate / 1000), 8);
    fw.align();
    const hdr = fw.bytes();
    const hw = new BitWriter(1 << 14);
    for (let i = 0; i < hdr.length; i++) hw.write(hdr[i], 8);
    hw.write(crc8(hdr), 8);
    // subframes
    for (let c = 0; c < nCh; c++) {
      const s = channels[c];
      // choose the fixed predictor order (0..4) with the smallest residual energy
      let bestOrder = 0, bestSum = Infinity;
      for (let order = 0; order <= 4; order++) {
        if (n <= order) break;
        let sum = 0;
        for (let i = order; i < n; i++) {
          const x0 = s[start + i];
          let r;
          switch (order) {
            case 0: r = x0; break;
            case 1: r = x0 - s[start + i - 1]; break;
            case 2: r = x0 - 2 * s[start + i - 1] + s[start + i - 2]; break;
            case 3: r = x0 - 3 * s[start + i - 1] + 3 * s[start + i - 2] - s[start + i - 3]; break;
            default: r = x0 - 4 * s[start + i - 1] + 6 * s[start + i - 2] - 4 * s[start + i - 3] + s[start + i - 4];
          }
          sum += Math.abs(r);
        }
        if (sum < bestSum) { bestSum = sum; bestOrder = order; }
      }
      const order = bestOrder;
      hw.write(0, 1);                       // zero bit
      hw.write(0x08 | order, 6);            // FIXED subframe, order
      hw.write(0, 1);                       // no wasted bits
      for (let i = 0; i < order; i++) hw.writeSigned(s[start + i], bits);
      for (let i = order; i < n; i++) {
        const x0 = s[start + i];
        let r;
        switch (order) {
          case 0: r = x0; break;
          case 1: r = x0 - s[start + i - 1]; break;
          case 2: r = x0 - 2 * s[start + i - 1] + s[start + i - 2]; break;
          case 3: r = x0 - 3 * s[start + i - 1] + 3 * s[start + i - 2] - s[start + i - 3]; break;
          default: r = x0 - 4 * s[start + i - 1] + 6 * s[start + i - 2] - 4 * s[start + i - 3] + s[start + i - 4];
        }
        residual[i] = r;
      }
      encodeResidual(hw, residual, order, n);
    }
    hw.align();
    const body = hw.bytes();
    const crc = crc16(body);
    for (let i = 0; i < body.length; i++) out.write(body[i], 8);
    out.write(crc, 16);
    out.align();
  }
  return out.bytes().slice();
}
