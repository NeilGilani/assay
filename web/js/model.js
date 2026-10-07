// The situation model: what has been seen, where, how often, and how sure.
//
// A detector fires thirty times on the same fire extinguisher as the camera
// pans past it. Reasoning over thirty extinguishers would be wrong; reasoning
// over the last frame alone would forget the exit that went out of shot two
// seconds ago. This module turns a stream of per-frame boxes into a small set
// of *entities* - one per real thing - each with a bearing, a range when one
// can be measured, a count of independent sightings, and the time it was last
// seen.
//
// Three things it is deliberately strict about:
//
// * A single frame is a glimpse, not a fact. Even at FIELD's score floors the
//   detector puts a hazard box on about one ordinary photo in 25 (measured on
//   COCO, which has no emergencies in it). An entity seen once is reported as
//   "glimpsed" and the reasoner will not let it block an exit on its own.
// * Two boxes of the same kind *in the same frame* are two things. Fusion never
//   merges within a frame, so two people standing together stay two people.
// * People are counted as a lower bound. Tracks over-count (someone walks
//   across the view), so the number FIELD states is the most people visible in
//   any one frame - which cannot be more than are actually there.

import {
  angleDiff,
  angularWidth,
  bearingOf,
  cameraModel,
  distanceOf,
  floorDistance,
  median,
  norm360,
} from "./geometry.js";
import { MORE_SPECIFIC, kindInfo } from "./ontology.js";

export const COVERAGE_BINS = 36; // 10 degrees each
const MAX_DIST_SAMPLES = 25;

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** How much FIELD trusts an entity exists. */
export function evidence(e) {
  if (e.verdict === "dismissed") return "dismissed";
  if (e.verdict === "confirmed" || e.manual) return "confirmed";
  return e.sightings >= 2 ? "seen" : "glimpsed";
}

export class SituationModel {
  constructor({ incident = "unknown", fovLong = 65, cameraHeightM = 1.4, thresholds = {} } = {}) {
    this.incident = incident;
    this.fovLong = fovLong;
    this.cameraHeightM = cameraHeightM; // lens above the floor: chest height for a hand-held phone
    this.thresholds = thresholds; // kind -> minScore override
    this.zones = [];
    this.entities = new Map();
    this.currentZoneId = null;
    this.nextEntityId = 1;
    this.nextZoneId = 1;
    this.frameCount = 0;
  }

  get zone() {
    return this.zones.find((z) => z.id === this.currentZoneId) ?? null;
  }

  zoneById(id) {
    return this.zones.find((z) => z.id === id) ?? null;
  }

  entitiesIn(zoneId, { includeDismissed = false } = {}) {
    const out = [];
    for (const e of this.entities.values()) {
      if (e.zoneId !== zoneId) continue;
      if (!includeDismissed && e.verdict === "dismissed") continue;
      out.push(e);
    }
    return out;
  }

  /**
   * Start a new area. The responder has walked somewhere else, so bearings and
   * ranges measured from the old spot no longer apply from here. If they were
   * facing a doorway when they moved, record it as the probable way through -
   * "probable" because FIELD did not watch them walk.
   */
  newZone({ name, t = Date.now() } = {}) {
    const prev = this.zone;
    let via = null;
    if (prev && prev.lastHeading != null) {
      // a door or stair the camera was facing, else an exit sign there
      let best = null;
      for (const e of this.entitiesIn(prev.id)) {
        const rank = { door: 0, stairs: 0, exit_sign: 1 }[e.kind];
        if (rank == null) continue;
        const off = Math.abs(angleDiff(e.bearing, prev.lastHeading));
        if (off > 25) continue;
        if (!best || rank < best.rank || (rank === best.rank && off < best.off)) best = { id: e.id, off, rank };
      }
      via = best?.id ?? null;
    }
    const id = `z${this.nextZoneId++}`;
    const zone = {
      id,
      name: name || `Area ${this.zones.length + 1}`,
      createdAt: t,
      from: prev?.id ?? null,
      via,
      coverage: new Array(COVERAGE_BINS).fill(0),
      headingSource: null,
      lastHeading: null,
      maxPeopleInFrame: 0,
      frames: 0,
    };
    this.zones.push(zone);
    this.currentZoneId = id;
    return zone;
  }

  minScore(kind) {
    return this.thresholds[kind] ?? kindInfo(kind).minScore;
  }

