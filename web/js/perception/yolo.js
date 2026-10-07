// Turning the detector's raw output into boxes. Pure functions, so the same
// code that runs in the browser worker is checked by the Node test suite.
//
// The exported model (tools/export_detector.py) emits one tensor shaped
// [1, 4 + classes + 32, anchors]: for each of ~8400 anchor positions, a box
// (cx, cy, w, h in letterboxed input pixels), one score per class, and 32
// mask coefficients FIELD ignores. Scores are independent sigmoids, so each
// anchor takes its best class; overlapping boxes of the same class are then
// thinned with non-maximum suppression.

/** Scale and padding that fit a srcW x srcH frame into a size x size square. */
export function letterbox(srcW, srcH, size) {
  const scale = Math.min(size / srcW, size / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return { scale, w, h, padX: Math.floor((size - w) / 2), padY: Math.floor((size - h) / 2), size };
}

/** RGBA pixels of the letterboxed square -> Float32 NCHW in 0..1. */
export function toTensorData(rgba, size) {
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; p < plane; i += 4, p++) {
    out[p] = rgba[i] / 255;
    out[plane + p] = rgba[i + 1] / 255;
    out[2 * plane + p] = rgba[i + 2] / 255;
  }
  return out;
}

export function boxIou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * data: Float32Array of the [1, C, N] output; returns
 * [{ classIndex, score, box: [x0, y0, x1, y1] }] in source-frame pixels.
 */
export function decode(data, { anchors, numClasses, lb, srcW, srcH, scoreThreshold = 0.2, iouThreshold = 0.5, maxDetections = 100 }) {
  const cands = [];
  for (let i = 0; i < anchors; i++) {
    let best = -Infinity;
    let cls = -1;
    for (let c = 0; c < numClasses; c++) {
      const v = data[(4 + c) * anchors + i];
      if (v > best) {
        best = v;
        cls = c;
      }
    }
    if (best < scoreThreshold) continue;
    const cx = data[i];
    const cy = data[anchors + i];
    const w = data[2 * anchors + i];
    const h = data[3 * anchors + i];
    const clampX = (v) => Math.max(0, Math.min(srcW, v));
    const clampY = (v) => Math.max(0, Math.min(srcH, v));
    cands.push({
      classIndex: cls,
      score: best,
      box: [
        clampX((cx - w / 2 - lb.padX) / lb.scale),
        clampY((cy - h / 2 - lb.padY) / lb.scale),
        clampX((cx + w / 2 - lb.padX) / lb.scale),
        clampY((cy + h / 2 - lb.padY) / lb.scale),
      ],
    });
  }
  cands.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of cands) {
    if (kept.length >= maxDetections) break;
    if (kept.some((k) => k.classIndex === d.classIndex && boxIou(k.box, d.box) > iouThreshold)) continue;
    kept.push(d);
  }
  return kept;
}
