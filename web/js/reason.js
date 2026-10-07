// From "what is where" to "which way out".
//
// Nothing in this file is a language model, and that is the point. A responder
// who asks "which exit is safest?" gets an answer assembled from geometry and a
// short rule table: each exit's position, each hazard's position, the line
// between the responder and the exit, and whether anything dangerous sits on
// it. Every sentence carries the ids of the sightings it came from, so the
// screen can show the actual frames behind "the east exit is blocked".
//
// The asymmetry it is built around: telling someone an exit is clear when it
// is not can kill them; telling them an exit is blocked when it is not costs a
// few seconds. So:
//
// * A hazard glimpsed once makes a route *worse*; only a hazard seen more than
//   once, or confirmed by the responder, can make it *blocked*.
// * A hazard with no measurable range is assumed to be on the way to any exit
//   in the same direction, and is said to be "in the same direction", never
//   "in front of" - FIELD does not know which side of the door it is on.
// * "Clear" means "nothing seen on the way". If part of the room has not been
//   scanned, the answer says which part, every time.

import { angleDiff, directionName, dist, pointSegment, polarToXY } from "./geometry.js";
import { COMPOUND_RULES, CATEGORY, incidentProfile, isHazard, kindInfo } from "./ontology.js";
import { COVERAGE_BINS, evidence } from "./model.js";

const ORIGIN = { x: 0, y: 0 };

/**
 * Ranges from one camera are rough - doors are not all 2.03 m, the lens field
 * of view is a default, the floor is not always level - and they have not yet
 * been measured against a tape in a real building. So they are never printed
 * finer than whole metres beyond 3 m.
 */
export function fmtDist(d) {
  if (d == null) return null;
  return d < 3 ? `${d.toFixed(1)} m` : `${Math.round(d)} m`;
}

/** "seen in 6 frames" - for one sighting-backed item, or an exit made of several. */
export function evidenceText(x) {
  const parts = x.members ?? [x];
  if (x.level === "confirmed") return parts.some((m) => m.e.manual) ? "added by you" : "confirmed by you";
  if (x.level === "glimpsed") return "glimpsed once, unconfirmed";
  return `seen in ${Math.max(...parts.map((m) => m.e.sightings))} frames`;
}

function decorate(e, now, profile, relative) {
  const info = kindInfo(e.kind);
  const ageMin = (now - e.lastSeen) / 60000;
  return {
    e,
    id: e.id,
    kind: e.kind,
    info,
    name: info.name,
    level: evidence(e),
    bearing: e.bearing,
    distance: e.distance,
    pos: e.distance != null ? polarToXY(e.bearing, e.distance) : null,
    dir: directionName(e.bearing, relative),
    ageMin,
    stale: ageMin > profile.staleMinutes,
  };
}

/** How a hazard relates to the route from the responder to an exit, if at all. */
export function relation(h, exitBearing, exitPos) {
  if (h.pos && exitPos) {
    const atExit = dist(h.pos, exitPos);
    if (atExit <= h.info.radiusM + 1) return { type: "at", metres: atExit };
    const seg = pointSegment(h.pos, ORIGIN, exitPos);
    if (seg.distance <= h.info.radiusM * 0.5 + 0.75 && seg.along > -0.05 && seg.along < 1.05) {
      return { type: "on_path", metres: seg.distance };
    }
    return null;
  }
  const tol = Math.max(8, (h.e.widthDeg ?? 0) / 2 + 3);
  if (Math.abs(angleDiff(h.bearing, exitBearing)) <= tol) return { type: "same_direction" };
  return null;
}

/** Pairs of things that are dangerous together. */
export function findCompounds(items) {
  const out = [];
  for (const rule of COMPOUND_RULES) {
    for (const a of items) {
      if (!rule.a.includes(a.kind)) continue;
      for (const b of items) {
        if (a === b || !rule.b.includes(b.kind)) continue;
        let apart = null;
        let metres = null;
        if (a.pos && b.pos) {
          metres = dist(a.pos, b.pos);
          if (metres <= rule.near) apart = `${fmtDist(metres)} from`;
        } else if (Math.abs(angleDiff(a.bearing, b.bearing)) <= rule.sameView) {
          apart = "next to";
        }
        if (!apart) continue;
        const unsure = a.level === "glimpsed" || b.level === "glimpsed";
        const text = `${rule.say({ a: a.name, b: b.name, apart })} - ${rule.risk}`;
        out.push({
          rule: rule.id,
          risk: rule.risk,
          apart,
          a,
          b,
          metres,
          severity: rule.severity,
          unsure,
          text: (unsure ? "possibly " : "") + text,
          advice: rule.advice,
          evidence: [a.id, b.id],
        });
      }
    }
  }
  return out;
}