  /**
   * Fold one analysed frame into the model.
   *
   * frame = {
   *   t, width, height,
   *   heading: compass bearing of the lens, or null when there is no compass,
   *   pitch:   degrees above the horizon (optional),
   *   fovLong: lens field of view along the long side (optional),
   *   detections: [{ kind, score, box: [x0, y0, x1, y1] }]  (pixels),
   *   crop:    optional (box) => thumbnail, called when a better view arrives
   * }
   */
  ingest(frame) {
    const zone = this.zone ?? this.newZone({ t: frame.t });
    const relative = frame.heading == null;
    if (Math.abs(frame.pitch ?? 0) > 70) {
      return { skipped: "camera is pointing at the floor or ceiling; directions would be meaningless", events: [] };
    }
    const heading = relative ? 0 : norm360(frame.heading);
    zone.headingSource ??= relative ? "relative" : "compass";
    zone.lastHeading = heading;
    zone.frames += 1;
    this.frameCount += 1;
    const frameId = this.frameCount;

    const cam = cameraModel(frame.width, frame.height, frame.fovLong ?? this.fovLong);
    this.#markCoverage(zone, heading, cam.hfov);

    let dets = (frame.detections ?? []).filter((d) => d.score >= this.minScore(d.kind));
    dets = suppressGeneric(dets);

    const people = dets.filter((d) => d.kind === "person").length;
    zone.maxPeopleInFrame = Math.max(zone.maxPeopleInFrame, people);

    const events = [];
    const used = new Set();
    for (const det of [...dets].sort((a, b) => b.score - a.score)) {
      const m = measure(det, heading, cam, { pitch: frame.pitch ?? 0, cameraHeightM: this.cameraHeightM });
      const match = this.#match(zone.id, det.kind, m, used);
      let entity;
      if (match) {
        entity = match;
      } else {
        entity = {
          id: `e${this.nextEntityId++}`,
          kind: det.kind,
          zoneId: zone.id,
          bearing: m.bearing,
          distance: m.distance,
          sightings: 0,
          bestScore: 0,
          scoreSum: 0,
          firstSeen: frame.t,
          lastSeen: frame.t,
          lastFrame: 0,
          widthDeg: m.widthDeg,
          posture: null,
          verdict: null,
          manual: false,
          attrs: {},
          thumb: null,
          _sx: 0,
          _sy: 0,
          _dists: [],
          _down: 0,
          _up: 0,
        };
        this.entities.set(entity.id, entity);
        events.push({ type: "new", entity });
      }
      used.add(entity.id);
      this.#update(entity, det, m, frame, frameId);
    }
    return { events, frameId, heading, hfov: cam.hfov };
  }

