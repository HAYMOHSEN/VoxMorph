#!/usr/bin/env python3
"""Local, recorded-audio smoke test of ContentVec -> RMVPE -> RVC ONNX.

This is a functional test harness, not a production recorder or an audio-quality rating.
Requires numpy, scipy, torch and onnxruntime. All inference runs on the local CPU.
"""
import argparse
import gc
import hashlib
import json
import math
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort
from scipy.io import wavfile
from scipy.signal import butter, resample_poly, sosfiltfilt
import torch


def prepare_audio(samples, sample_rate):
    """Accept mono/stereo PCM at a reported sample rate; return finite 16 kHz mono.

    This handles common recording formats and levels. It does not establish
    compatibility with physical microphone drivers or repair a clipped recording.
    """
    data = np.asarray(samples)
    if data.dtype == np.uint8:
        audio = (data.astype(np.float32) - 128) / 128
    elif np.issubdtype(data.dtype, np.signedinteger):
        audio = data.astype(np.float32) / (np.iinfo(data.dtype).max + 1.0)
    else:
        audio = data.astype(np.float32)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if audio.ndim != 1 or len(audio) == 0 or not np.isfinite(audio).all():
        raise ValueError('Expected nonempty finite mono/stereo audio')
    rate = int(sample_rate)
    if rate < 8000 or rate > 192000:
        raise ValueError('Expected a sample rate between 8 and 192 kHz')
    if rate != 16000:
        divisor = math.gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, rate // divisor)
    if len(audio) < 1024:
        raise ValueError('Audio is too short for the model frontend')
    audio = sosfiltfilt(butter(3, 48, 'highpass', fs=16000, output='sos'), audio)
    rms = float(np.sqrt(np.mean(audio * audio)))
    peak = float(np.max(np.abs(audio)))
    if rms > 1e-7 and peak > 0:
        gain = min(10 ** (-23 / 20) / rms, 10.0, 0.98 / peak)
        audio *= gain
    return np.ascontiguousarray(audio, dtype=np.float32)


def session(path):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), sess_options=options,
                               providers=['CPUExecutionProvider'])


def log_mel(audio):
    # HTK mel frequencies, with area normalization, as used by RMVPE.
    fft_freqs = np.linspace(0, 8000, 513)
    mel_edges = np.linspace(2595 * np.log10(1 + 30 / 700),
                            2595 * np.log10(1 + 8000 / 700), 130)
    frequencies = 700 * (10 ** (mel_edges / 2595) - 1)
    slopes = frequencies[:, None] - fft_freqs[None, :]
    bank = np.maximum(0, np.minimum(-slopes[:-2] / np.diff(frequencies)[:-1, None],
                                    slopes[2:] / np.diff(frequencies)[1:, None]))
    bank *= (2 / (frequencies[2:] - frequencies[:-2]))[:, None]
    with torch.inference_mode():
        spectrum = torch.stft(torch.from_numpy(audio)[None], n_fft=1024,
                              hop_length=160, win_length=1024,
                              window=torch.hann_window(1024), center=True,
                              return_complex=True).abs()
        features = torch.from_numpy(bank.astype(np.float32)) @ spectrum
        return torch.log(torch.clamp(features, min=1e-5)).numpy()


def pitch_from_salience(hidden, threshold=0.03):
    salience = np.asarray(hidden[0])
    centers = np.argmax(salience, axis=1) + 4
    padded = np.pad(salience, ((0, 0), (4, 4)))
    cents = np.pad(20 * np.arange(360) + 1997.3794084376191, (4, 4))
    indices = centers[:, None] + np.arange(-4, 5)[None]
    local = padded[np.arange(len(salience))[:, None], indices]
    averages = (local * cents[indices]).sum(1) / np.maximum(local.sum(1), 1e-12)
    f0 = 10 * 2 ** (averages / 1200)
    f0[salience.max(1) <= threshold] = 0
    return f0.astype(np.float32)


