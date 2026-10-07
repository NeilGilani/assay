// Copy the on-device inference runtime out of node_modules into web/vendor/.
//
// FIELD loads nothing from a CDN, ever: the page's Content-Security-Policy
// forbids it, and a CDN is exactly the thing that is not there in a disaster.
// So the runtime is served from the same origin as the app and precached by
// the service worker with everything else.
//
// The WebGPU build is used because it also runs the multi-threaded WASM (CPU)
// backend: one runtime, GPU when the phone has one, CPU when it does not.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dst = join(root, "web", "vendor", "ort");

const FILES = ["ort.webgpu.min.mjs", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];

if (!existsSync(src)) {
  console.error("onnxruntime-web is not installed; run `npm install` first.");
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
for (const f of FILES) copyFileSync(join(src, f), join(dst, f));
writeFileSync(join(dst, "README.md"), "Copied from onnxruntime-web (MIT, Microsoft) by scripts/vendor.mjs. Do not edit; do not commit.\n");
console.log(`vendored ${FILES.length} onnxruntime-web files into web/vendor/ort/`);