function buildExits(items) {
  const signs = items.filter((x) => x.kind === "exit_sign");
  const anchors = items.filter((x) => x.kind === "door" || x.kind === "stairs");
  const used = new Set();
  const exits = [];
  for (const d of anchors) {
    let sign = null;
    for (const s of signs) {
      if (used.has(s.id)) continue;
      const off = Math.abs(angleDiff(s.bearing, d.bearing));
      if (off > 15) continue;
      if (s.distance != null && d.distance != null && Math.abs(s.distance - d.distance) > Math.max(2, 0.4 * d.distance)) continue;
      if (!sign || off < Math.abs(angleDiff(sign.bearing, d.bearing))) sign = s;
    }
    if (sign) used.add(sign.id);
    const designated = d.e.attrs.isExit === true;
    const type = d.kind === "stairs" ? "stairs" : sign ? "marked" : designated ? "designated" : "door";
    exits.push({ anchor: d, sign, members: sign ? [d, sign] : [d], type });
  }
  for (const s of signs) {
    if (!used.has(s.id)) exits.push({ anchor: s, sign: s, members: [s], type: "sign_only" });
  }
  return exits;
}

const TYPE_WORD = { marked: "exit", designated: "exit", door: "door", stairs: "stairwell", sign_only: "exit sign" };
const TYPE_PENALTY = { marked: 0, designated: 0, stairs: 0.5, door: 1, sign_only: 1.5 };

function nameExits(exits) {
  const counts = {};
  for (const x of exits) {
    x.baseName = `${x.anchor.dir} ${TYPE_WORD[x.type]}`;
    counts[x.baseName] = (counts[x.baseName] ?? 0) + 1;
  }
  const seen = {};
  for (const x of exits) {
    if (counts[x.baseName] === 1) {
      x.name = x.baseName;
      continue;
    }
    seen[x.baseName] = (seen[x.baseName] ?? 0) + 1;
    const d = fmtDist(x.distance);
    x.name = d ? `${x.baseName} (${d})` : `${x.baseName} #${seen[x.baseName]}`;
  }
}

function assessExit(x, hazards, compounds, profile, people) {
  const word = x.type === "stairs" ? "stairwell" : x.type === "sign_only" ? "sign" : x.type === "door" ? "door" : "exit";
  const reasons = [];
  let risk = 0;
  let blockedBy = null;
  const pos = x.anchor.pos ?? x.sign?.pos ?? null;
  x.pos = pos;
  x.bearing = x.anchor.bearing;
  x.distance = x.anchor.distance ?? x.sign?.distance ?? null;
  x.level = x.members.some((m) => m.level === "confirmed")
    ? "confirmed"
    : x.members.some((m) => m.level === "seen")
      ? "seen"
      : "glimpsed";
  x.stale = x.members.every((m) => m.stale);
  x.ageMin = Math.min(...x.members.map((m) => m.ageMin));
  const touching = new Set();

  for (const h of hazards) {
    const rel = relation(h, x.bearing, pos);
    if (!rel) continue;
    touching.add(h.id);
    const weight = h.info.severity * (profile.weights[h.kind] ?? 1);
    const sure = h.level !== "glimpsed";
    const where =
      rel.type === "at"
        ? `at the ${word}`
        : rel.type === "on_path"
          ? `on the way${h.distance != null ? ` (${fmtDist(h.distance)} from you)` : ""}`
          : "in the same direction (range unknown)";
    if (h.info.blocks && sure && rel.type !== "same_direction") {
      if (!blockedBy) blockedBy = h;
      reasons.push({ severity: 3, text: `blocked by ${h.name} ${where}`, evidence: [h.id], hazard: h.id });
      continue;
    }
    risk += weight * (sure ? 1 : 0.5);
    const qualifier = sure ? "" : "possible ";
    const verb = h.info.blocks ? " - may block it" : "";
    reasons.push({
      severity: h.info.severity,
      text: `${qualifier}${h.name} ${where}${verb}${sure ? "" : " (glimpsed once)"}`,
      evidence: [h.id],
      hazard: h.id,
    });
  }

  for (const c of compounds) {
    if (!touching.has(c.a.id) && !touching.has(c.b.id)) continue;
    if (c.a.info.category === CATEGORY.PERSON) continue;
    risk += c.severity * 2 * (c.unsure ? 0.5 : 1);
    // Fold the pair into the sentence about the hazard on the route, so it
    // reads "water on the way, 1.7 m from the panel" rather than as two facts.
    const r = reasons.find((q) => q.hazard === c.a.id || q.hazard === c.b.id);
    if (r) {
      const other = r.hazard === c.a.id ? c.b : c.a;
      r.text = `${r.text}, ${c.apart} the ${other.name} - ${c.unsure ? "possible " : ""}${c.risk}`;
      r.severity = Math.max(r.severity, c.severity);
      r.evidence = [...new Set([...r.evidence, ...c.evidence])];
      r.compound = c.rule;
    } else {
      reasons.push({ severity: c.severity, text: c.text, evidence: c.evidence, compound: c.rule });
    }
  }

  if (x.type === "stairs" && people.some((p) => p.kind === "wheelchair")) {
    reasons.push({ severity: 1, text: "stairs only - not usable by the wheelchair user seen here", evidence: [x.anchor.id] });
    risk += 1;
  }

  const state = x.members.map((m) => m.e.attrs.state).find(Boolean);
  if (state === "blocked") {
    blockedBy = { name: "your report" };
    reasons.unshift({ severity: 3, text: "you marked it blocked", evidence: [x.anchor.id] });
  }

  if (blockedBy && state !== "clear") {
    x.status = "blocked";
    x.rank = Infinity;
  } else {
    if (state === "clear") reasons.unshift({ severity: 0, text: "you marked it clear", evidence: [x.anchor.id] });
    const unverified = x.level === "glimpsed" || x.type === "sign_only";
    x.status = state === "clear" ? "clear" : risk > 0 || blockedBy ? "caution" : unverified ? "unverified" : "clear";
    x.rank =
      (state === "clear" ? 0 : risk) +
      TYPE_PENALTY[x.type] +
      (unverified ? 1.5 : 0) +
      (x.stale ? 0.5 : 0) +
      (x.distance ?? 15) / 25;
  }
  reasons.sort((a, b) => b.severity - a.severity);
  x.reasons = reasons;
  x.evidence = [...new Set([...x.members.map((m) => m.id), ...reasons.flatMap((r) => r.evidence)])];
  return x;
}

