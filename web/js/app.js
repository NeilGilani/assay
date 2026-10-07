// FIELD - the page. Wires the camera, the compass and the on-device detector
// into the situation model, and the model into answers, the map and the list.
// No decision is made in this file; it only moves data between the pieces
// and draws them.

import { SituationModel, evidence } from "./model.js";
import { assess, evidenceText, fmtDist } from "./reason.js";
import { answer, handoff } from "./ask.js";
import { CATEGORY, KINDS, kindInfo } from "./ontology.js";
import { Detector } from "./perception/detector.js";
import { Heading } from "./sensors.js";
import { coverTransform, drawOverlay, sizeCanvas } from "./ui/overlay.js";
import { drawMap } from "./ui/map.js";
import { drawSim } from "./ui/simview.js";
import { SCENARIO, scenarioFrames } from "./scenario.js";
import { directionName, norm360 } from "./geometry.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "field.model.v1";
const SETTINGS_KEY = "field.settings.v1";

const settings = Object.assign(
  {
    // lens field of view along the long side: phone main cameras ~65, webcams ~60
    fovLong: matchMedia("(pointer: coarse)").matches ? 65 : 60,
    headingMode: "auto",
    manualHeading: 0,
  },
  safeJSON(() => localStorage.getItem(SETTINGS_KEY)) ?? {},
);

const state = {
  model: restoreModel() ?? new SituationModel(),
  detector: new Detector(),
  heading: new Heading(),
  mode: "idle", // idle | camera | sim | photo
  scanning: true,
  lastDets: [],
  lastSize: null,
  lastHeading: null,
  hfov: null,
  frameMs: null,
  question: null,
  answer: null,
  selected: null,
  highlight: new Set(),
  hits: [],
  net: { online: navigator.onLine, requests: 0, bytes: 0, refused: 0, blocked: 0, installRequests: 0, readyAt: null },
  offline: { state: "checking", done: 0, total: 0, bytes: 0, totalBytes: 0, version: null, reason: null },
  detectorState: { state: "loading", p: 0, info: null, error: null },
  stream: null,
};
state.heading.mode = settings.headingMode;
state.heading.manual = settings.manualHeading;
state.model.fovLong = settings.fovLong;

const video = $("video");
const overlay = $("overlay");
const sim = $("sim");
const snap = document.createElement("canvas");

function safeJSON(read) {
  try {
    const raw = read();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function restoreModel() {
  const data = safeJSON(() => localStorage.getItem(STORE_KEY));
  try {
    return data ? SituationModel.fromJSON(data) : null;
  } catch {
    return null;
  }
}

let saveTimer = null;
function save() {
  // throttled, not debounced: a stream of frames must not postpone the save forever
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1500);
}

function saveNow() {
  {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.model));
    } catch {
      // storage full: keep the model, drop the thumbnails
      try {
        const lean = state.model.toJSON();
        lean.entities = lean.entities.map((e) => ({ ...e, thumb: null }));
        localStorage.setItem(STORE_KEY, JSON.stringify(lean));
      } catch {
        /* nothing more to do; the model lives on in memory */
      }
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- rendering

let renderQueued = false;
function changed() {
  save();
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 250);
}

function render() {
  const now = Date.now();
  const a = assess(state.model, { now });
  if (state.question) renderAnswer(answer(state.model, state.question, { now }), false);
  renderMap(a);
  renderBuilding();
  renderEntities(a);
  renderHud();
  $("incident").value = state.model.incident;
}

function renderAnswer(ans, fresh) {
  state.answer = ans;
  const card = $("answer");
  card.querySelector(".headline").textContent = ans.headline;
  const ul = card.querySelector(".lines");
  ul.replaceChildren(
    ...ans.lines.map((l) => {
      const li = document.createElement("li");
      li.className = l.tone;
      const span = document.createElement("span");
      span.textContent = l.text;
      if (l.evidence.length) {
        const b = document.createElement("button");
        b.className = "ev";
        b.type = "button";
        b.textContent = "show";
        b.title = "Show what this is based on";
        b.addEventListener("click", () => {
          state.highlight = new Set(l.evidence);
          state.selected = l.evidence[0];
          changed();
          $("map").scrollIntoView({ behavior: "smooth", block: "center" });
        });
        span.append(" ", b);
      }
      li.append(span);
      return li;
    }),
  );
  const conf = $("answer-conf");
  const c = ans.intent === "exit" ? ans.assessment.recommendation.confidence : null;
  conf.className = `conf ${c ?? ""}`;
  conf.textContent = c && c !== "none" ? `Confidence: ${c}` : ans.intent !== "unknown" ? "Live: updates as you scan" : "";
  if (fresh) {
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
  }
}

