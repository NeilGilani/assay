// End-to-end, in a real (headless) Chromium: the actual page, the actual
// service worker, the actual model running through onnxruntime-web.
//
// The test that matters most is the last one: install once, cut the network,
// reload, and check FIELD still loads its model and sees people in a photo -
// with zero requests leaving the page.
//
//   npm run test:e2e

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const PORT = 8000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}/`;

let server;
let browser;
let ctx;
let page;
const errors = [];

const ready = (p) =>
  p.waitForFunction(() => ["ready", "error"].includes(window.__field?.state.detectorState.state), null, { timeout: 240_000 });

before(async () => {
  const built = spawnSync(process.execPath, ["scripts/build-manifest.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  server = spawn(process.execPath, ["scripts/serve.mjs", "--no-build", "--port", String(PORT)], { cwd: root, stdio: "pipe" });
  await new Promise((r) => server.stdout.once("data", r));
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL_);
  await ready(page);
});

after(async () => {
  await browser?.close();
  server?.kill();
});

test("first visit: app is saved for offline use and the model loads on-device", async () => {
  const s = await page.evaluate(() => ({
    det: window.__field.state.detectorState.state,
    offline: window.__field.state.offline.state,
    isolated: self.crossOriginIsolated,
    controlled: !!navigator.serviceWorker.controller,
  }));
  assert.deepEqual(s, { det: "ready", offline: "ready", isolated: true, controlled: true });
  assert.deepEqual(errors, []);
});

test("the browser detector matches the Python reference on real photos", async () => {
  const ref = JSON.parse(readFileSync(fixture("python-reference.json"), "utf8"));
  const imgs = Object.fromEntries(Object.keys(ref).map((n) => [n, readFileSync(fixture(n)).toString("base64")]));
  const got = await page.evaluate(async (imgs) => {
    const { Detector } = await import("./js/perception/detector.js");
    const d = new Detector();
    await d.load();
    const out = {};
    for (const [n, b64] of Object.entries(imgs)) {
      const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/jpeg" });
      const r = await d.detect(await createImageBitmap(blob), { scoreThreshold: 0.25 });
      out[n] = r.detections;
    }
    return out;
  }, imgs);
  for (const [n, expected] of Object.entries(ref)) {
    for (const e of expected) {
      const m = got[n].find((g) => g.prompt === e.prompt && e.box.every((v, i) => Math.abs(v - g.box[i]) < 8));
      assert.ok(m, `${n}: no browser match for ${e.prompt} ${e.box}`);
      assert.ok(Math.abs(m.score - e.score) < 0.05, `${n}: score ${m.score} vs ${e.score}`);
    }
  }
});

test("simulated building: the lobby answer is the west exit, and the dead end routes back", async () => {
  await page.click("#btn-sim");
  await page.click("#btn-sim-end");
  await page.waitForFunction(() => window.__field.state.mode === "idle");
  await page.click(`#quick button[data-q^="Which exit"]`);
  assert.equal(await page.textContent("#answer .headline"), "No usable exit seen in this area.");
  assert.match(await page.textContent("#answer .lines"), /the west exit in Lobby\. Go back through the north exit you came in by/);
  await page.click(".building .zone >> nth=0");
  await page.waitForTimeout(400);
  assert.equal(await page.textContent("#answer .headline"), "Take the west exit - about 10 m, bearing 270°.");
});

test("nothing can be sent off the device: the policy blocks it", async () => {
  const outcome = await page.evaluate(async () => {
    try {
      await fetch("https://example.com/", { mode: "no-cors" });
      return "sent";
    } catch {
      return "blocked";
    }
  });
  assert.equal(outcome, "blocked");
});

test("airplane mode: reload, load the model from the device, see people in a photo, send nothing", async () => {
  await page.waitForTimeout(1600); // let the throttled save land
  await ctx.setOffline(true);
  await page.reload();
  await ready(page);
  await page.setInputFiles("#photo", fixture("coco-049.jpg"));
  await page.waitForFunction(() => window.__field.state.lastDets.length > 0, null, { timeout: 60_000 });
  const s = await page.evaluate(() => ({
    online: navigator.onLine,
    det: window.__field.state.detectorState.state,
    people: window.__field.state.lastDets.filter((d) => d.kind === "person").length,
    sinceReady: window.__field.state.net.requests - window.__field.state.net.installRequests,
    zones: window.__field.state.model.zones.map((z) => z.name),
  }));
  assert.equal(s.online, false);
  assert.equal(s.det, "ready");
  assert.ok(s.people >= 5, `people ${s.people}`);
  assert.equal(s.sinceReady, 0);
  assert.ok(s.zones.includes("Lobby"), "the situation model survived the reload");
  assert.match(await page.textContent("#pp-sent"), /^0 network requests since FIELD became ready/);
});

test("live camera: frames from the camera are detected, placed and counted", async () => {
  const cam = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${fixture("camera.y4m")}`],
  });
  try {
    const p = await (await cam.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await p.goto(URL_);
    await ready(p);
    await p.click("#btn-camera");
    await p.waitForFunction(
      () => [...window.__field.state.model.entities.values()].some((e) => e.kind === "person" && e.sightings >= 2),
      null,
      { timeout: 120_000 },
    );
    const s = await p.evaluate(() => ({
      mode: window.__field.state.mode,
      source: window.__field.state.model.zone.headingSource,
      ms: window.__field.state.frameMs,
    }));
    assert.equal(s.mode, "camera");
    // headless Chromium has no compass, so directions must be relative, and say so
    assert.equal(s.source, "relative");
    assert.ok(s.ms > 0);
    await p.click(`#quick button[data-q^="Is anyone"]`);
    assert.match(await p.textContent("#answer .headline"), /^1 person seen here/);
  } finally {
    await cam.close();
  }
});