function coverageOf(zone, relative) {
  const step = 360 / COVERAGE_BINS;
  const seen = zone.coverage.map((c) => c > 0);
  const scannedDeg = seen.filter(Boolean).length * step;
  const unseen = [];
  if (scannedDeg > 0 && scannedDeg < 360) {
    // walk from a seen bin so a gap that wraps through north is one arc
    const start = seen.indexOf(true);
    let run = null;
    for (let k = 1; k <= COVERAGE_BINS; k++) {
      const i = (start + k) % COVERAGE_BINS;
      if (!seen[i]) {
        if (!run) run = { from: i * step, bins: 0 };
        run.bins += 1;
      } else if (run) {
        unseen.push(run);
        run = null;
      }
    }
    if (run) unseen.push(run);
  }
  const arcs = unseen.map((r) => {
    const width = r.bins * step;
    const centre = (r.from + width / 2) % 360;
    const to = (r.from + width) % 360;
    return { from: r.from, to, width, centre, name: directionName(centre, relative) };
  });
  arcs.sort((a, b) => b.width - a.width);
  let text;
  if (scannedDeg === 0) text = "Nothing scanned in this area yet.";
  else if (scannedDeg >= 360) text = "Scanned all the way round.";
  else {
    const parts = arcs.map((a) => (a.width >= 90 ? `${a.name} (${Math.round(a.width)} degrees)` : a.name));
    text = `Scanned ${Math.round(scannedDeg)} of 360 degrees. Not yet seen: ${parts.join(", ")}.`;
  }
  return { scannedDeg, unseen: arcs, text };
}

/**
 * Everything FIELD can say about one area, as data. ask.js turns it into
 * sentences; the map draws it; nothing else decides anything.
 */