function renderMap(a) {
  const zone = state.model.zone;
  $("map-title").textContent = zone ? `${zone.name}${zone.headingSource === "relative" ? " (relative directions)" : ""}` : "Area";
  const live = state.mode === "camera" || state.mode === "sim";
  state.hits = drawMap($("map"), a, zone, {
    heading: live ? state.lastHeading : null,
    hfov: state.hfov,
    selected: state.selected,
    highlight: state.highlight,
  });
  const rec = a.recommendation;
  let note = "";
  if (rec.exit) note = `Best way out: ${rec.exit.name} (${rec.exit.status}). `;
  else if (rec.route) note = `No usable exit here; nearest known is the ${rec.route.exit.name} in ${rec.route.zone.name}. `;
  $("map-note").textContent = zone ? note + a.coverage.text : "";
}

function renderBuilding() {
  const el = $("building");
  const parts = [];
  for (const z of state.model.zones) {
    const a = assess(state.model, { zoneId: z.id, followRoute: false });
    if (z.from) {
      const via = z.via ? state.model.entities.get(z.via) : null;
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = via ? `→ via ${directionName(via.bearing, a.zone?.relative)} ${kindInfo(via.kind).name} →` : "→";
      parts.push(arrow);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = `zone${z.id === state.model.currentZoneId ? " current" : ""}`;
    const ok = a.exits.filter((x) => x.status === "clear").length;
    const blocked = a.exits.filter((x) => x.status === "blocked").length;
    const name = document.createElement("b");
    name.textContent = z.name;
    const l1 = document.createElement("span");
    l1.textContent = `${a.exits.length} exits: ${ok} clear, ${blocked} blocked`;
    const l2 = document.createElement("span");
    l2.textContent = `${a.hazards.filter((h) => h.level !== "glimpsed").length} hazards · ${Math.max(a.people.likely, a.people.atLeast)} people`;
    b.append(name, l1, l2);
    b.addEventListener("click", () => {
      state.model.currentZoneId = z.id;
      changed();
    });
    parts.push(b);
  }
  el.replaceChildren(...parts);
}

const GROUPS = [
  ["Exits and doors", (k) => kindInfo(k).category === CATEGORY.EGRESS],
  ["Hazards", (k) => kindInfo(k).category === CATEGORY.HAZARD],
  ["People", (k) => kindInfo(k).category === CATEGORY.PERSON],
  ["Equipment", (k) => kindInfo(k).category === CATEGORY.RESOURCE],
  ["Other", (k) => kindInfo(k).category === CATEGORY.INFRA],
];

function renderEntities(a) {
  const zone = state.model.zone;
  const box = $("entities");
  if (!zone) {
    box.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "Nothing yet. Start the camera and pan slowly all the way round." }));
    return;
  }
  const relative = zone.headingSource === "relative";
  const all = state.model.entitiesIn(zone.id, { includeDismissed: true });
  const out = [];
  for (const [title, test] of GROUPS) {
    const items = all.filter((e) => test(e.kind)).sort((p, q) => (p.verdict === "dismissed") - (q.verdict === "dismissed") || (p.distance ?? 99) - (q.distance ?? 99));
    if (!items.length) continue;
    out.push(Object.assign(document.createElement("h2"), { className: "group", textContent: title }));
    for (const e of items) out.push(entityRow(e, a, relative));
  }
  if (!out.length) out.push(Object.assign(document.createElement("p"), { className: "empty", textContent: "Nothing recognised in this area yet." }));
  box.replaceChildren(...out);
}

