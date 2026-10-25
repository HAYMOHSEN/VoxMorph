#!/usr/bin/env python
"""Export a ContentVec (HuBERT-base, 768-d, layer 12) speech-content model to the ONNX contract VoxMorph expects:

    input  "source"  float32 [1, 1, N]   (16 kHz mono, conditioned by the app)
    output "embed"   float32 [1, T, 768] (50 frames per second; the app repeats each frame twice → 100 Hz)

Two sources are supported:

  A) the fairseq checkpoint used by RVC ("hubert_base.pt" = contentvec_best_legacy_500, MIT licence)
        pip install fairseq torch onnx onnxruntime
        python export_contentvec_onnx.py --fairseq hubert_base.pt --out vec-768-layer-12.onnx

  B) the Hugging Face transformers port (lengyue233/content-vec-best)
        pip install transformers torch onnx onnxruntime
        python export_contentvec_onnx.py --hf lengyue233/content-vec-best --out vec-768-layer-12.onnx

ALWAYS verify the export against a known-good file before shipping it (see AI-SETUP.md for its sha256):
        python export_contentvec_onnx.py ... --reference known-good/vec-768-layer-12.onnx
The verification runs both files on the same audio and reports the mean cosine similarity of the frames;
anything below 0.999 means the export does not reproduce RVC's features and must not be used.
"""
import argparse
import sys

import numpy as np
import torch


class FairseqWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, source):  # [1, 1, N]
        x = source.squeeze(1)
        padding_mask = torch.zeros_like(x, dtype=torch.bool)
        feats = self.model.extract_features(source=x, padding_mask=padding_mask, output_layer=12)[0]
        return feats  # [1, T, 768]


class HfWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, source):  # [1, 1, N]
        out = self.model(source.squeeze(1), output_hidden_states=True)
        return out.last_hidden_state  # output of transformer layer 12, [1, T, 768]


def load_fairseq(path):
    from fairseq import checkpoint_utils
    models, _, _ = checkpoint_utils.load_model_ensemble_and_task([path], suffix="")
    model = models[0].eval()
    return FairseqWrapper(model)


def load_hf(name):
    from transformers import HubertModel
    model = HubertModel.from_pretrained(name).eval()
    return HfWrapper(model)


def export(wrapper, out_path):
    dummy = torch.randn(1, 1, 16000 * 2)
    torch.onnx.export(
        wrapper, dummy, out_path, opset_version=17, do_constant_folding=True,
        input_names=["source"], output_names=["embed"],
        dynamic_axes={"source": {2: "sample_length"}, "embed": {1: "frames"}},
    )
    print(f"wrote {out_path}")


def verify(out_path, reference):
    import onnxruntime as ort
    rng = np.random.default_rng(0)
    # a few seconds of harmonic 'speech-like' audio plus noise, at the levels the app feeds the model
    t = np.arange(16000 * 3) / 16000
    f0 = 140 + 30 * np.sin(2 * np.pi * 0.7 * t)
    x = np.zeros_like(t)
    for h in range(1, 12):
        x += np.sin(2 * np.pi * np.cumsum(f0 * h) / 16000) / h
    x = (x / np.max(np.abs(x)) * 0.3 + rng.standard_normal(len(t)) * 0.01).astype(np.float32)[None, None]
    a = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
    b = ort.InferenceSession(reference, providers=["CPUExecutionProvider"])
    ea = a.run(None, {a.get_inputs()[0].name: x})[0]
    eb = b.run(None, {b.get_inputs()[0].name: x})[0]
    if ea.shape != eb.shape:
        print(f"shape mismatch: export {ea.shape} vs reference {eb.shape}")
        return False
    cos = np.sum(ea * eb, -1) / (np.linalg.norm(ea, axis=-1) * np.linalg.norm(eb, axis=-1) + 1e-9)
    print(f"frames {ea.shape[1]}: mean cosine {cos.mean():.5f}, min {cos.min():.5f}, max |diff| {np.max(np.abs(ea - eb)):.4f}")
    ok = cos.mean() > 0.999
    print("VERIFIED — the export reproduces the reference features" if ok else "MISMATCH — do not use this export")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--fairseq", help="hubert_base.pt / contentvec checkpoint (fairseq)")
    src.add_argument("--hf", help="transformers model id or folder, e.g. lengyue233/content-vec-best")
    ap.add_argument("--out", required=True)
    ap.add_argument("--reference", help="known-good vec-768-layer-12.onnx to compare against")
    a = ap.parse_args()
    wrapper = load_fairseq(a.fairseq) if a.fairseq else load_hf(a.hf)
    with torch.inference_mode():
        export(wrapper, a.out)
    if a.reference:
        sys.exit(0 if verify(a.out, a.reference) else 1)
    print("no --reference given: verify the file against a known-good export before using it")


if __name__ == "__main__":
    main()