  #markCoverage(zone, heading, hfov) {
    const step = 360 / COVERAGE_BINS;
    for (let i = 0; i < COVERAGE_BINS; i++) {
      if (Math.abs(angleDiff(i * step + step / 2, heading)) <= hfov / 2) zone.coverage[i] += 1;
    }
  }

  #match(zoneId, kind, m, used) {
    let best = null;
    for (const e of this.entities.values()) {
      if (e.zoneId !== zoneId || e.kind !== kind || used.has(e.id) || e.manual) continue;
      const tol = Math.max(6, Math.max(m.widthDeg, e.widthDeg) / 2 + 2);
      const off = Math.abs(angleDiff(m.bearing, e.bearing));
      if (off > tol) continue;
      let cost = off / tol;
      if (m.distance != null && e.distance != null) {
        const ratio = m.distance / e.distance;
        if (ratio < 0.65 || ratio > 1.55) continue;
        cost += Math.abs(Math.log(ratio));
      }
      if (!best || cost < best.cost) best = { e, cost };
    }
    return best?.e ?? null;
  }

  #update(e, det, m, frame, frameId) {
    e.sightings += 1;
    e.scoreSum += det.score;
    e.lastSeen = frame.t;
    e.lastFrame = frameId;
    // A box cut off by the side of the frame has its centre pulled inwards;
    // let it count as a sighting but barely move the bearing.
    const wt = det.score * (m.clippedSide ? 0.25 : 1);
    e._sx += Math.cos((m.bearing * Math.PI) / 180) * wt;
    e._sy += Math.sin((m.bearing * Math.PI) / 180) * wt;
    e.bearing = norm360((Math.atan2(e._sy, e._sx) * 180) / Math.PI);
    e.widthDeg = Math.max(e.widthDeg * 0.8, m.widthDeg);
    if (m.distance != null) {
      e._dists.push(m.distance);
      if (e._dists.length > MAX_DIST_SAMPLES) e._dists.shift();
      e.distance = median(e._dists);
    }
    if (m.posture === "down") e._down += 1;
    if (m.posture === "up") e._up += 1;
    if (e._down + e._up > 0) e.posture = e._down > e._up ? "down" : "up";
    if (det.score >= e.bestScore) {
      e.bestScore = det.score;
      if (frame.crop) e.thumb = frame.crop(det.box) ?? e.thumb;
    }
  }

  // --- what the responder says overrides what the camera thinks -----------

  confirm(id) {
    const e = this.entities.get(id);
    if (e) e.verdict = "confirmed";
    return e;
  }

  dismiss(id) {
    const e = this.entities.get(id);
    if (e) e.verdict = "dismissed";
    return e;
  }

  restore(id) {
    const e = this.entities.get(id);
    if (e) e.verdict = null;
    return e;
  }

  /** e.g. setAttr(id, "status", "needs_help") on a person, ("state", "blocked") on an exit. */
  setAttr(id, key, value) {
    const e = this.entities.get(id);
    if (!e) return null;
    if (value == null) delete e.attrs[key];
    else e.attrs[key] = value;
    return e;
  }

  /** Something the responder can see and the camera missed. */
  addManual({ kind, bearing, distance = null, t = Date.now(), note = null }) {
    const zone = this.zone ?? this.newZone({ t });
    const e = {
      id: `e${this.nextEntityId++}`,
      kind,
      zoneId: zone.id,
      bearing: norm360(bearing),
      distance,
      sightings: 0,
      bestScore: 1,
      scoreSum: 0,
      firstSeen: t,
      lastSeen: t,
      lastFrame: 0,
      widthDeg: 10,
      posture: null,
      verdict: "confirmed",
      manual: true,
      attrs: note ? { note } : {},
      thumb: null,
      _sx: 0,
      _sy: 0,
      _dists: distance != null ? [distance] : [],
      _down: 0,
      _up: 0,
    };
    zone.headingSource ??= "compass";
    this.entities.set(e.id, e);
    return e;
  }

  toJSON() {
    return {
      version: 1,
      incident: this.incident,
      fovLong: this.fovLong,
      currentZoneId: this.currentZoneId,
      nextEntityId: this.nextEntityId,
      nextZoneId: this.nextZoneId,
      frameCount: this.frameCount,
      zones: this.zones,
      entities: [...this.entities.values()],
    };
  }

  static fromJSON(data) {
    const m = new SituationModel({ incident: data.incident, fovLong: data.fovLong });
    m.currentZoneId = data.currentZoneId;
    m.nextEntityId = data.nextEntityId;
    m.nextZoneId = data.nextZoneId;
    m.frameCount = data.frameCount ?? 0;
    m.zones = data.zones ?? [];
    for (const e of data.entities ?? []) m.entities.set(e.id, e);
    return m;
  }
}

/** Bearing, range and posture of one detection, from where the lens was pointing. */
export function measure(det, heading, cam, { pitch = 0, cameraHeightM = 1.4 } = {}) {
  const [x0, y0, x1, y1] = det.box;
  const info = kindInfo(det.kind);
  const w = x1 - x0;
  const h = y1 - y0;
  const edge = 0.01 * cam.height;
  const clipped = y0 <= edge || y1 >= cam.height - edge;
  const clippedSide = x0 <= 0.01 * cam.width || x1 >= 0.99 * cam.width;
  let posture = null;
  let distance = null;
  if (det.kind === "person") {
    // Someone lying down is wider than tall. Only judged when the whole body is
    // in frame - a standing person cut off at the waist is also "wide".
    if (!clipped) posture = w > 1.25 * h ? "down" : "up";
    // The 1.7 m dimension is whichever way the body runs.
    if (!clipped) distance = distanceOf(info.heightM, Math.max(w, h), cam);
  } else if (info.onFloor) {
    // A puddle has no standard size, but it lies on the floor: its near edge is
    // where a ray from the lens meets the ground. Unknown if that edge is out of shot.
    if (y1 < cam.height - edge) distance = floorDistance(y1, cam, pitch, cameraHeightM);
  } else if (!clipped) {
    distance = distanceOf(info.heightM, h, cam);
  }
  return {
    bearing: bearingOf((x0 + x1) / 2, heading, cam),
    distance,
    clipped,
    clippedSide,
    posture,
    widthDeg: Math.abs(angularWidth(x0, x1, cam)),
  };
}

/** Drop "sign" where the same box is an "exit sign", "door" where it is an "elevator". */
export function suppressGeneric(dets) {
  return dets.filter((d) => {
    for (const [generic, specific] of MORE_SPECIFIC) {
      if (d.kind !== generic) continue;
      if (dets.some((o) => o.kind === specific && iou(o.box, d.box) > 0.5)) return false;
    }
    return true;
  });
}
