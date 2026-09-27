"""Measure formant ratios (LPC) and pitch of rendered outputs vs. inputs; draw spectrograms."""
import os, sys, json
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly, lfilter, freqz
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
OUT = os.path.join(HERE, 'out')

VOWEL_DUR, FRIC_DUR, PAD = 0.45, 0.12, 0.15
SEQ = ['a', 'i', 'u', 'e', 'o', 'a']


def segments():
    t = PAD
    segs = []
    for i, v in enumerate(SEQ):
        segs.append((v, t + 0.08, t + VOWEL_DUR - 0.08))
        t += VOWEL_DUR
        if i == 2:
            t += FRIC_DUR
    return segs


def load(path):
    fs, x = wavfile.read(path)
    if x.dtype == np.int16:
        x = x / 32768.0
    if x.ndim > 1:
        x = x.mean(axis=1)
    return fs, x.astype(np.float64)


def lpc(x, order):
    # autocorrelation method (Levinson-Durbin)
    n = len(x)
    r = np.correlate(x, x, 'full')[n - 1:n + order]
    a = np.zeros(order + 1); a[0] = 1.0
    e = r[0]
    if e <= 0:
        return a
    for i in range(1, order + 1):
        acc = r[i] + np.dot(a[1:i], r[i - 1:0:-1])
        k = -acc / e
        a_new = a.copy()
        a_new[1:i] = a[1:i] + k * a[i - 1:0:-1]
        a_new[i] = k
        a = a_new
        e *= (1 - k * k)
        if e <= 1e-12:
            break
    return a


def formants(fs, x, t0, t1, nf=3):
    fs2 = 12000
    y = resample_poly(x, fs2, fs) if fs != fs2 else x
    seg = y[int(t0 * fs2):int(t1 * fs2)]
    seg = lfilter([1, -0.97], [1], seg) * np.hamming(len(seg))
    a = lpc(seg, 16)
    w, h = freqz([1], a, worN=4096, fs=fs2)
    mag = 20 * np.log10(np.abs(h) + 1e-9)
    peaks = [i for i in range(1, len(mag) - 1) if mag[i] > mag[i - 1] and mag[i] >= mag[i + 1] and 150 < w[i] < 5000]
    peaks = sorted(peaks, key=lambda i: w[i])
    return [float(w[i]) for i in peaks[:nf]]


def pitch(fs, x, t0, t1):
    seg = x[int(t0 * fs):int(t1 * fs)]
    seg = seg - seg.mean()
    ac = np.correlate(seg, seg, 'full')[len(seg) - 1:]
    lo, hi = int(fs / 600), int(fs / 60)
    i = lo + int(np.argmax(ac[lo:hi]))
    return fs / i


def spectrogram(fs, x, title, path):
    plt.figure(figsize=(10, 3.2))
    plt.specgram(x, NFFT=1024, Fs=fs, noverlap=768, cmap='magma', vmin=-120, vmax=-20)
    plt.ylim(0, 6000); plt.title(title); plt.xlabel('s'); plt.ylabel('Hz')
    plt.tight_layout(); plt.savefig(path, dpi=90); plt.close()


def main():
    report = {}
    for base in ['male', 'female']:
        fs, xin = load(os.path.join(DATA, base + '.wav'))
        spectrogram(fs, xin, base + ' input', os.path.join(OUT, f'{base}_input.png'))
        ref = {v: formants(fs, xin, t0, t1) for v, t0, t1 in segments()}
        for name in sorted(os.listdir(OUT)):
            if not name.startswith(base + '_') or not name.endswith('.wav'):
                continue
            fs2, y = load(os.path.join(OUT, name))
            ratios = {1: [], 2: [], 3: []}
            f0r = []
            for v, t0, t1 in segments():
                fo = formants(fs2, y, t0, t1)
                fi = ref[v]
                for k in range(min(3, len(fo), len(fi))):
                    ratios[k + 1].append(fo[k] / fi[k])
                f0r.append(pitch(fs2, y, t0, t1) / pitch(fs, xin, t0, t1))
            summary = {f'F{k}': round(float(np.median(r)), 3) for k, r in ratios.items() if r}
            summary['f0'] = round(float(np.median(f0r)), 3)
            report[name] = summary
            print(f'{name:36s} ' + ' '.join(f'{k}={v}' for k, v in summary.items()))
            if 'ctrl' in name or name.endswith('child.wav') or name.endswith('broadcaster.wav'):
                spectrogram(fs2, y, name, os.path.join(OUT, name.replace('.wav', '.png')))
    json.dump(report, open(os.path.join(OUT, 'analysis.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
