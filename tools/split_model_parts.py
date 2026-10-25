#!/usr/bin/env python
"""Split a large model file into parts that GitHub's web uploader accepts (default 24 MB) and
print the matching entry for models/manifest.json (VoxMorph stitches the parts back together).

    python split_model_parts.py female-p231.onnx --out models/parts --mb 24 --base ./parts/
"""
import argparse
import hashlib
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--out", default="parts")
    ap.add_argument("--mb", type=float, default=24)
    ap.add_argument("--base", default="./parts/", help="URL prefix written into the manifest entry")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    size = os.path.getsize(args.file)
    part_size = int(args.mb * 1024 * 1024)
    name = os.path.basename(args.file)
    sha = hashlib.sha256()
    parts = []
    with open(args.file, "rb") as f:
        i = 0
        while True:
            chunk = f.read(part_size)
            if not chunk:
                break
            sha.update(chunk)
            pname = f"{name}.{i:03d}"
            with open(os.path.join(args.out, pname), "wb") as pf:
                pf.write(chunk)
            parts.append(args.base.rstrip("/") + "/" + pname)
            i += 1
    entry = {"id": os.path.splitext(name)[0], "parts": parts, "size": size, "sha256": sha.hexdigest()}
    print(f"{len(parts)} parts of ≤{args.mb} MB written to {args.out}")
    print(json.dumps(entry, indent=2))


if __name__ == "__main__":
    main()
