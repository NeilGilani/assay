"""How often does the detector see a hazard that is not there?

Run the exported model over a folder of ordinary photos - scenes with no fire,
no flood, no rubble - and count, per class, the share of images where it fires
anyway. That number is what FIELD's per-kind score floors in
web/js/ontology.js are set against, and why a hazard seen in one frame is
reported as "glimpsed, unconfirmed" rather than as a fact.

If the folder has YOLO-format labels (labels/ beside images/, class 0 =
person, as in COCO), person recall is reported too.

    python tools/measure_false_alarms.py path/to/images [--thresholds 0.25 0.35 0.5]

Needs numpy, pillow, onnxruntime. The browser needs none of it.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
# the kinds web/js/ontology.js treats as hazards
HAZARDS = {"fire", "smoke", "debris", "structural_damage", "water", "exposed_wires", "broken_glass", "gas_cylinder"}
MODEL_DIR = ROOT / "web" / "models"


def load():
    manifest = json.loads((MODEL_DIR / "detector.json").read_text())
    sess = ort.InferenceSession(str(MODEL_DIR / manifest["file"]))
    return manifest, sess


def detect(sess, manifest, path: Path, floor: float):
    """Same preprocessing and decoding as web/js/perception (letterbox, argmax, per-class NMS)."""
    size = manifest["input"]["size"]
    n = len(manifest["classes"])
    img = Image.open(path).convert("RGB")
    w, h = img.size
    r = min(size / w, size / h)
    nw, nh = round(w * r), round(h * r)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    px, py = (size - nw) // 2, (size - nh) // 2
    canvas.paste(img.resize((nw, nh), Image.BILINEAR), (px, py))
    x = (np.asarray(canvas, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    scores = out[4 : 4 + n]
    cls, conf = scores.argmax(0), scores.max(0)
    cands = []
    for i in np.where(conf >= floor)[0]:
        cx, cy, bw, bh = out[:4, i]
        cands.append((float(conf[i]), int(cls[i]), (cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2)))
    cands.sort(reverse=True)
    kept = []
    for c in cands:
        if all(not (c[1] == k[1] and iou(c[2], k[2]) > 0.5) for k in kept):
            kept.append(c)
    return [(score, manifest["classes"][c]["id"]) for score, c, _ in kept]


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", type=Path)
    ap.add_argument("--thresholds", type=float, nargs="+", default=[0.25, 0.35, 0.5])
    args = ap.parse_args()

    manifest, sess = load()
    paths = sorted(p for p in args.images.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    floor = min(args.thresholds)
    with_kind = {t: Counter() for t in args.thresholds}
    any_hazard = Counter()
    person_imgs = person_found = 0
    for p in paths:
        dets = detect(sess, manifest, p, floor)
        label = Path(str(p).replace("/images/", "/labels/")).with_suffix(".txt")
        if label.exists():
            classes = {int(line.split()[0]) for line in label.read_text().splitlines() if line.strip()}
            if 0 in classes:
                person_imgs += 1
                person_found += any(k == "person" and s >= 0.3 for s, k in dets)
        for t in args.thresholds:
            kinds = {k for s, k in dets if s >= t}
            for kind in kinds:
                with_kind[t][kind] += 1
            any_hazard[t] += bool(kinds & HAZARDS)

    print(f"{len(paths)} images")
    if person_imgs:
        print(f"person recall (score >= 0.30): {person_found}/{person_imgs} images that contain people")
    print("\nimages with any hazard box (these photos contain no emergencies):")
    print("".join(f"  >= {t}: {any_hazard[t]}/{len(paths)} ({any_hazard[t] / len(paths):.1%})" for t in args.thresholds))
    print("\nshare of images with at least one box of each kind:")
    kinds = sorted({k for c in with_kind.values() for k in c}, key=lambda k: -with_kind[floor][k])
    print("  kind".ljust(22) + "".join(f">= {t:<8}" for t in args.thresholds))
    for k in kinds:
        print(f"  {k:<20}" + "".join(f"{with_kind[t][k] / len(paths):>7.1%}   " for t in args.thresholds))


if __name__ == "__main__":
    main()
