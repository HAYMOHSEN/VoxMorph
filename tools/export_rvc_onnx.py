#!/usr/bin/env python
"""Export an RVC v2 voice model (.pth from Applio / RVC WebUI) to ONNX for VoxMorph.

Usage (inside the Python environment of Applio or RVC WebUI, which has torch):

    git clone https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI rvc
    python export_rvc_onnx.py --rvc rvc --model "C:/path/voice.pth" --out "voice.onnx"

The exported file has the inputs VoxMorph expects: phone, phone_lengths, pitch, pitchf, ds, rnd
and one output: audio. The script also prints the model's sample rate (32000/40000/48000) and
version so you can fill models/manifest.json.
"""
import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rvc", required=True, help="path to a clone of RVC-Project/Retrieval-based-Voice-Conversion-WebUI")
    ap.add_argument("--model", required=True, help="input .pth voice model")
    ap.add_argument("--out", required=True, help="output .onnx path")
    ap.add_argument("--opset", type=int, default=13)
    args = ap.parse_args()

    sys.path.insert(0, os.path.abspath(args.rvc))
    import torch  # noqa: E402
    from infer.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM  # noqa: E402

    cpt = torch.load(args.model, map_location="cpu", weights_only=False)
    cpt["config"][-3] = cpt["weight"]["emb_g.weight"].shape[0]  # number of speakers
    version = cpt.get("version", "v1")
    vec_channels = 256 if version == "v1" else 768
    sr = cpt.get("sr", cpt["config"][-1])
    print(f"version={version} sample_rate={sr} f0={cpt.get('f0', 1)} speakers={cpt['config'][-3]} vec_channels={vec_channels}")
    if version == "v1":
        print("WARNING: v1 models use 256-dim features (vec-256-layer-9). VoxMorph is set up for v2 (768-dim).")

    net_g = SynthesizerTrnMsNSFsidM(*cpt["config"], is_half=False, version=version)
    net_g.load_state_dict(cpt["weight"], strict=False)
    net_g.eval()

    T = 200
    test_phone = torch.rand(1, T, vec_channels)
    test_phone_lengths = torch.tensor([T]).long()
    test_pitch = torch.randint(size=(1, T), low=5, high=255)
    test_pitchf = torch.rand(1, T)
    test_ds = torch.LongTensor([0])
    test_rnd = torch.rand(1, 192, T)
    input_names = ["phone", "phone_lengths", "pitch", "pitchf", "ds", "rnd"]
    output_names = ["audio"]
    kwargs = dict(
        dynamic_axes={"phone": [1], "pitch": [1], "pitchf": [1], "rnd": [2]},
        do_constant_folding=False,
        opset_version=args.opset,
        verbose=False,
        input_names=input_names,
        output_names=output_names,
    )
    args_tuple = (test_phone, test_phone_lengths, test_pitch, test_pitchf, test_ds, test_rnd)
    try:
        torch.onnx.export(net_g, args_tuple, args.out, dynamo=False, **kwargs)  # torch >= 2.5: force the classic exporter
    except TypeError:
        torch.onnx.export(net_g, args_tuple, args.out, **kwargs)
    size = os.path.getsize(args.out)
    print(f"wrote {args.out} ({size / 1e6:.1f} MB)")
    print("manifest entry: " + str({"sampleRate": int(sr), "version": 2 if version != "v1" else 1, "dims": vec_channels, "speakerId": 0}))


if __name__ == "__main__":
    main()
