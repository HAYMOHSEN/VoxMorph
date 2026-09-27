// VoxMorph export — format registry, feature detection, encoding and saving (browser only).

import { encodeWav, encodeFlac, floatToInt } from './pcm.js';
import { muxOggOpus, muxWebmOpus, muxM4aAac, makeAacConfig } from './mux.js';
import { Resampler } from '../dsp/timescale.js';
import { Biquad } from '../dsp/effects.js';

export const FORMATS = [
  { id: 'wav',  label: 'WAV',  ext: 'wav',  mime: 'audio/wav',  lossless: true,  bits: [16, 24], rates: [48000, 44100] },
  { id: 'mp3',  label: 'MP3',  ext: 'mp3',  mime: 'audio/mpeg', lossless: false, bitrates: [128, 192, 256, 320], rates: [48000, 44100], requires: 'mp3' },
  { id: 'm4a',  label: 'M4A (AAC)', ext: 'm4a', mime: 'audio/mp4', lossless: false, bitrates: [96, 128, 192, 256], rates: [48000, 44100], requires: 'aac' },
  { id: 'flac', label: 'FLAC', ext: 'flac', mime: 'audio/flac', lossless: true,  bits: [16, 24], rates: [48000, 44100] },
  { id: 'ogg',  label: 'OGG (Opus)', ext: 'ogg', mime: 'audio/ogg', lossless: false, bitrates: [64, 96, 128, 192], rates: [48000], requires: 'opus' },
  { id: 'webm', label: 'WebM (Opus)', ext: 'webm', mime: 'audio/webm', lossless: false, bitrates: [64, 96, 128, 192], rates: [48000], requires: 'opus' },
];

let _support = null;
/** Detect which optional encoders this browser offers. */
export async function detectSupport() {
  if (_support) return _support;
  const s = { wav: true, flac: true, mp3: false, aac: false, opus: false };
  if (typeof globalThis.lamejs !== 'undefined' && globalThis.lamejs.Mp3Encoder) s.mp3 = true;
  if (typeof globalThis.AudioEncoder !== 'undefined') {
    try { s.opus = (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 })).supported; } catch { /* ignore */ }
    try { s.aac = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, bitrate: 128000 })).supported; } catch { /* ignore */ }
  }
  _support = s;
  return s;
}

export function formatAvailable(fmt, support) {
  if (!fmt.requires) return true;
  return !!support[fmt.requires];
}

/** Resample mono float audio with a low-pass guard when going down in rate. */
export function resampleAudio(samples, from, to) {
  if (from === to) return samples;
  let x = samples;
  if (to < from) {
    x = new Float32Array(samples);
    const f = to * 0.45;
    Biquad.lowpass(from, f, 0.54).processInPlace(x);
    Biquad.lowpass(from, f, 1.31).processInPlace(x);
  }
  const rs = new Resampler(from / to);
  const a = rs.process(x), b = rs.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  const want = Math.round(samples.length * to / from);
  return out.length >= want ? out.subarray(0, want) : out;
}

async function encodeWithWebCodecs(samples, sampleRate, config) {
  const chunks = [];
  let description = null;
  const done = new Promise((resolve, reject) => {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !description) {
          const d = meta.decoderConfig.description;
          description = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        const samplesInChunk = Math.round((chunk.duration || 0) * sampleRate / 1e6);
        chunks.push({ data: buf, samples: samplesInChunk, timestamp: chunk.timestamp });
      },
      error: (e) => reject(e),
    });
    (async () => {
      try {
        encoder.configure(config);
        const block = sampleRate; // one second per AudioData
        for (let i = 0; i < samples.length; i += block) {
          const part = samples.slice(i, Math.min(samples.length, i + block));
          const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((i / sampleRate) * 1e6), data: part });
          encoder.encode(ad);
          ad.close();
        }
        await encoder.flush();
        encoder.close();
        resolve();
      } catch (e) { reject(e); }
    })();
  });
  await done;
  // Fill in sample counts when the encoder did not report durations
  for (const c of chunks) if (!c.samples) c.samples = config.codec === 'opus' ? 960 : 1024;
  return { chunks, description };
}

function encodeMp3(samples, sampleRate, kbps) {
  const lame = globalThis.lamejs;
  const enc = new lame.Mp3Encoder(1, sampleRate, kbps);
  const pcm = floatToInt(samples, 16);
  const parts = [];
  const block = 1152;
  for (let i = 0; i < pcm.length; i += block) {
    const out = enc.encodeBuffer(pcm.subarray(i, Math.min(pcm.length, i + block)));
    if (out.length) parts.push(new Uint8Array(out));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return parts;
}

/**
 * Encode mono float audio (at `sourceRate`) into the requested format.
 * @returns {{ blob: Blob, ext: string, mime: string }}
 */
export async function encodeAudio(samples, sourceRate, { format = 'wav', bits = 16, sampleRate = 48000, bitrate = 128 } = {}) {
  const fmt = FORMATS.find((f) => f.id === format) || FORMATS[0];
  let rate = fmt.rates.includes(sampleRate) ? sampleRate : fmt.rates[0];
  const x = resampleAudio(samples, sourceRate, rate);
  let parts;
  switch (fmt.id) {
    case 'wav':
      parts = [encodeWav([x], rate, bits)];
      break;
    case 'flac':
      parts = [encodeFlac([floatToInt(x, bits)], rate, bits)];
      break;
    case 'mp3':
      parts = encodeMp3(x, rate, bitrate);
      break;
    case 'm4a': {
      const { chunks, description } = await encodeWithWebCodecs(x, rate, { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 1, bitrate: bitrate * 1000, aac: { format: 'aac' } });
      parts = [muxM4aAac(chunks, { sampleRate: rate, channels: 1, config: description || makeAacConfig(rate, 1), bitrate: bitrate * 1000 })];
      break;
    }
    case 'ogg':
    case 'webm': {
      let enc;
      try {
        enc = await encodeWithWebCodecs(x, 48000, { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: bitrate * 1000, opus: { format: 'ogg', frameDuration: 20000 } });
      } catch (e) {
        // Chromium rejects the 'ogg' framing option: raw packets + a standard OpusHead (pre-skip 312) work as well
        enc = await encodeWithWebCodecs(x, 48000, { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: bitrate * 1000, opus: { frameDuration: 20000 } });
      }
      const { chunks, description } = enc;
      const head = description && description.length >= 19 && String.fromCharCode(...description.subarray(0, 8)) === 'OpusHead' ? description : null;
      parts = [fmt.id === 'ogg'
        ? muxOggOpus(chunks, { opusHead: head, channels: 1, totalSamples: x.length })
        : muxWebmOpus(chunks, { opusHead: head, channels: 1 })];
      break;
    }
    default:
      throw new Error('unknown format ' + format);
  }
  return { blob: new Blob(parts, { type: fmt.mime }), ext: fmt.ext, mime: fmt.mime };
}

/** Save a blob with the File System Access API when available, otherwise as a download. */
export async function saveBlob(blob, filename, description = 'Audio') {
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const ext = '.' + filename.split('.').pop();
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description, accept: { [blob.type || 'application/octet-stream']: [ext] } }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return { saved: true, name: handle.name, method: 'picker' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { saved: false, cancelled: true };
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  return { saved: true, name: filename, method: 'download' };
}
