// VoxMorph export — containers for WebCodecs output: Ogg (Opus), WebM (Opus), MP4/M4A (AAC).
// Each muxer takes an array of packets { data: Uint8Array, samples: number } and returns a Uint8Array.

export class ByteWriter {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.pos = 0; }
  _ensure(n) { if (this.pos + n > this.buf.length) { let cap = this.buf.length * 2; while (cap < this.pos + n) cap *= 2; const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.pos)); this.buf = nb; } }
  u8(v) { this._ensure(1); this.buf[this.pos++] = v & 255; return this; }
  u16be(v) { this.u8(v >> 8); this.u8(v); return this; }
  u16le(v) { this.u8(v); this.u8(v >> 8); return this; }
  u24be(v) { this.u8(v >> 16); this.u8(v >> 8); this.u8(v); return this; }
  u32be(v) { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v); return this; }
  u32le(v) { this.u8(v); this.u8(v >>> 8); this.u8(v >>> 16); this.u8(v >>> 24); return this; }
  u64be(v) { this.u32be(Math.floor(v / 4294967296)); this.u32be(v >>> 0); return this; }
  u64le(v) { this.u32le(v >>> 0); this.u32le(Math.floor(v / 4294967296)); return this; }
  f64be(v) { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v); this.bytes(new Uint8Array(dv.buffer)); return this; }
  ascii(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
  utf8(s) { return this.bytes(new TextEncoder().encode(s)); }
  bytes(b) { this._ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  result() { return this.buf.slice(0, this.pos); }
}

// ------------------------------------------------------------------------------------------
// Ogg / Opus (RFC 3533 + RFC 7845)
// ------------------------------------------------------------------------------------------

const OGG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();
function oggCrc(bytes) { let c = 0; for (let i = 0; i < bytes.length; i++) c = ((c << 8) >>> 0) ^ OGG_CRC[((c >>> 24) ^ bytes[i]) & 255]; return c >>> 0; }

export function makeOpusHead(channels = 1, preSkip = 312, inputSampleRate = 48000) {
  const w = new ByteWriter(32);
  w.ascii('OpusHead').u8(1).u8(channels).u16le(preSkip).u32le(inputSampleRate).u16le(0).u8(0);
  return w.result();
}
export function parseOpusHead(bytes) {
  if (!bytes || bytes.length < 19) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { channels: bytes[9], preSkip: dv.getUint16(10, true), inputSampleRate: dv.getUint32(12, true) };
}

function oggPage(serial, seq, granule, flags, packets) {
  // packets: array of Uint8Array (each fully contained in this page)
  const segs = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { segs.push(255); n -= 255; }
    segs.push(n);
  }
  const w = new ByteWriter(27 + segs.length + packets.reduce((a, p) => a + p.length, 0));
  w.ascii('OggS').u8(0).u8(flags);
  // granule position, signed 64 little endian
  if (granule < 0) { w.u32le(0xffffffff); w.u32le(0xffffffff); } else w.u64le(granule);
  w.u32le(serial).u32le(seq).u32le(0).u8(segs.length);
  for (const s of segs) w.u8(s);
  for (const p of packets) w.bytes(p);
  const page = w.result();
  const crc = oggCrc(page);
  page[22] = crc & 255; page[23] = (crc >>> 8) & 255; page[24] = (crc >>> 16) & 255; page[25] = (crc >>> 24) & 255;
  return page;
}

/**
 * Mux Opus packets into an Ogg file.
 * @param {Array<{data:Uint8Array, samples:number}>} packets samples = PCM samples per packet at 48 kHz
 * @param {{opusHead?:Uint8Array, preSkip?:number, channels?:number, totalSamples?:number, vendor?:string}} opts
 */
export function muxOggOpus(packets, opts = {}) {
  const channels = opts.channels || 1;
  const head = opts.opusHead || makeOpusHead(channels, opts.preSkip ?? 312, opts.inputSampleRate || 48000);
  const preSkip = parseOpusHead(head).preSkip;
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const out = new ByteWriter(1 << 16);
  let seq = 0;
  out.bytes(oggPage(serial, seq++, 0, 0x02, [head]));
  const tags = new ByteWriter(64);
  const vendor = opts.vendor || 'VoxMorph';
  tags.ascii('OpusTags').u32le(vendor.length).ascii(vendor).u32le(0);
  out.bytes(oggPage(serial, seq++, 0, 0x00, [tags.result()]));
  let granule = preSkip;
  const total = opts.totalSamples != null ? opts.totalSamples + preSkip : null;
  let i = 0;
  while (i < packets.length) {
    // group packets per page (~ up to 50 packets or 60 KB)
    const group = [];
    let bytes = 0, segs = 0;
    while (i < packets.length && group.length < 50 && bytes < 60000) {
      const segCount = Math.floor(packets[i].data.length / 255) + 1;
      if (segs + segCount > 250 && group.length) break;
      group.push(packets[i].data); bytes += packets[i].data.length; granule += packets[i].samples; segs += segCount; i++;
    }
    const last = i >= packets.length;
    let g = granule;
    if (last && total != null && total < granule) g = total;   // trims the encoder padding at the end
    out.bytes(oggPage(serial, seq++, g, last ? 0x04 : 0x00, group));
  }
  return out.result();
}