function entityRow(e, a, relative) {
  const info = kindInfo(e.kind);
  const lvl = evidence(e);
  const row = document.createElement("div");
  row.className = `entity${state.selected === e.id ? " selected" : ""}${lvl === "dismissed" ? " dismissed" : ""}`;
  row.dataset.id = e.id;
  const th = document.createElement("div");
  th.className = "thumb";
  if (e.thumb) th.style.backgroundImage = `url("${e.thumb}")`;
  else th.textContent = e.manual ? "you" : info.name.slice(0, 4);
  const txt = document.createElement("div");
  const nm = document.createElement("div");
  nm.className = "name";
  let extra = "";
  if (e.posture === "down") extra = " · may be on the floor";
  const exit = a.exits.find((x) => x.members.some((m) => m.id === e.id));
  if (exit) extra = ` · ${exit.status}`;
  nm.textContent = `${info.name}${extra}`;
  const meta = document.createElement("div");
  meta.className = `meta ev-${lvl}`;
  const d = fmtDist(e.distance);
  const ago = Math.round((Date.now() - e.lastSeen) / 1000);
  meta.textContent = `${directionName(e.bearing, relative)}${d ? `, ${d}` : ", range unknown"} · ${
    lvl === "dismissed" ? "dismissed by you" : evidenceText({ e, level: lvl })
  } · ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)} min`} ago`;
  txt.append(nm, meta);
  const acts = document.createElement("div");
  acts.className = "acts";
  const btn = (label, on, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (on) b.classList.add("on");
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fn();
      changed();
    });
    acts.append(b);
  };
  if (lvl === "dismissed") btn("Restore", false, () => state.model.restore(e.id));
  else {
    btn("Confirm", e.verdict === "confirmed", () => (e.verdict === "confirmed" ? state.model.restore(e.id) : state.model.confirm(e.id)));
    btn("Not this", false, () => state.model.dismiss(e.id));
    if (info.category === CATEGORY.PERSON) {
      btn("Needs help", e.attrs.status === "needs_help", () => state.model.setAttr(e.id, "status", e.attrs.status === "needs_help" ? null : "needs_help"));
      btn("OK", e.attrs.status === "ok", () => state.model.setAttr(e.id, "status", e.attrs.status === "ok" ? null : "ok"));
    }
    if (info.category === CATEGORY.EGRESS) {
      btn("Blocked", e.attrs.state === "blocked", () => state.model.setAttr(e.id, "state", e.attrs.state === "blocked" ? null : "blocked"));
      btn("Clear", e.attrs.state === "clear", () => state.model.setAttr(e.id, "state", e.attrs.state === "clear" ? null : "clear"));
      if (e.kind === "door") btn("It's an exit", e.attrs.isExit === true, () => state.model.setAttr(e.id, "isExit", e.attrs.isExit ? null : true));
    }
  }
  row.append(th, txt, acts);
  row.addEventListener("click", () => {
    state.selected = state.selected === e.id ? null : e.id;
    state.highlight = new Set();
    changed();
  });
  return row;
}

function renderHud() {
  const h = state.heading.current();
  let text;
  if (state.mode === "sim" && state.lastHeading != null) text = `${Math.round(state.lastHeading)}° ${directionName(state.lastHeading).toUpperCase()}`;
  else if (h.source === "compass") text = `${Math.round(h.heading)}° ${directionName(h.heading).toUpperCase()}`;
  else if (h.source === "manual") text = `Facing ${Math.round(h.heading)}° (manual)`;
  else text = "No compass: directions relative to view";
  $("hud-heading").textContent = state.mode === "idle" ? "" : text;
  $("hud-rate").textContent = state.mode === "sim" ? "simulated" : state.frameMs ? `${Math.round(state.frameMs)} ms/frame` : "";
}

// ---------------------------------------------------------------- proof panel

function renderProof() {
  const n = state.net;
  const online = navigator.onLine;
  const pillNet = $("pill-net");
  pillNet.className = `pill ${online ? "" : "off"}`;
  pillNet.querySelector("b").textContent = online ? "Online, unused" : "Offline";
  const d = state.detectorState;
  const pillField = $("pill-field");
  pillField.className = `pill ${d.state === "ready" ? "ok" : d.state === "error" ? "bad" : "warn"}`;
  pillField.querySelector("b").textContent =
    d.state === "ready" ? `On-device · ${d.info.backend.toUpperCase()}` : d.state === "error" ? "Model failed" : `Loading ${Math.round(d.p * 100)}%`;
  const since = n.readyAt ? n.requests - n.installRequests : 0;
  const pillSent = $("pill-sent");
  pillSent.className = `pill ${since === 0 && !n.refused && !n.blocked ? "ok" : "warn"}`;
  pillSent.querySelector("b").textContent = `${since} sent`;

  $("pp-net").textContent = online ? "Online. FIELD does not use it." : "Offline. No route to the internet.";
  $("pp-cloud").textContent = online ? "Not used. FIELD has no cloud backend to call." : "Unavailable.";
  $("pp-cloud").className = online ? "" : "big";
  const info = d.info;
  $("pp-field").textContent =
    d.state === "ready"
      ? `${online ? "Running" : "Still running"}, on this device: ${info.backend === "webgpu" ? "GPU (WebGPU)" : `CPU (WASM, ${info.threads} thread${info.threads === 1 ? "" : "s"})`}${state.frameMs ? `, ${Math.round(state.frameMs)} ms per frame` : ""}. Model verified (sha256 ${info.sha256.slice(0, 12)}).`
      : d.state === "error"
        ? `Model failed to load: ${d.error}. The simulated building still works.`
        : `Loading the model: ${Math.round(d.p * 100)}%`;
  $("pp-field").className = "big";
  $("pp-sent").textContent = `${since} network request${since === 1 ? "" : "s"} since FIELD became ready. Camera frames sent: none - no code path sends them, and the policy below would block it.${
    n.refused || n.blocked ? ` Refused or blocked attempts: ${n.refused + n.blocked}.` : ""
  }`;
  const o = state.offline;
  $("pp-offline").textContent =
    o.state === "ready"
      ? `Saved on this device: ${o.total} files, ${(o.totalBytes / 1e6).toFixed(0)} MB (version ${o.version}). Works in airplane mode.`
      : o.state === "saving"
        ? `Saving for offline use: ${o.done} of ${o.total} files.`
        : o.state === "none"
          ? `Not saved for offline use: ${o.reason}`
          : "Checking...";
}

// ---------------------------------------------------------------- offline install

async function ensureOffline() {
  if (!("serviceWorker" in navigator)) {
    state.offline = { ...state.offline, state: "none", reason: "this browser has no service workers." };
    return;
  }
  navigator.serviceWorker.addEventListener("message", (ev) => {
    const m = ev.data ?? {};
    if (m.type === "precache") {
      Object.assign(state.offline, { state: "saving", done: m.done, total: m.total, totalBytes: m.totalBytes, version: m.version });
      setStatus(`Saving FIELD for offline use: ${Math.round((m.done / m.total) * 100)}%`);
    } else if (m.type === "network") {
      Object.assign(state.net, { requests: m.requests, bytes: m.bytes, refused: m.refused });
    } else if (m.type === "status") {
      Object.assign(state.net, { requests: m.network.requests, bytes: m.network.bytes, refused: m.network.refused });
      if (m.complete) Object.assign(state.offline, { state: "ready", total: m.total, totalBytes: m.totalBytes, version: m.version });
    }
    renderProof();
  });
  try {
    const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
    const sw = reg.installing ?? reg.waiting ?? reg.active;
    if (sw && sw.state !== "activated") {
      await new Promise((resolve, reject) => {
        sw.addEventListener("statechange", () => {
          if (sw.state === "activated") resolve();
          if (sw.state === "redundant") reject(new Error("could not save the app (were you offline on first visit?)"));
        });
      });
    }
    (reg.active ?? sw)?.postMessage({ type: "status" });
  } catch (err) {
    state.offline = { ...state.offline, state: "none", reason: String(err.message ?? err) };
  }
}

function setStatus(text) {
  $("start-status").textContent = text;
}

async function loadDetector() {
  try {
    const info = await state.detector.load({
      onProgress: (m) => {
        state.detectorState.p = m.phase === "model" ? m.p * 0.9 : 0.95;
        setStatus(m.phase === "model" ? `Loading the on-device model: ${Math.round(m.p * 100)}%` : "Preparing the model...");
        renderProof();
      },
    });
    state.detectorState = { state: "ready", p: 1, info, error: null };
    state.net.readyAt = Date.now();
    state.net.installRequests = state.net.requests;
    setStatus(`Ready. Model runs on this device (${info.backend === "webgpu" ? "GPU" : "CPU"}); nothing is uploaded.`);
    $("btn-camera").disabled = false;
    $("photo").disabled = false;
  } catch (err) {
    state.detectorState = { state: "error", p: 0, info: null, error: String(err.message ?? err) };
    setStatus(`The detector could not load (${state.detectorState.error}). The simulated building still works.`);
  }
  renderProof();
}

// ---------------------------------------------------------------- frames in

function cropThumb(src, box) {
  const [x0, y0, x1, y1] = box;
  const pad = 0.12;
  const w = x1 - x0;
  const h = y1 - y0;
  const side = Math.max(w, h) * (1 + pad * 2);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const c = document.createElement("canvas");
  c.width = c.height = 104;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 104, 104);
  ctx.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, 104, 104);
  try {
    return c.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}

function ingest(frame, detections, src) {
  const res = state.model.ingest({ ...frame, detections, crop: src ? (box) => cropThumb(src, box) : undefined });
  state.lastDets = detections;
  state.lastSize = [frame.width, frame.height];
  if (!res.skipped) {
    state.lastHeading = res.heading;
    state.hfov = res.hfov;
  }
  drawOverlay(overlay, detections, frame.width, frame.height, { minScore: (k) => state.model.minScore(k) });
  changed();
}

function grab(source, w, h) {
  const k = Math.min(1, 960 / Math.max(w, h));
  snap.width = Math.round(w * k);
  snap.height = Math.round(h * k);
  snap.getContext("2d").drawImage(source, 0, 0, snap.width, snap.height);
  return snap;
}

async function cameraLoop() {
  if (state.mode !== "camera") return;
  if (state.scanning && state.detector.ready && !state.detector.busy && video.readyState >= 2 && video.videoWidth) {
    const h = state.heading.current();
    const t = Date.now();
    const t0 = performance.now();
    const src = grab(video, video.videoWidth, video.videoHeight);
    try {
      const r = await state.detector.detect(src);
      if (r && state.mode === "camera") {
        state.frameMs = performance.now() - t0;
        ingest({ t, width: r.width, height: r.height, heading: h.heading, pitch: h.pitch, fovLong: settings.fovLong }, r.detections, src);
      }
    } catch (err) {
      setStatus(`Detector error: ${err.message}`);
    }
  }
  renderProof();
  setTimeout(cameraLoop, 30);
}

async function startCamera() {
  await state.heading.start();
  stopSim();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    setStatus(`Camera unavailable: ${err.message}. Try "Analyse a photo" or the simulated building.`);
    return;
  }
  state.mode = "camera";
  sim.hidden = true;
  video.hidden = false;
  $("start").hidden = true;
  $("sim-label").hidden = true;
  $("btn-scan").disabled = false;
  if (!state.model.zone) state.model.newZone({ t: Date.now() });
  cameraLoop();
  changed();
}

function stopCamera() {
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  if (state.mode === "camera") state.mode = "idle";
}

async function analysePhoto(file) {
  await state.heading.start();
  stopSim();
  stopCamera();
  const bmp = await createImageBitmap(file);
  const src = grab(bmp, bmp.width, bmp.height);
  state.mode = "photo";
  video.hidden = true;
  sim.hidden = false;
  $("start").hidden = true;
  $("sim-label").hidden = true;
  sizeCanvas(sim);
  const ctx = sim.getContext("2d");
  const { s, ox, oy } = coverTransform(src.width, src.height, sim.width, sim.height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, sim.width, sim.height);
  ctx.drawImage(src, ox, oy, src.width * s, src.height * s);
  if (!state.detector.ready) return;
  const h = state.heading.current();
  const t0 = performance.now();
  const r = await state.detector.detect(src);
  state.frameMs = performance.now() - t0;
  if (!state.model.zone) state.model.newZone({ t: Date.now() });
  ingest({ t: Date.now(), width: r.width, height: r.height, heading: h.heading, pitch: h.pitch, fovLong: settings.fovLong }, r.detections, src);
}

// ---------------------------------------------------------------- simulation

let simRun = 0;
function stopSim() {
  simRun += 1;
  if (state.mode === "sim") state.mode = "idle";
  $("btn-sim-end").hidden = true;
}

function showSources() {
  stopSim();
  stopCamera();
  state.mode = "idle";
  drawOverlay(overlay, [], 0, 0);
  $("start").hidden = false;
  $("sim-label").hidden = true;
  $("btn-scan").disabled = true;
  changed();
}

async function runSim() {
  stopCamera();
  const run = ++simRun;
  state.mode = "sim";
  state.simFast = false;
  state.model = new SituationModel({ incident: SCENARIO.incident, fovLong: settings.fovLong });
  state.question = "Which exit is safest?";
  state.selected = null;
  state.highlight = new Set();
  video.hidden = true;
  sim.hidden = false;
  $("start").hidden = true;
  $("sim-label").hidden = false;
  $("btn-scan").disabled = false;
  $("sim-label").textContent = "Simulated: scripted detections, not a camera";
  $("btn-sim-end").hidden = false;
  for (const step of scenarioFrames(SCENARIO, { t0: Date.now() })) {
    if (run !== simRun) return;
    if (step.type === "zone") {
      state.model.newZone({ name: step.name, t: Date.now() });
      continue;
    }
    while (!state.scanning && run === simRun) await sleep(200);
    const f = { ...step.frame, t: Date.now() };
    if (!state.simFast) drawSim(sim, f);
    ingest(f, f.detections, null);
    if (!state.simFast) await sleep(200);
  }
  if (run !== simRun) return;
  drawOverlay(overlay, [], 0, 0);
  $("btn-sim-end").hidden = true;
  $("sim-label").textContent = "Simulated walk-through complete";
  state.mode = "idle";
  changed();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- wiring

function ask(q) {
  if (!q.trim()) return;
  state.question = q;
  const ans = answer(state.model, q, { now: Date.now() });
  renderAnswer(ans, true);
  changed();
}

function localVoice() {
  if (!("speechSynthesis" in window)) return null;
  // Only on-device voices: a network voice would send the answer off the phone.
  return speechSynthesis.getVoices().find((v) => v.localService && /^en/i.test(v.lang)) ?? null;
}

function speak() {
  const v = localVoice();
  if (!v || !state.answer) {
    $("answer-conf").textContent = "No on-device voice available on this browser.";
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(state.answer.speech);
  u.voice = v;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

function wire() {
  $("btn-camera").disabled = true;
  $("photo").disabled = true;
  $("btn-camera").addEventListener("click", startCamera);
  $("btn-sim").addEventListener("click", runSim);
  $("btn-sim-end").addEventListener("click", () => (state.simFast = true));
  $("btn-source").addEventListener("click", showSources);
  $("photo").addEventListener("change", (e) => e.target.files[0] && analysePhoto(e.target.files[0]));
  $("btn-scan").addEventListener("click", () => {
    state.scanning = !state.scanning;
    $("btn-scan").textContent = state.scanning ? "Pause scan" : "Resume scan";
    $("btn-scan").setAttribute("aria-pressed", String(state.scanning));
  });
  $("btn-zone").addEventListener("click", () => {
    state.model.newZone({ t: Date.now() });
    state.selected = null;
    changed();
  });
  $("map-title").addEventListener("click", () => {
    const z = state.model.zone;
    if (!z) return;
    const name = prompt("Name this area", z.name);
    if (name) {
      z.name = name.slice(0, 40);
      changed();
    }
  });
  $("incident").addEventListener("change", (e) => {
    state.model.incident = e.target.value;
    changed();
  });
  $("heading-mode").value = settings.headingMode === "auto" ? "auto" : settings.headingMode;
  $("manual-heading").hidden = settings.headingMode !== "manual";
  $("manual-value").textContent = `${settings.manualHeading}°`;
  $("heading-mode").addEventListener("change", (e) => {
    settings.headingMode = e.target.value;
    state.heading.mode = e.target.value;
    $("manual-heading").hidden = e.target.value !== "manual";
    changed();
  });
  for (const b of document.querySelectorAll("[data-turn]")) {
    b.addEventListener("click", () => {
      settings.manualHeading = norm360(settings.manualHeading + Number(b.dataset.turn));
      state.heading.manual = settings.manualHeading;
      $("manual-value").textContent = `${settings.manualHeading}°`;
      changed();
    });
  }
  for (const b of document.querySelectorAll("#quick button")) b.addEventListener("click", () => ask(b.dataset.q));
  $("askform").addEventListener("submit", (e) => {
    e.preventDefault();
    ask($("question").value);
    $("question").value = "";
  });
  $("btn-speak").addEventListener("click", speak);
  $("map").addEventListener("click", (e) => {
    const r = e.target.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const hit = state.hits.find((h) => Math.hypot(h.x - x, h.y - y) <= h.r);
    state.selected = hit?.id ?? null;
    state.highlight = new Set();
    changed();
    if (hit) document.querySelector(`.entity[data-id="${hit.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("proof").addEventListener("click", () => {
    const p = $("proof-panel");
    p.hidden = !p.hidden;
    $("proof").setAttribute("aria-expanded", String(!p.hidden));
  });
  const kinds = $("add-kind");
  for (const [k, info] of Object.entries(KINDS)) kinds.append(new Option(info.name, k));
  $("btn-add").addEventListener("click", () => ($("add").hidden = !$("add").hidden));
  $("add-go").addEventListener("click", () => {
    const h = state.heading.current();
    const range = $("add-range").value;
    state.model.addManual({ kind: kinds.value, bearing: h.heading ?? 0, distance: range ? Number(range) : null, t: Date.now() });
    if (state.model.zone && !state.model.zone.headingSource) state.model.zone.headingSource = h.heading == null ? "relative" : "compass";
    $("add").hidden = true;
    changed();
  });
  $("btn-report").addEventListener("click", async () => {
    const text = handoff(state.model, { now: Date.now() });
    const pre = $("report");
    pre.textContent = text;
    pre.hidden = false;
    try {
      await navigator.clipboard.writeText(text);
      $("btn-report").textContent = "Handoff report (copied)";
    } catch {
      /* clipboard may be unavailable; the text is on screen */
    }
  });
  $("btn-reset").addEventListener("click", () => {
    if (!confirm("Clear everything FIELD has seen?")) return;
    stopSim();
    state.model = new SituationModel({ incident: state.model.incident, fovLong: settings.fovLong });
    state.question = null;
    state.selected = null;
    state.highlight = new Set();
    $("answer").querySelector(".headline").textContent = "Scan the space, then ask.";
    $("answer").querySelector(".lines").replaceChildren();
    $("report").hidden = true;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* ignore */
    }
    changed();
  });
  addEventListener("pagehide", saveNow);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && saveNow());
  addEventListener("online", renderProof);
  addEventListener("offline", renderProof);
  document.addEventListener("securitypolicyviolation", () => {
    state.net.blocked += 1;
    renderProof();
  });
  addEventListener("resize", () => {
    changed();
    if (state.lastSize) drawOverlay(overlay, state.lastDets, ...state.lastSize, { minScore: (k) => state.model.minScore(k) });
  });
  setInterval(() => {
    renderProof();
    renderHud();
  }, 1000);
}

async function boot() {
  wire();
  render();
  renderProof();
  setStatus("Saving FIELD for offline use...");
  await ensureOffline();
  renderProof();
  await loadDetector();
  // a test hook, read-only: lets the end-to-end suite check what the page believes
  window.__field = { state, assess: () => assess(state.model) };
}

boot();