export function assess(model, { now = Date.now(), zoneId = model.currentZoneId, followRoute = true } = {}) {
  const zone = model.zoneById(zoneId);
  const profile = incidentProfile(model.incident);
  if (!zone) {
    return {
      zone: null,
      incident: profile.name,
      exits: [],
      recommendation: { exit: null, confidence: "none", text: "Nothing scanned yet. Point the camera around the space." },
      hazards: [],
      compounds: [],
      people: { tracks: 0, likely: 0, atLeast: 0, needsHelp: [], all: [] },
      resources: [],
      elevators: [],
      coverage: { scannedDeg: 0, unseen: [], text: "Nothing scanned yet." },
      directives: [...profile.directives],
      caveats: [],
    };
  }
  const relative = zone.headingSource === "relative";
  const items = model.entitiesIn(zone.id).map((e) => decorate(e, now, profile, relative));

  const hazards = items.filter((x) => isHazard(x.kind));
  const compounds = findCompounds(items);
  const people = items.filter((x) => x.info.category === CATEGORY.PERSON);
  const exits = buildExits(items).map((x) => assessExit(x, hazards, compounds, profile, people));
  nameExits(exits);
  exits.sort((a, b) => a.rank - b.rank || (a.distance ?? 99) - (b.distance ?? 99));

  const coverage = coverageOf(zone, relative);
  const caveats = [];
  if (coverage.scannedDeg < 360 && coverage.scannedDeg > 0) caveats.push(coverage.text);

  // ---- recommendation -------------------------------------------------
  const best = exits.find((x) => x.status !== "blocked") ?? null;
  let recommendation;
  if (best) {
    let confidence = "high";
    if (best.status !== "clear" || coverage.scannedDeg < 270 || best.type === "door" || best.type === "stairs") confidence = "medium";
    if (best.level === "glimpsed" || best.type === "sign_only" || coverage.scannedDeg < 180) confidence = "low";
    recommendation = { exit: best, confidence, evidence: best.evidence };
  } else {
    recommendation = { exit: null, confidence: "none", evidence: [] };
    if (followRoute) {
      // Nothing usable here: walk back through the areas already visited.
      let z = zone;
      let hops = 0;
      const back = [];
      while (z.from) {
        back.push(z);
        z = model.zoneById(z.from);
        if (!z) break;
        hops += 1;
        const there = assess(model, { now, zoneId: z.id, followRoute: false });
        const alt = there.exits.find((x) => x.status !== "blocked");
        if (alt) {
          const viaId = back[back.length - 1].via;
          const via = viaId ? (there.exits.find((x) => x.members.some((m) => m.id === viaId)) ?? null) : null;
          recommendation = {
            exit: null,
            route: { zone: z, exit: alt, hops, via },
            confidence: "low",
            evidence: alt.evidence,
          };
          break;
        }
      }
    }
  }

  // ---- people ---------------------------------------------------------
  const needsHelp = [];
  for (const p of people) {
    if (p.e.attrs.status === "ok") continue;
    const reasons = [];
    if (p.e.attrs.status === "needs_help") reasons.push("you flagged them as needing help");
    if (p.kind === "wheelchair") reasons.push("wheelchair user - needs a step-free route");
    if (p.e.posture === "down") reasons.push("appears to be on the floor (body wider than tall in view)");
    for (const c of compounds) if (c.a.id === p.id && c.rule === "person_in_danger") reasons.push(c.text.replace(/^(possibly )?a (person|wheelchair) /, "$1"));
    if (reasons.length) needsHelp.push({ ...p, reasons });
  }

  // ---- resources ------------------------------------------------------
  const resources = items
    .filter((x) => x.info.category === CATEGORY.RESOURCE || x.kind === "electrical_panel")
    .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99));

  // ---- directives -----------------------------------------------------
  let directives = [...profile.directives];
  const elevators = items.filter((x) => x.kind === "elevator");
  if (profile.avoidElevators && elevators.length) {
    // a specific "the elevator over there" replaces the generic line
    directives = directives.filter((d) => !/elevator/i.test(d));
    for (const el of elevators) directives.unshift(`Elevator to the ${el.dir}: do not use it (${profile.name.toLowerCase()}).`);
  }
  for (const c of compounds) if (!c.unsure && c.severity >= 3 && c.advice && !directives.includes(c.advice)) directives.push(c.advice);

  const staleItems = items.filter((x) => x.stale && (isHazard(x.kind) || x.info.category === CATEGORY.EGRESS));
  if (staleItems.length) {
    const oldest = Math.max(...staleItems.map((x) => x.ageMin));
    caveats.push(`Some of this was seen ${Math.round(oldest)} min ago; conditions may have changed. Re-scan before relying on it.`);
  }

  return {
    zone: { id: zone.id, name: zone.name, relative },
    incident: profile.name,
    exits,
    recommendation,
    hazards: hazards.sort((a, b) => b.info.severity - a.info.severity || (a.distance ?? 99) - (b.distance ?? 99)),
    compounds,
    people: {
      tracks: people.filter((p) => p.kind === "person").length,
      // separate tracks seen more than once: a better estimate than atLeast, but
      // someone who walked between views can be counted twice
      likely: people.filter((p) => p.kind === "person" && p.level !== "glimpsed").length,
      atLeast: Math.max(zone.maxPeopleInFrame, people.filter((p) => p.kind === "person" && p.level === "confirmed").length),
      needsHelp,
      all: people,
    },
    resources,
    elevators,
    coverage,
    directives,
    caveats,
  };
}
