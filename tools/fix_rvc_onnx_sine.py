#!/usr/bin/env python
"""Make the NSF sine source of an exported RVC ONNX voice numerically stable in float32.

Why: RVC's SineGen computes the excitation phase as a float32 cumulative sum over the *whole* clip. ONNX
Runtime (CPU, WebAssembly, WebGPU) accumulates in float32, and the wrap-around bookkeeping is derived from a
linearly resized copy of that running sum. After an unvoiced stretch of ~1 s (f0 = 0) the resized phase is
constant, float32 rounding noise triggers spurious wrap corrections, the accumulator drifts to thousands of
cycles and every later increment is rounded — the generated pitch then sits a fixed −5 % / +5.6 % / −15.6 %
off the requested f0 for the rest of the clip. PyTorch never shows this because its CPU cumsum accumulates in
double, so the problem only appears after export.

Fix: replace the sample-rate cumulative sum with an exact, bounded formulation:
    start[t]   = frac( upp · Σ_{k<t} rad[k] )          (frame-rate exclusive cumsum, kept below one cycle)
    phase[t,j] = start[t] + rad[t] · j,  j = 0 … upp−1  (ramp inside the frame; rad = f0 / sample_rate)
    sine       = sin(2π · phase)                          reshaped to [1, T·upp, 1]
which is what SineGen computes mathematically, without ever accumulating more than ~2 cycles in float32.
Every other node (uv mask, noise, decoder) is untouched. Only the standard ops CumSum, Mul, Floor, Sub, Add,
Reshape and Sin are used, so the model still runs on every onnxruntime backend.

    python fix_rvc_onnx_sine.py voice.onnx voice-fixed.onnx [--check]

--check runs the original and the fixed model in onnxruntime on a 185 Hz track with a 1 s silent gap and
reports the pitch after the gap (the original drifts; the fixed model must stay at 185 Hz).
"""
import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import onnx_lite as ol  # noqa: E402


def find_sine_source(m):
    """Locate the SineGen pieces → (rad_values tensor name [1,T,1], upp, index of the original Sin node)."""
    prod = m.producers()

    def back_through(tensor, kinds, limit=8):
        """follow producer chain while op types are in `kinds`; returns (tensor entering the chain, hops)"""
        hops = 0; t = tensor
        while hops < limit:
            n = prod.get(t)
            if n is None or n.op_type not in kinds:
                return t, hops
            t = n.inputs[0]; hops += 1
        return t, hops

    for si, sin in enumerate(m.nodes):
        if sin.op_type != 'Sin':
            continue
        t, _ = back_through(sin.inputs[0], ('Mul',))           # sin( cumsum · 2 · π )
        cum = prod.get(t)
        if cum is None or cum.op_type != 'CumSum':
            continue
        add = prod.get(cum.inputs[0])                           # cumsum( rad_up + cumsum_shift )
        if add is None or add.op_type != 'Add':
            continue
        rad = None
        for inp in add.inputs:
            src, hops = back_through(inp, ('Transpose', 'Resize'))
            if hops >= 2:                                       # Transpose ← Resize(nearest) ← Transpose ← rad
                rad = src
        if rad is None:
            continue
        upp = None
        for n in m.consumers(rad):                              # cumsum(rad) · upp → Resize(linear)
            if n.op_type != 'CumSum':
                continue
            for c in m.consumers(n.outputs[0]):
                if c.op_type == 'Mul':
                    other = c.inputs[1] if c.inputs[0] == n.outputs[0] else c.inputs[0]
                    cn = prod.get(other)
                    if cn is not None and cn.op_type == 'Constant':
                        upp = float(cn.attrs()['value'].values().reshape(-1)[0])
                    elif m.initializer(other) is not None:
                        upp = float(m.initializer(other).values().reshape(-1)[0])
        if upp is None:
            continue
        return rad, int(round(upp)), si
    raise SystemExit('could not find the RVC sine source (CumSum → Sin chain) in this model')


