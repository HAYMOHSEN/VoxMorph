// Minimal WAV reader/writer for tests (PCM16 / float32, mono or multi-channel → mono)
import fs from 'node:fs';

export function readWav(path) {
  const b = fs.readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
      if (fmt.format === 0xfffe) fmt.format = b.readUInt16LE(body + 24);
    } else if (id === 'data') { data = b.subarray(body, body + size); }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('bad WAV');
  const { channels, bits, format } = fmt;
  const frames = data.length / (channels * bits / 8);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * (bits / 8);
      let v;
      if (format === 3) v = bits === 32 ? data.readFloatLE(p) : data.readDoubleLE(p);
      else if (bits === 16) v = data.readInt16LE(p) / 32768;
      else if (bits === 24) v = ((data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) v = data.readInt32LE(p) / 2147483648;
      else if (bits === 8) v = (data[p] - 128) / 128;
      s += v;
    }
    out[i] = s / channels;
  }
  return { rate: fmt.rate, samples: out };
}

export function writeWav(path, samples, rate, bits = 16) {
  const bytesPer = bits / 8;
  const dataLen = samples.length * bytesPer;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(bits === 32 ? 3 : 1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * bytesPer, 28); b.writeUInt16LE(bytesPer, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  let p = 44;
  for (let i = 0; i < samples.length; i++) {
    let v = Math.max(-1, Math.min(1, samples[i]));
    if (bits === 16) { b.writeInt16LE(Math.round(v * 32767), p); }
    else if (bits === 24) { const x = Math.round(v * 8388607); b[p] = x & 255; b[p + 1] = (x >> 8) & 255; b[p + 2] = (x >> 16) & 255; }
    else if (bits === 32) { b.writeFloatLE(v, p); }
    p += bytesPer;
  }
  fs.writeFileSync(path, b);
}
