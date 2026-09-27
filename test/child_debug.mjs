import { readWav, writeWav } from './wav.mjs';
import { renderOffline, analyzeVoice } from '../js/dsp/pipeline.js';
import { defaultSettings } from '../js/dsp/presets.js';
const { rate, samples } = readWav('test/data/male.wav');
const info = analyzeVoice(samples, rate);
function hfStats(y) { // energy 2.5-6 kHz vs 0-1 kHz during the /i/ vowel (0.68-0.98 s)
  const seg = y.subarray(Math.round(0.68 * rate), Math.round(0.98 * rate));
  const N = 4096; let lo = 0, hi = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  // naive DFT bands via Goertzel-ish accumulation using FFT from our module
  return seg;
}
const variants = {
  full: {},
  nrOff: { nr: { enabled: false, strength: 0 } },
  breathOff: { breath: 0 },
  compOff: { compress: 0 },
  brightOff: { brightness: 0 },
  nrBreathOff: { nr: { enabled: false, strength: 0 }, breath: 0 },
};
for (const [name, extra] of Object.entries(variants)) {
  const s = defaultSettings(); s.preset = 'child'; Object.assign(s, extra);
  const r = renderOffline(samples, rate, s, { voiceInfo: info });
  writeWav(`test/out/dbg_child_${name}.wav`, r.audio, rate);
}
console.log('ok');