def coarse_pitch(f0):
    mel = 1127 * np.log1p(f0 / 700)
    minimum, maximum = 1127 * np.log1p(50 / 700), 1127 * np.log1p(1100 / 700)
    voiced = mel > 0
    mel[voiced] = (mel[voiced] - minimum) * 254 / (maximum - minimum) + 1
    return np.rint(np.clip(mel, 1, 255)).astype(np.int64)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shared', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    rate, recording = wavfile.read(root / 'audio' / 'arabic-female-16s-original.wav')
    audio = prepare_audio(recording, rate)
    torch.set_num_threads(2)
    report = {'input': 'audio/arabic-female-16s-original.wav',
              'input_duration_seconds': len(recording) / rate,
              'inference': 'local CPU; no network inference', 'retrieval_index': False,
              'perceptual_quality_rated': False, 'microphone_hardware_tested': False,
              'preprocessing_checks': [], 'conversions': []}
    # Simulated format/level variations are not recordings from different microphones.
    rng = np.random.default_rng(1)
    source_rms = float(np.sqrt(np.mean(recording.astype(np.float64) ** 2)))
    noisy = recording + rng.standard_normal(len(recording)) * source_rms / 10
    variations = [('original-16k-mono', recording, rate),
                  ('quiet-minus-20dB', recording * 0.1, rate),
                  ('simulated-noise-20dB-SNR', noisy, rate),
                  ('resampled-44k1-stereo', np.column_stack([resample_poly(recording, 441, 160)] * 2), 44100),
                  ('resampled-48k-mono', resample_poly(recording, 3, 1), 48000)]
    for label, data, sr in variations:
        normalized = prepare_audio(data, sr)
        assert np.isfinite(normalized).all() and abs(len(normalized) - len(audio)) <= 1
        assert np.max(np.abs(normalized)) <= 0.981
        report['preprocessing_checks'].append({'case': label, 'passed': True,
                                                'simulated': label != 'original-16k-mono'})

    encoder = session(args.shared / 'vec-768-layer-12.onnx')
    features = encoder.run(['embed'], {'source': audio[None, None]})[0]
    features = np.repeat(features, 2, axis=1)
    del encoder
    gc.collect()
    predictor = session(args.shared / 'rmvpe.onnx')
    mel = log_mel(audio)
    valid_frames = mel.shape[-1]
    padded = np.pad(mel, ((0, 0), (0, 0), (0, (-valid_frames) % 32)), mode='reflect')
    salience = predictor.run(['output'], {'input': padded})[0][:, :valid_frames]
    f0 = pitch_from_salience(salience)
    del predictor, salience, mel, padded
    gc.collect()
    frames = min(features.shape[1], len(f0))
    features = np.ascontiguousarray(features[:, :frames], dtype=np.float32)
    f0 = f0[:frames]
    voiced = f0[f0 > 0]
    report['f0'] = {'frames': frames, 'voiced_fraction': float((f0 > 0).mean()),
                     'median_voiced_hz': float(np.median(voiced)) if len(voiced) else None}
    for voice, semitones in [('female-p231', 0), ('male-p226', -12)]:
        net = session(root / (voice + '.onnx'))
        shifted = f0 * 2 ** (semitones / 12)
        feeds = {'phone': features, 'phone_lengths': np.array([frames], np.int64),
                 'pitch': coarse_pitch(shifted)[None], 'pitchf': shifted[None],
                 'ds': np.array([0], np.int64),
                 'rnd': (rng.standard_normal((1, 192, frames)) * 0.66666).astype(np.float32)}
        started = time.monotonic()
        output = net.run(['audio'], feeds)[0].reshape(-1)
        assert np.isfinite(output).all() and np.sqrt(np.mean(output ** 2)) > 1e-5
        destination = root / 'audio' / ('arabic-converted-' + voice + '.wav')
        pcm = (np.clip(output, -1, 1) * 32767).astype(np.int16)
        wavfile.write(destination, 40000, pcm)
        result = {'voice': voice, 'output': 'audio/' + destination.name,
                  'pitch_shift_semitones': semitones, 'duration_seconds': len(output) / 40000,
                  'seconds_to_run': round(time.monotonic() - started, 3),
                  'all_finite': True, 'rms': float(np.sqrt(np.mean(output ** 2))),
                  'peak': float(np.max(np.abs(output))),
                  'clipped_sample_fraction': float((np.abs(output) >= 1).mean()),
                  'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}
        report['conversions'].append(result)
        print(json.dumps(result), flush=True)
        del net, output, feeds
        gc.collect()
    (root / 'real-audio-validation.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
