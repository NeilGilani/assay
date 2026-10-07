import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, letterbox, toTensorData } from "../web/js/perception/yolo.js";

// Build a fake [1, 4 + classes + 32, anchors] output tensor.
function tensor(anchors, numClasses, rows) {
  const C = 4 + numClasses + 32;
  const data = new Float32Array(C * anchors);
  rows.forEach(({ cx, cy, w, h, scores }, i) => {
    data[i] = cx;
    data[anchors + i] = cy;
    data[2 * anchors + i] = w;
    data[3 * anchors + i] = h;
    scores.forEach((s, c) => (data[(4 + c) * anchors + i] = s));
  });
  return data;
}

test("letterbox: a 1280x720 frame fits a 640 square with bars top and bottom", () => {
  const lb = letterbox(1280, 720, 640);
  assert.equal(lb.scale, 0.5);
  assert.equal(lb.w, 640);
  assert.equal(lb.h, 360);
  assert.equal(lb.padX, 0);
  assert.equal(lb.padY, 140);
});

test("decode: boxes come back in source pixels, best class per anchor", () => {
  const lb = letterbox(1280, 720, 640);
  const data = tensor(4, 3, [
    { cx: 320, cy: 320, w: 100, h: 200, scores: [0.1, 0.9, 0.2] },
    { cx: 100, cy: 200, w: 20, h: 20, scores: [0.05, 0.05, 0.1] },
  ]);
  const out = decode(data, { anchors: 4, numClasses: 3, lb, srcW: 1280, srcH: 720, scoreThreshold: 0.25 });
  assert.equal(out.length, 1);
  assert.equal(out[0].classIndex, 1);
  assert.deepEqual(
    out[0].box.map((v) => Math.round(v)),
    [540, 160, 740, 560],
  );
});

test("decode: overlapping boxes of one class are thinned; other classes survive", () => {
  const lb = letterbox(640, 640, 640);
  const data = tensor(3, 2, [
    { cx: 300, cy: 300, w: 100, h: 100, scores: [0.8, 0] },
    { cx: 305, cy: 302, w: 100, h: 100, scores: [0.7, 0] },
    { cx: 302, cy: 300, w: 100, h: 100, scores: [0, 0.6] },
  ]);
  const out = decode(data, { anchors: 3, numClasses: 2, lb, srcW: 640, srcH: 640 });
  assert.deepEqual(
    out.map((d) => [d.classIndex, d.score]),
    [
      [0, 0.800000011920929],
      [1, 0.6000000238418579],
    ],
  );
});

test("pixels become planar RGB in 0..1", () => {
  const rgba = new Uint8ClampedArray([255, 0, 51, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const t = toTensorData(rgba, 2);
  assert.deepEqual([...t.slice(0, 4)], [1, 0, 0, 1]);
  assert.deepEqual([...t.slice(4, 8)], [0, 1, 0, 1]);
  assert.ok(Math.abs(t[8] - 0.2) < 1e-6);
});
