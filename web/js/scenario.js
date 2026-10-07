// A building with a known answer.
//
// FIELD's reasoning cannot be checked against a real building at a hackathon,
// so this is the next best thing: a scripted walk-through where the truth is
// written down first, then turned into exactly what the camera pipeline would
// produce - detector boxes in pixel coordinates, at the bearings and sizes a
// real lens would see them, with misses, jitter and one planted false alarm.
//
// Those boxes go through the *same* fusion and reasoning as live camera frames.
// Nothing downstream knows it is a simulation, which is what makes it a test:
// if the reasoner says the east exit is blocked here, it is because the
// geometry of the boxes put debris in front of it, not because a script said so.
//
// The UI labels this mode SIMULATED on every frame.

import { angleDiff, cameraModel, pixelOfBearing, rowOfFloor } from "./geometry.js";

// h: real height (m) or, for floor things, depth; w: real width (m)
// lift: height of the object's bottom above the floor (m)
// floor: drawn as lying on the floor; posture "down" for a person lying down
// once: appears in a single frame only (the planted false alarm)
const LOBBY = [
  { kind: "door", bearing: 90, d: 9, w: 1.0, h: 2.03 },
  { kind: "exit_sign", bearing: 90, d: 9, w: 0.4, h: 0.25, lift: 2.2 },
  { kind: "debris", bearing: 88, d: 7, w: 1.6, h: 0.5, floor: true },

  { kind: "door", bearing: 0, d: 12, w: 1.0, h: 2.03 },
  { kind: "exit_sign", bearing: 0, d: 12, w: 0.4, h: 0.25, lift: 2.2 },
  { kind: "water", bearing: 350, d: 6, w: 2.2, h: 0.2, floor: true },
  { kind: "electrical_panel", bearing: 335, d: 6.5, w: 0.6, h: 0.9, lift: 1.0 },

  { kind: "door", bearing: 270, d: 10, w: 1.0, h: 2.03 },
  { kind: "exit_sign", bearing: 270, d: 10, w: 0.4, h: 0.25, lift: 2.2 },

  { kind: "elevator", bearing: 45, d: 7, w: 1.2, h: 2.1 },
  { kind: "person", bearing: 200, d: 5, w: 1.7, h: 0.45, floor: true, posture: "down" },
  { kind: "person", bearing: 232, d: 6, w: 0.5, h: 1.7 },
  { kind: "extinguisher", bearing: 300, d: 3.5, w: 0.2, h: 0.6, lift: 0.5 },
  { kind: "first_aid", bearing: 180, d: 4, w: 0.35, h: 0.3, lift: 1.2 },

  { kind: "fire", bearing: 248, d: 8, w: 0.5, h: 0.5, lift: 1.5, once: true, score: 0.41 },
];

const STAIR_LOBBY = [
  { kind: "stairs", bearing: 10, d: 6, w: 1.4, h: 1.0, floor: true },
  { kind: "exit_sign", bearing: 10, d: 6, w: 0.4, h: 0.25, lift: 2.2 },
  { kind: "debris", bearing: 8, d: 4.5, w: 1.8, h: 0.6, floor: true },
  { kind: "smoke", bearing: 322, d: 5, w: 1.5, h: 1.0, lift: 1.4 },
  { kind: "person", bearing: 328, d: 4, w: 0.5, h: 1.7 },
  { kind: "exposed_wires", bearing: 120, d: 3, w: 0.6, h: 0.6, lift: 1.6 },
];

function range(from, to, step) {
  const out = [];
  for (let h = from; h <= to; h += step) out.push(h);
  return out;
}

export const SCENARIO = Object.freeze({
  name: "Earthquake, Building C",
  incident: "earthquake",
  zones: [
    // The south-east (roughly 120-150 degrees) is never pointed at, on purpose:
    // FIELD should notice, and say so.
    // Panned in 5-degree steps: a phone at ~5 analysed frames a second, turned
    // at a walking-pace 25 degrees a second.
    { name: "Lobby", objects: LOBBY, sweep: [...range(0, 100, 5), ...range(170, 355, 5), 0] },
    { name: "Stair lobby", objects: STAIR_LOBBY, sweep: range(0, 355, 5) },
  ],
});

/** Small deterministic PRNG so the simulation is identical every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where an object would appear in a frame taken at `heading`, or null if out of shot. */
export function project(obj, heading, cam, { cameraHeightM = 1.4, jitter = () => 0 } = {}) {
  const bearing = obj.bearing + jitter() * 0.8;
  const cx = pixelOfBearing(bearing, heading, cam);
  if (cx == null) return null;
  const scale = cam.focal / obj.d;
  const w = obj.w * scale * (1 + jitter() * 0.04);
  let y0;
  let y1;
  if (obj.floor) {
    // near edge on the floor, depth foreshortened
    y1 = rowOfFloor(obj.d - obj.w / 4, cam, 0, cameraHeightM);
    y0 = y1 - Math.max(obj.h * scale, 12);
  } else {
    const lift = obj.lift ?? 0;
    y1 = cam.height / 2 + (cameraHeightM - lift) * scale;
    y0 = y1 - obj.h * scale * (1 + jitter() * 0.04);
  }
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  // only whole objects; a box cut by the frame edge would be measured wrong
  if (x0 < 2 || x1 > cam.width - 2 || y0 < cam.height * 0.012 || y1 > cam.height * 0.985) return null;
  return [x0, y0, x1, y1];
}

/**
 * The walk-through as a stream of steps:
 *   { type: "zone", name }                    responder moves to a new area
 *   { type: "frame", frame, truth }           one analysed camera frame
 */
export function* scenarioFrames(scn = SCENARIO, { seed = 7, width = 720, height = 1280, fovLong = 65, t0 = 0, dt = 200 } = {}) {
  const rand = mulberry32(seed);
  const jitter = () => rand() * 2 - 1;
  const cam = cameraModel(width, height, fovLong);
  let t = t0;
  for (const zone of scn.zones) {
    yield { type: "zone", name: zone.name, t };
    const shown = new Set();
    for (const heading of zone.sweep) {
      t += dt;
      const detections = [];
      const truth = [];
      for (const obj of zone.objects) {
        if (Math.abs(angleDiff(obj.bearing, heading)) > cam.hfov / 2) continue;
        if (obj.once && shown.has(obj)) continue;
        const box = project(obj, heading, cam, { jitter });
        if (!box) continue;
        truth.push(obj);
        // the detector misses things: about one sighting in eight
        if (!obj.once && rand() < 0.12) continue;
        const score = obj.score ?? Math.min(0.95, 0.55 + rand() * 0.3);
        detections.push({ kind: obj.kind, score, box });
        if (obj.once) shown.add(obj);
      }
      yield {
        type: "frame",
        truth,
        frame: { t, width, height, heading: heading + jitter() * 1.5, pitch: 0, fovLong, detections, synthetic: true },
      };
    }
  }
}

/** Run the whole scenario into a model (used by tests and the demo button). */
export function runScenario(model, scn = SCENARIO, opts = {}) {
  model.incident = scn.incident;
  let last = null;
  for (const step of scenarioFrames(scn, opts)) {
    if (step.type === "zone") model.newZone({ name: step.name, t: step.t });
    else last = model.ingest(step.frame);
  }
  return last;
}
