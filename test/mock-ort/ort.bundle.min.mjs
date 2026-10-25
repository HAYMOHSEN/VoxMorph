// Mock of onnxruntime-web for tests. "Models" are tiny JSON files describing what to emulate:
//   {"kind":"contentvec","dims":768}  {"kind":"rmvpe"}  {"kind":"rvc","sampleRate":40000}
// The RVC mock synthesises a harmonic tone that follows `pitchf`, so pitch handling can be verified end to end.
export class Tensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; this.size = data.length; }
}
export const env = { wasm: { numThreads: 1, simd: true, proxy: false, wasmPaths: '' }, versions: { web: 'mock-1.0' }, logLevel: 'warning' };

function parseModel(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const text = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 4096)));
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('mock ort: not a mock model file');
  return JSON.parse(m[0]);
}

class MockSession {
  constructor(desc) {
    this.desc = desc;
    if (desc.kind === 'contentvec') { this.inputNames = ['source']; this.outputNames = ['embed']; }
    else if (desc.kind === 'rmvpe') { this.inputNames = ['input']; this.outputNames = ['output']; }
    else if (desc.kind === 'rvc') { this.inputNames = ['phone', 'phone_lengths', 'pitch', 'pitchf', 'ds', 'rnd']; this.outputNames = ['audio']; }
    else throw new Error('mock ort: unknown kind ' + desc.kind);
  }
  async run(feeds) {
    const d = this.desc;
    if (d.kind === 'contentvec') {
      const t = feeds[this.inputNames[0]];
      if (d.rejectRank3 && t.dims.length === 3) throw new Error('mock: rank-3 input not supported');
      const x = t.data, n = x.length, dims = d.dims || 768;
      const frames = Math.floor(n / 320);
      const out = new Float32Array(frames * dims);
      for (let f = 0; f < frames; f++) {
        let e = 0; for (let i = f * 320; i < f * 320 + 320; i++) e += x[i] * x[i];
        const rms = Math.sqrt(e / 320);
        for (let c = 0; c < dims; c++) out[f * dims + c] = rms * (0.5 + 0.5 * Math.sin(c * 0.1)) ;
      }
      return { embed: d.layoutBct ? new Tensor('float32', transpose(out, frames, dims), [1, dims, frames]) : new Tensor('float32', out, [1, frames, dims]) };
    }
    if (d.kind === 'rmvpe') {
      const t = feeds[this.inputNames[0]];
      const [, nMels, frames] = t.dims;
      const out = new Float32Array(frames * 360);
      const hz = d.hz || 150;
      const cents = 1200 * Math.log2(hz / 10);
      const centerBin = (cents - 1997.3794084376191) / 20;
      for (let f = 0; f < frames; f++) {
        let e = 0; for (let m = 0; m < nMels; m++) e += t.data[m * frames + f];
        const meanLog = e / nMels;
        if (meanLog < -9) continue; // silence → no salience
        for (let b = 0; b < 360; b++) out[f * 360 + b] = Math.exp(-0.5 * Math.pow((b - centerBin) / 1.2, 2));
      }
      return { output: new Tensor('float32', out, [1, frames, 360]) };
    }
    // rvc
    const T = Number(feeds.phone_lengths.data[0]);
    const pitchf = feeds.pitchf.data;
    const phone = feeds.phone.data;
    const dims = feeds.phone.dims[2];
    const sr = d.sampleRate || 40000, hop = sr / 100;
    const out = new Float32Array(T * hop);
    let ph = 0;
    for (let f = 0; f < T; f++) {
      let amp = 0; for (let c = 0; c < dims; c++) amp += phone[f * dims + c]; amp = Math.min(0.8, amp / dims * 2.5);
      const f0 = pitchf[f];
      for (let i = 0; i < hop; i++) {
        if (f0 > 0) { ph += 2 * Math.PI * f0 / sr; out[f * hop + i] = amp * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph)); }
        else out[f * hop + i] = 0;
      }
    }
    return { audio: new Tensor('float32', out, [1, 1, out.length]) };
  }
  release() {}
}
function transpose(data, frames, dims) { const t = new Float32Array(data.length); for (let f = 0; f < frames; f++) for (let c = 0; c < dims; c++) t[c * frames + f] = data[f * dims + c]; return t; }

export class InferenceSession {
  static async create(bytes, opts) { return new MockSession(parseModel(bytes)); }
}
export default { Tensor, env, InferenceSession };
