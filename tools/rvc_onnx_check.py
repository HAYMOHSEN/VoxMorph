#!/usr/bin/env python
"""Reference run of the VoxMorph AI pipeline with Python onnxruntime (no torch needed).

    python rvc_onnx_check.py --contentvec vec-768-layer-12.onnx --voice female-p231.onnx \
        --input my_voice.wav --out converted.wav [--rmvpe rmvpe.onnx] [--transpose 0] [--threads 4]

Mirrors js/ai/rvc.js step by step (16 kHz conditioning, ContentVec, RMVPE log-mel + decoder or a
YIN fallback, coarse pitch, noise × 0.66666, generator) so browser and Python results can be compared.
"""
import argparse
import math
import time

import numpy as np
import onnxruntime as ort
from scipy.io import wavfile
from scipy.signal import resample_poly, butter, sosfilt


def read_audio(path):
    sr, d = wavfile.read(path)
    if d.dtype.kind == "f":
        x = d.astype(np.float32)
    else:
        x = d.astype(np.float32) / (np.iinfo(d.dtype).max + 1.0)
    if x.ndim > 1:
        x = x.mean(axis=1)
    return sr, x


def to_rate(x, sr, target):
    if sr == target:
        return x
    g = math.gcd(sr, target)
    return resample_poly(x, target // g, sr // g).astype(np.float32)


def prepare16k(x16):
    sos = butter(2, 48, "highpass", fs=16000, output="sos")
    y = sosfilt(sos, x16).astype(np.float32)
    rms = float(np.sqrt(np.mean(y * y))); peak = float(np.max(np.abs(y)))
    if rms > 1e-7 and peak > 0:
        y *= min(10 ** (-23 / 20) / rms, 10.0, 0.98 / peak)
    return y


def mel_bank():
    fft_freqs = np.linspace(0, 8000, 513)
    edges = np.linspace(2595 * np.log10(1 + 30 / 700), 2595 * np.log10(1 + 8000 / 700), 130)
    f = 700 * (10 ** (edges / 2595) - 1)
    slopes = f[:, None] - fft_freqs[None, :]
    bank = np.maximum(0, np.minimum(-slopes[:-2] / np.diff(f)[:-1, None], slopes[2:] / np.diff(f)[1:, None]))
    bank *= (2 / (f[2:] - f[:-2]))[:, None]
    return bank.astype(np.float32)


def log_mel(x16, bank):
    n_fft, hop = 1024, 160
    pad = n_fft // 2
    xp = np.pad(x16, (pad, pad), mode="reflect")
    frames = 1 + len(x16) // hop
    win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n_fft) / n_fft)
    spec = np.stack([np.abs(np.fft.rfft(xp[t * hop:t * hop + n_fft] * win)) for t in range(frames)], axis=1)
    return np.log(np.maximum(bank @ spec, 1e-5)).astype(np.float32)


def rmvpe_decode(hidden, thred=0.03):
    sal = hidden[0]
    centers = np.argmax(sal, axis=1) + 4
    padded = np.pad(sal, ((0, 0), (4, 4)))
    cents = np.pad(20 * np.arange(360) + 1997.3794084376191, (4, 4))
    idx = centers[:, None] + np.arange(-4, 5)[None]
    local = padded[np.arange(len(sal))[:, None], idx]
    avg = (local * cents[idx]).sum(1) / np.maximum(local.sum(1), 1e-12)
    f0 = 10 * 2 ** (avg / 1200)
    f0[sal.max(1) <= thred] = 0
    return f0.astype(np.float32)


