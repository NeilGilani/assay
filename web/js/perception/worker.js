// The detector, running in a Web Worker so the camera view never stutters.
//
// Everything it needs is served from this origin and precached: the ONNX
// Runtime build in vendor/ort, the model in models/. It checks the model's
// SHA-256 against the manifest before running it - a truncated download from
// a flaky connection would otherwise load fine and quietly detect nothing.

import * as ort from "../../vendor/ort/ort.webgpu.min.mjs";
import { decode, letterbox, toTensorData } from "./yolo.js";

const base = new URL("../../", import.meta.url);
ort.env.wasm.wasmPaths = new URL("vendor/ort/", base).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;

let session = null;
let manifest = null;
let inputName = null;
let canvas = null;
let ctx = null;

async function fetchWithProgress(url, onProgress) {
  // Prefer the offline copy the service worker saved, so the model is never
  // downloaded twice and loads identically with the radio off.
  const res = (self.caches ? await caches.match(url.href) : null) ?? (await fetch(url));
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return got === total ? out : out.slice(0, got);
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function load({ prefer }) {
  const t0 = performance.now();
  manifest = await (await fetch(new URL("models/detector.json", base))).json();
  const bytes = await fetchWithProgress(new URL(`models/${manifest.file}`, base), (p) => postMessage({ type: "progress", phase: "model", p }));
  const hash = await sha256(bytes);
  if (manifest.sha256 && hash !== manifest.sha256) {
    throw new Error(`model file is corrupt or incomplete (sha256 ${hash.slice(0, 12)} != ${manifest.sha256.slice(0, 12)})`);
  }
  postMessage({ type: "progress", phase: "compile", p: 1 });

  const tryOrder = prefer === "wasm" || !self.navigator?.gpu ? ["wasm"] : ["webgpu", "wasm"];
  let lastErr = null;
  for (const ep of tryOrder) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: "all" });
      inputName = session.inputNames[0];
      const size = manifest.input.size;
      canvas = new OffscreenCanvas(size, size);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      // first run compiles kernels; do it now, not on the first real frame
      const warm = new ort.Tensor("float32", new Float32Array(3 * size * size), [1, 3, size, size]);
      await session.run({ [inputName]: warm });
      return { backend: ep, loadMs: Math.round(performance.now() - t0), threads: ort.env.wasm.numThreads, sha256: hash, manifest };
    } catch (err) {
      lastErr = err;
      session = null;
    }
  }
  throw lastErr ?? new Error("no execution provider available");
}

async function detect({ bitmap, scoreThreshold }) {
  const t0 = performance.now();
  const size = manifest.input.size;
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const lb = letterbox(srcW, srcH, size);
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, lb.padX, lb.padY, lb.w, lb.h);
  bitmap.close?.();
  const rgba = ctx.getImageData(0, 0, size, size).data;
  const input = new ort.Tensor("float32", toTensorData(rgba, size), [1, 3, size, size]);
  const t1 = performance.now();
  const out = await session.run({ [inputName]: input });
  const t2 = performance.now();
  const tensor = out[session.outputNames[0]];
  const [, , anchors] = tensor.dims;
  const raw = decode(tensor.data, { anchors, numClasses: manifest.classes.length, lb, srcW, srcH, scoreThreshold });
  const detections = raw.map((d) => ({
    kind: manifest.classes[d.classIndex].id,
    prompt: manifest.classes[d.classIndex].prompt,
    score: d.score,
    box: d.box,
  }));
  return { detections, width: srcW, height: srcH, ms: { prep: t1 - t0, infer: t2 - t1, post: performance.now() - t2 } };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") postMessage({ type: "ready", id: msg.id, ...(await load(msg)) });
    else if (msg.type === "detect") postMessage({ type: "result", id: msg.id, ...(await detect(msg)) });
  } catch (err) {
    postMessage({ type: "error", id: msg.id, message: String(err?.message ?? err) });
  }
};
