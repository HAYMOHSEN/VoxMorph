import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { muxOggOpus, muxWebmOpus, muxM4aAac, makeAacConfig } from '../js/export/mux.js';
import { encodeFlac, encodeWav, floatToInt } from '../js/export/pcm.js';
import { readWav } from './wav.mjs';

// ---- Opus packets from ffmpeg's Ogg output
execSync('ffmpeg -y -loglevel error -i test/data/male.wav -c:a libopus -b:a 64k -frame_duration 20 -vbr on test/out/ref.opus');
const ogg = fs.readFileSync('test/out/ref.opus');
function parseOgg(buf) {
  const packets = []; let pending = []; let off = 0;
  while (off + 27 <= buf.length) {
    if (buf.toString('ascii', off, off + 4) !== 'OggS') throw new Error('bad page at ' + off);
    const nseg = buf[off + 26];
    const segs = buf.subarray(off + 27, off + 27 + nseg);
    let p = off + 27 + nseg;
    for (let i = 0; i < nseg; i++) {
      const len = segs[i];
      pending.push(buf.subarray(p, p + len)); p += len;
      if (len < 255) { packets.push(Buffer.concat(pending)); pending = []; }
    }
    off = p;
  }
  return packets;
}
const pk = parseOgg(ogg);
const head = new Uint8Array(pk[0]); // OpusHead
const audioPackets = pk.slice(2).map((d) => ({ data: new Uint8Array(d), samples: 960 }));
const total = readWav('test/data/male.wav').samples.length;
fs.writeFileSync('test/out/mux.ogg', muxOggOpus(audioPackets, { opusHead: head, totalSamples: total }));
fs.writeFileSync('test/out/mux.webm', muxWebmOpus(audioPackets, { opusHead: head }));
console.log('opus packets', audioPackets.length);

// ---- AAC frames from ffmpeg ADTS output
execSync('ffmpeg -y -loglevel error -i test/data/male.wav -c:a aac -b:a 128k -f adts test/out/ref.aac');
const adts = fs.readFileSync('test/out/ref.aac');
const frames = []; let o = 0; let sr = 0, ch = 0;
while (o + 7 <= adts.length) {
  if (adts[o] !== 0xff || (adts[o + 1] & 0xf0) !== 0xf0) throw new Error('bad adts');
  const prot = adts[o + 1] & 1;
  const srIdx = (adts[o + 2] >> 2) & 0xf; const chan = ((adts[o + 2] & 1) << 2) | (adts[o + 3] >> 6);
  const len = ((adts[o + 3] & 3) << 11) | (adts[o + 4] << 3) | (adts[o + 5] >> 5);
  const hdr = prot ? 7 : 9;
  frames.push({ data: new Uint8Array(adts.subarray(o + hdr, o + len)), samples: 1024 });
  sr = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][srIdx]; ch = chan;
  o += len;
}
fs.writeFileSync('test/out/mux.m4a', muxM4aAac(frames, { sampleRate: sr, channels: ch, config: makeAacConfig(sr, ch), bitrate: 128000 }));
console.log('aac frames', frames.length, sr, ch);

// ---- FLAC + WAV from our encoders
const { rate, samples } = readWav('test/data/male.wav');
const ints = floatToInt(samples, 16);
fs.writeFileSync('test/out/enc.flac', encodeFlac([ints], rate, 16));
fs.writeFileSync('test/out/enc24.flac', encodeFlac([floatToInt(samples, 24)], rate, 24));
fs.writeFileSync('test/out/enc.wav', encodeWav([samples], rate, 16));
fs.writeFileSync('test/out/enc24.wav', encodeWav([samples], rate, 24));
// stereo flac
fs.writeFileSync('test/out/enc_st.flac', encodeFlac([ints, ints], rate, 16));
console.log('flac bytes', fs.statSync('test/out/enc.flac').size, 'wav bytes', fs.statSync('test/out/enc.wav').size);

// ---- verify with ffmpeg/ffprobe
for (const f of ['mux.ogg', 'mux.webm', 'mux.m4a', 'enc.flac', 'enc24.flac', 'enc_st.flac', 'enc.wav', 'enc24.wav']) {
  const probe = execSync(`ffprobe -v error -show_entries stream=codec_name,sample_rate,channels:format=duration -of csv=p=0 test/out/${f}`).toString().trim().replace(/\n/g, ' | ');
  let dec = '';
  try { execSync(`ffmpeg -v error -y -i test/out/${f} -f wav test/out/dec_${f}.wav 2>&1`); dec = 'decoded ok'; } catch (e) { dec = 'DECODE ERROR ' + e.stdout; }
  console.log(f.padEnd(14), probe, '|', dec);
}
// lossless check for flac/wav
for (const f of ['enc.flac', 'enc.wav']) {
  const d = readWav(`test/out/dec_${f}.wav`).samples;
  let maxd = 0; for (let i = 0; i < Math.min(d.length, ints.length); i++) maxd = Math.max(maxd, Math.abs(d[i] * 32768 - ints[i]));
  console.log(f, 'lossless max diff (LSB):', maxd, 'len', d.length, 'vs', ints.length);
}
