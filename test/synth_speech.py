"""Synthesise speech-like test signals (glottal pulse train through formant resonators).

Produces:
  test/data/male.wav    f0 ~118 Hz, adult-male formants, vowel sequence with a fricative
  test/data/female.wav  f0 ~215 Hz, formants x1.18
  test/data/male_noisy.wav  male + background noise at ~ -35 dBFS
Vowel timing is fixed so the analysis script can measure formants on known segments.
"""
import numpy as np
from scipy.signal import lfilter
from scipy.io import wavfile
import os

FS = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')
os.makedirs(OUT, exist_ok=True)

# vowel formants (adult male) F1, F2, F3 and bandwidths
VOWELS = {
    'a': ([730, 1090, 2440], [60, 90, 130]),
    'i': ([270, 2290, 3010], [50, 90, 130]),
    'u': ([300, 870, 2240], [50, 80, 130]),
    'e': ([530, 1840, 2480], [60, 90, 130]),
    'o': ([570, 840, 2410], [60, 80, 130]),
}
SEQUENCE = ['a', 'i', 'u', 'e', 'o', 'a']   # 0.45 s each, with 0.12 s fricative between 3rd and 4th
VOWEL_DUR = 0.45
FRIC_DUR = 0.12


def rosenberg_pulse_train(f0_track, fs):
    """Rosenberg-like glottal flow derivative pulse train following an f0 track (per-sample)."""
    n = len(f0_track)
    out = np.zeros(n)
    phase = 0.0
    for i in range(n):
        phase += f0_track[i] / fs
        if phase >= 1.0:
            phase -= 1.0
        # glottal flow derivative approximation: -sin ramp shape within the open phase (60% of period)
        t = phase
        T1, T2 = 0.42, 0.16   # opening and closing phases (fraction of the period)
        if t < T1:
            out[i] = 0.5 * (1 - np.cos(np.pi * t / T1))
        elif t < T1 + T2:
            out[i] = np.cos(np.pi * (t - T1) / (2 * T2))
        else:
            out[i] = 0.0
    # differentiate to get the radiation-like spectrum tilt
    out = np.diff(out, prepend=0.0)
    return out


def resonator(x, f, bw, fs):
    # Klatt-style second-order resonator with unity gain at DC
    r = np.exp(-np.pi * bw / fs)
    theta = 2 * np.pi * f / fs
    B = 2 * r * np.cos(theta)
    C = -r * r
    A = 1 - B - C
    return lfilter([A], [1, -B, -C], x)


def synth(f0_base, formant_scale, noise_db=None, seed=1):
    rng = np.random.default_rng(seed)
    parts = []
    for idx, v in enumerate(SEQUENCE):
        n = int(VOWEL_DUR * FS)
        t = np.arange(n) / FS
        # slight declination + vibrato + jitter
        f0 = f0_base * (1 + 0.02 * np.sin(2 * np.pi * 5.5 * t) - 0.03 * t / VOWEL_DUR) * (1 + 0.004 * rng.standard_normal(n).cumsum() / np.sqrt(np.arange(1, n + 1)))
        src = rosenberg_pulse_train(f0, FS)
        formants, bws = VOWELS[v]
        y = src.copy()
        for f, bw in zip(formants + [3300, 3850], bws + [220, 260]):
            y = resonator(y, f * formant_scale, bw, FS)
        y = lfilter([1, -0.6], [1], y)  # mild pre-emphasis (lip radiation)
        # amplitude envelope (attack/decay)
        env = np.ones(n)
        a = int(0.03 * FS)
        env[:a] = np.linspace(0, 1, a)
        env[-a:] = np.linspace(1, 0, a)
        y = y / (np.max(np.abs(y)) + 1e-9) * 0.5 * env
        parts.append(y)
        if idx == 2:
            # fricative /s/: high-passed noise burst
            m = int(FRIC_DUR * FS)
            noise = rng.standard_normal(m)
            from scipy.signal import butter
            b, a_ = butter(4, 4000 / (FS / 2), 'high')
            fr = lfilter(b, a_, noise)
            env = np.hanning(m)
            fr = fr / (np.max(np.abs(fr)) + 1e-9) * 0.25 * env
            parts.append(fr)
    sig = np.concatenate(parts)
    # short silences at both ends
    pad = np.zeros(int(0.15 * FS))
    sig = np.concatenate([pad, sig, pad])
    if noise_db is not None:
        noise = rng.standard_normal(len(sig)) * (10 ** (noise_db / 20))
        # pinkish colouring
        b = np.array([0.05, 0.05]); noise = lfilter([1.0], [1.0, -0.95], noise) * 0.1
        noise = noise / (np.sqrt(np.mean(noise ** 2)) + 1e-9) * (10 ** (noise_db / 20))
        sig = sig + noise
    return sig.astype(np.float32)


def save(name, sig):
    wavfile.write(os.path.join(OUT, name), FS, (np.clip(sig, -1, 1) * 32767).astype(np.int16))
    print('wrote', name, len(sig) / FS, 's')


if __name__ == '__main__':
    save('male.wav', synth(118.0, 1.0))
    save('female.wav', synth(215.0, 1.18, seed=2))
    save('male_noisy.wav', synth(118.0, 1.0, noise_db=-38, seed=3))
