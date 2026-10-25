"""Synthesise a ~10 s sentence-like signal (syllables with bursts, pauses, intonation) for Store screenshots."""
import numpy as np
from scipy.signal import lfilter, butter
from scipy.io import wavfile
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth_speech import rosenberg_pulse_train, resonator, VOWELS, FS

rng = np.random.default_rng(7)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'demo_speech.wav')


def syllable(vowel, dur, f0_start, f0_end, amp):
    n = int(dur * FS)
    t = np.arange(n) / FS
    f0 = np.linspace(f0_start, f0_end, n) * (1 + 0.015 * np.sin(2 * np.pi * 5.5 * t))
    src = rosenberg_pulse_train(f0, FS)
    formants, bws = VOWELS[vowel]
    y = src.copy()
    for f, bw in zip(formants + [3300, 3850], bws + [220, 260]):
        y = resonator(y, f, bw, FS)
    y = lfilter([1, -0.6], [1], y)
    env = np.ones(n)
    a = int(0.02 * FS)
    env[:a] = np.linspace(0, 1, a)
    env[-a:] = np.linspace(1, 0, a)
    y = y / (np.max(np.abs(y)) + 1e-9) * amp * env
    # consonant burst before the vowel
    m = int(0.045 * FS)
    noise = rng.standard_normal(m)
    b, a_ = butter(4, [1800 / (FS / 2), 7000 / (FS / 2)], 'band')
    burst = lfilter(b, a_, noise)
    burst = burst / (np.max(np.abs(burst)) + 1e-9) * amp * 0.35 * np.hanning(m)
    return np.concatenate([burst, y])


parts = [np.zeros(int(0.25 * FS))]
phrases = [6, 4, 7, 5, 6]
vowels = list(VOWELS.keys())
for pi, count in enumerate(phrases):
    f0_top = 128 - pi * 3
    for si in range(count):
        v = vowels[rng.integers(len(vowels))]
        dur = rng.uniform(0.12, 0.26)
        prog = si / max(1, count - 1)
        f0s = f0_top - 14 * prog + (10 if si == 1 else 0)
        f0e = f0s - rng.uniform(2, 9)
        amp = rng.uniform(0.35, 0.6) * (1 - 0.25 * prog)
        parts.append(syllable(v, dur, f0s, f0e, amp))
        parts.append(np.zeros(int(rng.uniform(0.01, 0.05) * FS)))
    parts.append(np.zeros(int(rng.uniform(0.28, 0.5) * FS)))
parts.append(np.zeros(int(0.3 * FS)))
sig = np.concatenate(parts)
sig = sig + rng.standard_normal(len(sig)) * 0.0008   # faint room noise
wavfile.write(OUT, FS, (np.clip(sig, -1, 1) * 32767).astype(np.int16))
print('wrote', OUT, round(len(sig) / FS, 2), 's')