// ------------------------------------------------------------------------------------------
// WebM (Matroska subset) with one Opus audio track
// ------------------------------------------------------------------------------------------

function ebmlId(w, id) { if (id >= 0x1000000) w.u32be(id); else if (id >= 0x10000) w.u24be(id); else if (id >= 0x100) w.u16be(id); else w.u8(id); }
function ebmlSize(w, n) { // 8-byte size vint for simplicity where large, else compact
  if (n < 0x7f) { w.u8(0x80 | n); }
  else if (n < 0x3fff) { w.u16be(0x4000 | n); }
  else if (n < 0x1fffff) { w.u24be(0x200000 | n); }
  else if (n < 0x0fffffff) { w.u32be(0x10000000 | n); }
  else { w.u8(0x01); w.u8(0); w.u8(0); w.u8(0); w.u32be(n); }
}
function el(id, payload) { const w = new ByteWriter(payload.length + 12); ebmlId(w, id); ebmlSize(w, payload.length); w.bytes(payload); return w.result(); }
function elUint(id, v) { const b = []; let x = v; do { b.unshift(x & 255); x = Math.floor(x / 256); } while (x > 0); return el(id, new Uint8Array(b)); }
function elStr(id, s) { return el(id, new TextEncoder().encode(s)); }
function elFloat(id, v) { const w = new ByteWriter(8); w.f64be(v); return el(id, w.result()); }
function cat(...parts) { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

export function muxWebmOpus(packets, opts = {}) {
  const channels = opts.channels || 1;
  const head = opts.opusHead || makeOpusHead(channels, opts.preSkip ?? 312, 48000);
  const preSkip = parseOpusHead(head).preSkip;
  const sampleRate = 48000;
  const totalSamples = packets.reduce((a, p) => a + p.samples, 0);
  const durationMs = (totalSamples / sampleRate) * 1000;

  const ebmlHeader = el(0x1A45DFA3, cat(
    elUint(0x4286, 1), elUint(0x42F7, 1), elUint(0x42F2, 4), elUint(0x42F3, 8),
    elStr(0x4282, 'webm'), elUint(0x4287, 4), elUint(0x4285, 2)));
  const info = el(0x1549A966, cat(
    elUint(0x2AD7B1, 1000000), elFloat(0x4489, durationMs), elStr(0x4D80, 'VoxMorph'), elStr(0x5741, 'VoxMorph')));
  const audio = el(0xE1, cat(elFloat(0xB5, sampleRate), elUint(0x9F, channels)));
  const track = el(0xAE, cat(
    elUint(0xD7, 1), elUint(0x73C5, 1), elUint(0x83, 2), elStr(0x86, 'A_OPUS'),
    elUint(0x56AA, Math.round(preSkip / sampleRate * 1e9)), elUint(0x56BB, 80000000),
    el(0x63A2, head), audio));
  const tracks = el(0x1654AE6B, track);

  // Clusters of ~ 5 seconds
  const clusters = [];
  let clusterStartMs = 0, blocks = [], tSamples = 0;
  const flushCluster = () => {
    if (!blocks.length) return;
    clusters.push(el(0x1F43B675, cat(elUint(0xE7, Math.round(clusterStartMs)), ...blocks)));
    blocks = [];
  };
  for (const p of packets) {
    const tMs = (tSamples / sampleRate) * 1000;
    if (tMs - clusterStartMs > 5000) { flushCluster(); clusterStartMs = tMs; }
    const rel = Math.round(tMs - clusterStartMs);
    const w = new ByteWriter(p.data.length + 4);
    w.u8(0x81); w.u16be(rel & 0xffff); w.u8(0x80); w.bytes(p.data);
    blocks.push(el(0xA3, w.result()));
    tSamples += p.samples;
  }
  flushCluster();
  const segment = el(0x18538067, cat(info, tracks, ...clusters));
  return cat(ebmlHeader, segment);
}

// ------------------------------------------------------------------------------------------
// MP4 / M4A with one AAC-LC track
// ------------------------------------------------------------------------------------------

function box(type, ...payloads) {
  const n = payloads.reduce((a, p) => a + p.length, 0);
  const w = new ByteWriter(8 + n);
  w.u32be(8 + n).ascii(type);
  for (const p of payloads) w.bytes(p);
  return w.result();
}
function fullBox(type, version, flags, payload) {
  const w = new ByteWriter(4 + payload.length);
  w.u8(version).u24be(flags).bytes(payload);
  return box(type, w.result());
}

/** Build an AudioSpecificConfig for AAC-LC. */
export function makeAacConfig(sampleRate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let idx = rates.indexOf(sampleRate);
  if (idx < 0) idx = 3;
  const v = (2 << 11) | (idx << 7) | (channels << 3);   // audioObjectType=2 (LC), freq index, channel config
  return new Uint8Array([(v >> 8) & 255, v & 255]);
}

/**
 * Mux raw AAC frames into an M4A file.
 * @param {Array<{data:Uint8Array, samples:number}>} packets  samples per frame (1024 for AAC-LC)
 * @param {{sampleRate:number, channels:number, config?:Uint8Array, bitrate?:number}} opts
 */
export function muxM4aAac(packets, opts) {
  const sampleRate = opts.sampleRate, channels = opts.channels || 1;
  const config = opts.config || makeAacConfig(sampleRate, channels);
  const bitrate = opts.bitrate || 128000;
  const totalSamples = packets.reduce((a, p) => a + p.samples, 0);
  const mdatPayload = cat(...packets.map((p) => p.data));

  const ftyp = box('ftyp', new ByteWriter(24).ascii('M4A ').u32be(0).ascii('M4A ').ascii('mp42').ascii('isom').result());
  const now = Math.floor(Date.now() / 1000) + 2082844800;
  const mvhd = fullBox('mvhd', 0, 0, new ByteWriter(96)
    .u32be(now).u32be(now).u32be(sampleRate).u32be(totalSamples)
    .u32be(0x00010000).u16be(0x0100).u16be(0).u32be(0).u32be(0)
    .u32be(0x00010000).u32be(0).u32be(0).u32be(0).u32be(0x00010000).u32be(0).u32be(0).u32be(0).u32be(0x40000000)
    .u32be(0).u32be(0).u32be(0).u32be(0).u32be(0).u32be(0).u32be(2).result());
  const tkhd = fullBox('tkhd', 0, 7, new ByteWriter(80)
    .u32be(now).u32be(now).u32be(1).u32be(0).u32be(totalSamples)
    .u32be(0).u32be(0).u16be(0).u16be(0).u16be(0x0100).u16be(0)
    .u32be(0x00010000).u32be(0).u32be(0).u32be(0).u32be(0x00010000).u32be(0).u32be(0).u32be(0).u32be(0x40000000)
    .u32be(0).u32be(0).result());
  const mdhd = fullBox('mdhd', 0, 0, new ByteWriter(20).u32be(now).u32be(now).u32be(sampleRate).u32be(totalSamples).u16be(0x55c4).u16be(0).result());
  const hdlr = fullBox('hdlr', 0, 0, new ByteWriter(32).u32be(0).ascii('soun').u32be(0).u32be(0).u32be(0).ascii('SoundHandler').u8(0).result());
  const smhd = fullBox('smhd', 0, 0, new ByteWriter(4).u16be(0).u16be(0).result());
  const dref = fullBox('dref', 0, 0, cat(new ByteWriter(4).u32be(1).result(), fullBox('url ', 0, 1, new Uint8Array(0))));
  const dinf = box('dinf', dref);
  // esds
  const dsi = config;
  const decConfig = cat(new Uint8Array([0x04, 13 + 2 + dsi.length, 0x40, 0x15, 0, 0, 0]), new ByteWriter(8).u32be(bitrate).u32be(bitrate).result(), new Uint8Array([0x05, dsi.length]), dsi);
  const esDescr = cat(new Uint8Array([0x03, 3 + decConfig.length + 3, 0, 1, 0]), decConfig, new Uint8Array([0x06, 0x01, 0x02]));
  const esds = fullBox('esds', 0, 0, esDescr);
  const mp4a = box('mp4a', new ByteWriter(28)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u16be(1)        // reserved, data_reference_index
    .u32be(0).u32be(0)                                    // reserved
    .u16be(channels).u16be(16).u16be(0).u16be(0)          // channels, sample size, pre-defined, reserved
    .u32be(sampleRate << 16).result(), esds);
  const stsd = fullBox('stsd', 0, 0, cat(new ByteWriter(4).u32be(1).result(), mp4a));
  // stts: group runs of equal durations
  const runs = [];
  for (const p of packets) { const last = runs[runs.length - 1]; if (last && last.d === p.samples) last.n++; else runs.push({ n: 1, d: p.samples }); }
  const sttsW = new ByteWriter(8 + runs.length * 8); sttsW.u32be(runs.length); for (const r of runs) sttsW.u32be(r.n).u32be(r.d);
  const stts = fullBox('stts', 0, 0, sttsW.result());
  const stsc = fullBox('stsc', 0, 0, new ByteWriter(16).u32be(1).u32be(1).u32be(packets.length).u32be(1).result());
  const stszW = new ByteWriter(8 + packets.length * 4); stszW.u32be(0).u32be(packets.length); for (const p of packets) stszW.u32be(p.data.length);
  const stsz = fullBox('stsz', 0, 0, stszW.result());
  // stco needs the mdat data offset: compute sizes first with a placeholder
  const buildMoov = (chunkOffset) => {
    const stco = fullBox('stco', 0, 0, new ByteWriter(8).u32be(1).u32be(chunkOffset).result());
    const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
    const minf = box('minf', smhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);
    return box('moov', mvhd, trak);
  };
  const moovSize = buildMoov(0).length;
  const chunkOffset = ftyp.length + moovSize + 8;
  const moov = buildMoov(chunkOffset);
  const mdat = box('mdat', mdatPayload);
  return cat(ftyp, moov, mdat);
}
