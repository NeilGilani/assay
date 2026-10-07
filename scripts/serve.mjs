// Serve web/ locally. No dependencies.
//
// Two headers matter and are the reason this exists instead of
// `python -m http.server`: Cross-Origin-Opener-Policy and
// Cross-Origin-Embedder-Policy make the page cross-origin isolated, which is
// what lets the inference runtime use more than one CPU thread. (Offline, the
// service worker adds the same headers to what it serves from cache.)
//
//   npm start                    http://localhost:8000
//   npm start -- --port 9000 --host 0.0.0.0
//
// A phone needs HTTPS for the camera (localhost is the only exception), so to
// test on a phone either deploy web/ to any HTTPS static host, or on Android
// run `adb reverse tcp:8000 tcp:8000` and open http://localhost:8000 there.

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../web/", import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const port = Number(opt("port", process.env.PORT ?? 8000));
const host = opt("host", "127.0.0.1");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
};

export const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

if (!args.includes("--no-build")) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./build-manifest.mjs", import.meta.url))], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    const st = statSync(path);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, SECURITY_HEADERS).end("not found");
  }
});

server.listen(port, host, () => {
  console.log(`FIELD on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});