def yin_f0(x16, frames, sr=16000, hop=160, w=1024, fmin=50, fmax=1000):
    tau_min, tau_max = int(sr / fmax), int(sr / fmin)
    x = np.pad(x16, (w // 2, w + tau_max))
    out = np.zeros(frames, np.float32)
    for i in range(frames):
        s = i * hop
        seg = x[s:s + w + tau_max]
        if np.sqrt(np.mean(seg[:w] ** 2)) < 0.003:
            continue
        d = np.array([np.sum((seg[:w] - seg[t:t + w]) ** 2) for t in range(tau_max + 1)])
        cm = np.ones_like(d); run = np.cumsum(d[1:]); cm[1:] = d[1:] * np.arange(1, tau_max + 1) / np.maximum(run, 1e-12)
        cand = np.where(cm[tau_min:] < 0.15)[0]
        tau = tau_min + cand[0] if len(cand) else tau_min + int(np.argmin(cm[tau_min:]))
        if cm[tau] < 0.35:
            out[i] = sr / tau
    return out


def coarse(f0):
    mn, mx = 1127 * np.log1p(50 / 700), 1127 * np.log1p(1100 / 700)
    mel = 1127 * np.log1p(np.maximum(f0, 0) / 700)
    v = f0 > 0
    mel[v] = (mel[v] - mn) * 254 / (mx - mn) + 1
    mel[~v] = 1
    return np.rint(np.clip(mel, 1, 255)).astype(np.int64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contentvec", required=True)
    ap.add_argument("--voice", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rmvpe")
    ap.add_argument("--transpose", type=float, default=0)
    ap.add_argument("--rate", type=int, default=40000, help="voice model output rate")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    so = ort.SessionOptions(); so.intra_op_num_threads = a.threads
    prov = ["CPUExecutionProvider"]
    sr, x = read_audio(a.input)
    x16 = prepare16k(to_rate(x, sr, 16000))
    t0 = time.time()
    cv = ort.InferenceSession(a.contentvec, so, providers=prov)
    inp = cv.get_inputs()[0]
    feed = x16[None, None] if len(inp.shape) == 3 else x16[None]
    emb = cv.run(None, {inp.name: feed})[0]
    if emb.ndim == 3 and emb.shape[1] == 768 and emb.shape[2] != 768:
        emb = emb.transpose(0, 2, 1)
    feats = np.repeat(emb, 2, axis=1).astype(np.float32)
    T = feats.shape[1]
    t1 = time.time()
    method = "yin"
    if a.rmvpe:
        rm = ort.InferenceSession(a.rmvpe, so, providers=prov)
        mel = log_mel(x16, mel_bank())
        n = mel.shape[1]
        padded = np.pad(mel[None], ((0, 0), (0, 0), (0, (-n) % 32)), mode="reflect")
        hidden = rm.run(None, {rm.get_inputs()[0].name: padded})[0][:, :n]
        f0 = rmvpe_decode(hidden)
        method = "rmvpe"
    else:
        f0 = yin_f0(x16, T)
    # align f0 to T frames (linear interpolation over the same span, as in the browser engine)
    f0 = np.interp(np.linspace(0, len(f0) - 1, T), np.arange(len(f0)), f0).astype(np.float32)
    f0[f0 < 20] = 0
    t2 = time.time()
    shifted = f0 * 2 ** (a.transpose / 12)
    net = ort.InferenceSession(a.voice, so, providers=prov)
    rng = np.random.default_rng(a.seed)
    feeds = {"phone": feats, "phone_lengths": np.array([T], np.int64), "pitch": coarse(shifted)[None], "pitchf": shifted[None],
             "ds": np.array([0], np.int64), "rnd": (rng.standard_normal((1, 192, T)) * 0.66666).astype(np.float32)}
    out = net.run(None, feeds)[0].reshape(-1)
    t3 = time.time()
    y48 = to_rate(out, a.rate, 48000)
    peak = float(np.max(np.abs(y48))) or 1.0
    wavfile.write(a.out, 48000, (np.clip(y48 / max(peak, 1e-9) * 0.89, -1, 1) * 32767).astype(np.int16))
    voiced = f0[f0 > 0]
    print(f"frames={T} f0={method} voiced={len(voiced)/max(1,T):.0%} median_f0={np.median(voiced) if len(voiced) else 0:.1f} Hz → shifted {np.median(voiced)*2**(a.transpose/12) if len(voiced) else 0:.1f} Hz")
    print(f"timing: contentvec {t1-t0:.1f}s, f0 {t2-t1:.1f}s, generator {t3-t2:.1f}s for {len(x16)/16000:.1f}s audio ({(len(x16)/16000)/(t3-t0):.2f}x realtime on {a.threads} threads)")
    print(f"wrote {a.out} ({len(y48)/48000:.2f}s, 48 kHz)")


if __name__ == "__main__":
    main()