def fix(model_in, model_out):
    m = ol.Model(model_in)
    if any(n.name.endswith('stable_Sin') for n in m.nodes):
        print('this model already has the stable sine source — nothing to do'); return False
    rad, upp, si = find_sine_source(m)
    sin = m.nodes[si]
    sin_out = sin.outputs[0]
    scope = sin.name.rsplit('/', 1)[0] + '/' if '/' in sin.name else ''
    pfx = scope + 'stable_'
    print(f"sine source found: rad values '{rad}', upp={upp}, Sin node '{sin.name}' (#{si})")
    # constants
    m.initializers.append(ol.make_tensor(pfx + 'upp', np.array(float(upp), np.float32)))
    m.initializers.append(ol.make_tensor(pfx + 'two_pi', np.array(2 * np.pi, np.float32)))
    m.initializers.append(ol.make_tensor(pfx + 'ramp', np.arange(upp, dtype=np.float32).reshape(1, 1, upp)))
    m.initializers.append(ol.make_tensor(pfx + 'axis', np.array(1, np.int32)))
    m.initializers.append(ol.make_tensor(pfx + 'shape', np.array([0, -1, 1], np.int64)))
    new = [
        ol.make_node('CumSum', [rad, pfx + 'axis'], [pfx + 'cum'], pfx + 'CumSum', exclusive=1, reverse=0),   # Σ_{k<t} rad[k]   [1,T,1]
        ol.make_node('Mul', [pfx + 'cum', pfx + 'upp'], [pfx + 'cycles'], pfx + 'Mul_upp'),                    # cycles at frame start
        ol.make_node('Floor', [pfx + 'cycles'], [pfx + 'floor'], pfx + 'Floor'),
        ol.make_node('Sub', [pfx + 'cycles', pfx + 'floor'], [pfx + 'start'], pfx + 'Frac'),                   # frac(cycles) ∈ [0,1)
        ol.make_node('Mul', [rad, pfx + 'ramp'], [pfx + 'ramp_t'], pfx + 'Mul_ramp'),                          # rad[t]·j        [1,T,upp]
        ol.make_node('Add', [pfx + 'start', pfx + 'ramp_t'], [pfx + 'phase'], pfx + 'Add_phase'),              # [1,T,upp]
        ol.make_node('Reshape', [pfx + 'phase', pfx + 'shape'], [pfx + 'phase_flat'], pfx + 'Reshape'),        # [1,T·upp,1]
        ol.make_node('Mul', [pfx + 'phase_flat', pfx + 'two_pi'], [pfx + 'rad_phase'], pfx + 'Mul_2pi'),
        ol.make_node('Sin', [pfx + 'rad_phase'], [sin_out], pfx + 'Sin'),
    ]
    # splice: drop the old Sin, insert the new chain at its position (topological order is preserved:
    # `rad` is produced earlier, the consumers of sin_out come later)
    m.nodes = m.nodes[:si] + new + m.nodes[si + 1:]
    removed = m.prune()
    print(f"inserted {len(new)} nodes, pruned {removed} dead nodes of the old phase accumulator")
    m.save(model_out)
    print(f"wrote {model_out} ({os.path.getsize(model_out)} bytes)")
    return True


def check(model_in, model_out):
    import onnxruntime as ort
    from scipy.signal import resample_poly
    so = ort.SessionOptions(); so.intra_op_num_threads = 2
    rng = np.random.default_rng(0)
    T = 800
    f0 = np.full(T, 185.0, np.float32); f0[100:200] = 0  # 1 s gap at 1–2 s
    mel_min, mel_max = 1127 * np.log1p(50 / 700), 1127 * np.log1p(1100 / 700)
    mel = 1127 * np.log1p(f0 / 700); v = f0 > 0; mel[v] = (mel[v] - mel_min) * 254 / (mel_max - mel_min) + 1; mel[~v] = 1
    feeds = {'phone': (rng.standard_normal((1, T, 768)) * 0.3).astype(np.float32), 'phone_lengths': np.array([T], np.int64),
             'pitch': np.rint(np.clip(mel, 1, 255)).astype(np.int64)[None], 'pitchf': f0[None], 'ds': np.array([0], np.int64),
             'rnd': (rng.standard_normal((1, 192, T)) * 0.66666).astype(np.float32)}

    def acf_pitch(frame, sr=16000):
        frame = frame - frame.mean()
        if np.sqrt(np.mean(frame ** 2)) < 0.005:
            return 0
        n = len(frame); ac = np.correlate(frame, frame, 'full')[n - 1:]; ac /= (ac[0] + 1e-12)
        lo, hi = sr // 500, sr // 70; k = lo + int(np.argmax(ac[lo:hi]))
        return sr / k if ac[k] > 0.3 else 0

    for label, path in (('original', model_in), ('fixed', model_out)):
        s = ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])
        y = s.run(None, feeds)[0].reshape(-1)
        rate = y.size // T * 100
        y16 = resample_poly(y, 16000, rate) if rate != 16000 else y
        secs = []
        for sec in range(T // 100):
            seg = y16[sec * 16000:(sec + 1) * 16000]
            p = [acf_pitch(seg[i:i + 640]) for i in range(0, 16000 - 640, 160)]; vv = [q for q in p if q > 0]
            secs.append(np.median(vv) if vv else 0)
        print(f"{label:9s} output rate {rate} Hz, finite={np.isfinite(y).all()}, pitch per second (185 Hz requested, gap at 1–2 s): " + ' '.join(f"{p:4.0f}" for p in secs))
    print("the fixed model must read ≈185 after the gap; the original drifts (e.g. 176 or 195)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('model_in'); ap.add_argument('model_out'); ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    if not fix(a.model_in, a.model_out):
        return
    if a.check:
        check(a.model_in, a.model_out)


if __name__ == '__main__':
    main()
