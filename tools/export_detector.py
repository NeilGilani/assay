"""Build the on-device detector FIELD ships in web/models/.

FIELD's perception is an open-vocabulary detector (Ultralytics YOLOE) with the
emergency vocabulary in tools/vocabulary.json baked into it at export time. The
text encoder runs here, once, on a workstation - the phone never needs it, which
is what makes a 29-class "what is in this building" detector small enough to
run in a browser tab with the radio off.

Two things this does beyond a plain ``model.export``:

* **Drops the segmentation branch.** YOLOE ships as a segmentation model. FIELD
  places objects by their boxes and never reads a mask, so the prototype branch
  is pruned out of the graph: smaller download, less compute per frame.
* **Writes a manifest** (detector.json) next to the weights, naming every class,
  the ontology id it maps to, the input size and the output layout. The browser
  reads the manifest, never guesses it, so a re-export with a different
  vocabulary cannot silently mislabel a fire as a door.

Usage (needs ``pip install ultralytics onnx onnxslim``; the browser needs none
of it)::

    python tools/export_detector.py                       # yoloe-26s, 640px
    python tools/export_detector.py --weights yoloe-26n-seg.pt --imgsz 512
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOCAB = ROOT / "tools" / "vocabulary.json"
OUT_DIR = ROOT / "web" / "models"


def load_vocabulary(path: Path = VOCAB) -> list[tuple[str, str]]:
    data = json.loads(path.read_text())
    pairs = [(str(p), str(i)) for p, i in data["prompts"]]
    prompts = [p for p, _ in pairs]
    if len(set(prompts)) != len(prompts):
        raise SystemExit("vocabulary.json repeats a prompt; each prompt must be one class")
    return pairs


def prune_to_boxes(onnx_path: Path) -> list[int]:
    """Keep only the box/score output; drop the mask prototypes and their branch."""
    import onnx
    from onnx import utils

    model = onnx.load(str(onnx_path))
    inputs = [i.name for i in model.graph.input]
    outputs = [o.name for o in model.graph.output]
    keep = outputs[0]
    pruned = onnx_path.with_suffix(".boxes.onnx")
    utils.extract_model(str(onnx_path), str(pruned), inputs, [keep])
    shutil.move(pruned, onnx_path)
    shape = onnx.load(str(onnx_path)).graph.output[0].type.tensor_type.shape
    return [d.dim_value for d in shape.dim]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", default="yoloe-26s-seg.pt", help="YOLOE text-promptable weights")
    ap.add_argument("--imgsz", type=int, default=640, help="square input size the browser letterboxes to")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    from ultralytics import YOLOE

    pairs = load_vocabulary()
    prompts = [p for p, _ in pairs]

    model = YOLOE(args.weights)
    model.set_classes(prompts, model.get_text_pe(prompts))

    exported = Path(model.export(format="onnx", imgsz=args.imgsz, simplify=True, opset=17))
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "detector.onnx"
        shutil.copy(exported, work)
        shape = prune_to_boxes(work)
        args.out.mkdir(parents=True, exist_ok=True)
        target = args.out / "detector.onnx"
        shutil.copy(work, target)

    # output0 is [1, 4 + classes + 32 mask coefficients, anchors]
    channels = shape[1]
    expected = 4 + len(prompts) + 32
    if channels != expected:
        raise SystemExit(f"unexpected output layout {shape}; expected {expected} channels")

    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    manifest = {
        "file": target.name,
        "sha256": digest,
        "bytes": target.stat().st_size,
        "source_weights": Path(args.weights).name,
        "exported": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "input": {"size": args.imgsz, "layout": "NCHW", "channels": "RGB", "scale": "0-1", "letterbox_fill": 114},
        "output": {
            "shape": shape,
            "layout": "[1, 4 + classes + extra, anchors]; rows 0-3 are cx, cy, w, h in input pixels",
            "box_rows": 4,
            "extra_rows": 32,
        },
        "classes": [{"prompt": p, "id": i} for p, i in pairs],
        "license": "Weights derive from Ultralytics YOLOE (AGPL-3.0).",
    }
    (args.out / "detector.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {target} ({target.stat().st_size / 1e6:.1f} MB) and detector.json - {len(prompts)} classes, output {shape}")


if __name__ == "__main__":
    main()
