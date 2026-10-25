#!/usr/bin/env python3
"""Export pitch-guided RVC v2 models using the bundled Mangio export code.

Example:
    python export_rvc_onnx_compatible.py --model Fp231rmvpe.pth --out female-p231.onnx

Requires torch, onnx, onnxruntime, numpy and scipy. A compatible RVC source
directory is bundled under source/; --rvc can select another compatible tree.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rvc', type=Path, default=Path(__file__).resolve().parent / 'source')
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--opset', type=int, default=13)
    args = parser.parse_args()
    sys.path.insert(0, str(args.rvc.resolve()))
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    try:
        from lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM
    except ModuleNotFoundError:
        from infer.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM

    torch.set_num_threads(2)
    torch.manual_seed(0)
    checkpoint = torch.load(args.model, map_location='cpu', weights_only=True)
    if checkpoint.get('version') != 'v2' or checkpoint.get('f0') != 1:
        raise ValueError('This exporter requires an RVC v2 checkpoint with f0=1.')
    config = list(checkpoint['config'])
    config[-3] = checkpoint['weight']['emb_g.weight'].shape[0]
    sr_value = checkpoint.get('sr', config[-1])
    sample_rate = {'32k': 32000, '40k': 40000, '48k': 48000}.get(sr_value, sr_value)
    sample_rate = int(sample_rate)
    channels = int(checkpoint['weight']['enc_p.emb_phone.weight'].shape[-1])
    if channels != 768 or sample_rate not in (32000, 40000, 48000):
        raise ValueError('Unexpected content dimension or sample rate')
    net = SynthesizerTrnMsNSFsidM(*config, is_half=False, version='v2').float().eval()
    # Posterior encoder participates in training only, and is absent in small RVC checkpoints.
    del net.enc_q
    state = {key: value.float() for key, value in checkpoint['weight'].items()
             if not key.startswith('enc_q.')}
    net.load_state_dict(state, strict=True)
    net.dec.remove_weight_norm()
    net.flow.remove_weight_norm()
    latent_channels = int(config[2])

    def example(frames):
        return (torch.rand(1, frames, channels), torch.tensor([frames], dtype=torch.int64),
                torch.full((1, frames), 128, dtype=torch.int64),
                torch.full((1, frames), 180.0), torch.tensor([0], dtype=torch.int64),
                torch.randn(1, latent_channels, frames) * 0.66666)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    names = ['phone', 'phone_lengths', 'pitch', 'pitchf', 'ds', 'rnd']
    with torch.inference_mode():
        torch.onnx.export(net, example(32), str(args.out), input_names=names,
                          output_names=['audio'], opset_version=args.opset,
                          do_constant_folding=False, dynamo=False,
                          dynamic_axes={'phone': {1: 'frames'}, 'pitch': {1: 'frames'},
                                        'pitchf': {1: 'frames'}, 'rnd': {2: 'frames'},
                                        'audio': {2: 'samples'}})
    onnx.checker.check_model(str(args.out))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(args.out), sess_options=options,
                                   providers=['CPUExecutionProvider'])
    if [value.name for value in session.get_inputs()] != names:
        raise ValueError('Exported input signature does not match the requested engine')
    hop = int(np.prod(config[12]))
    tests = []
    for frames in (32, 57):
        feeds = {name: value.numpy() for name, value in zip(names, example(frames))}
        audio = session.run(['audio'], feeds)[0]
        assert audio.shape == (1, 1, frames * hop), audio.shape
        assert np.isfinite(audio).all() and np.max(np.abs(audio)) > 0
        tests.append({'frames': frames, 'audio_shape': list(audio.shape),
                      'all_finite': True, 'nonzero': True})
    details = {'file': args.out.name, 'source_checkpoint': args.model.name,
               'source_sha256': hashlib.sha256(args.model.read_bytes()).hexdigest(),
               'sha256': hashlib.sha256(args.out.read_bytes()).hexdigest(),
               'sampleRate': sample_rate, 'version': 2, 'f0': True, 'dims': channels,
               'speakerId': 0, 'latentChannels': latent_channels, 'hopLength': hop,
               'opset': args.opset, 'strict_weight_loading': 'passed',
               'onnx_checker': 'passed', 'dynamic_length_tests': tests,
               'inputs': [{'name': x.name, 'type': x.type, 'shape': x.shape}
                          for x in session.get_inputs()],
               'outputs': [{'name': x.name, 'type': x.type, 'shape': x.shape}
                           for x in session.get_outputs()],
               'quality_claim': 'Functional export checks only; no perceptual rating.'}
    args.out.with_suffix('.json').write_text(json.dumps(details, indent=2) + '\n')
    print(json.dumps(details, indent=2), flush=True)


if __name__ == '__main__':
    main()
