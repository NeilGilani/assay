import { test } from "node:test";
import assert from "node:assert/strict";
import { SituationModel } from "../web/js/model.js";
import { cameraModel } from "../web/js/geometry.js";
import { SCENARIO, project, runScenario } from "../web/js/scenario.js";
import { assess } from "../web/js/reason.js";

const W = 720;
const H = 1280;
const cam = cameraModel(W, H, 65);
const NOW = 60_000;

function det(kind, obj, heading, score = 0.8) {
  const box = project({ kind, w: 0.5, h: 1, ...obj }, heading, cam);
  assert.ok(box, `${kind} out of shot`);
  return { kind, score, box };
}

/** Pan across `headings`, showing every object that is in shot each time. */
function scan(m, objects, headings, { t = 0, times = 1 } = {}) {
  for (let k = 0; k < times; k++) {
    for (const h of headings) {
      const dets = [];
      for (const o of objects) {
        const box = project({ w: 0.5, h: 1, ...o }, h, cam);
        if (box && (!o.once || (k === 0 && h === headings.find((hh) => project({ w: 0.5, h: 1, ...o }, hh, cam))))) {
          dets.push({ kind: o.kind, score: o.score ?? 0.8, box });
        }
      }
      m.ingest({ t, width: W, height: H, heading: h, pitch: 0, fovLong: 65, detections: dets });
    }
  }
}

const ALL_ROUND = Array.from({ length: 36 }, (_, i) => i * 10);

function lobby() {
  const m = new SituationModel();
  runScenario(m, { ...SCENARIO, zones: [SCENARIO.zones[0]] });
  return m;
}

const exitAt = (a, bearing) => a.exits.find((x) => Math.abs(((x.bearing - bearing + 540) % 360) - 180) < 15);

test("the canonical lobby: east blocked by debris, north has water by the panel, west is clear", () => {
  const a = assess(lobby(), { now: NOW });
  const east = exitAt(a, 90);
  const north = exitAt(a, 0);
  const west = exitAt(a, 270);
  assert.equal(east.status, "blocked");
  assert.match(east.reasons[0].text, /blocked by debris/);
  assert.equal(north.status, "caution");
  assert.ok(north.reasons.some((r) => /standing water.*electrical panel.*electrocution/.test(r.text)), JSON.stringify(north.reasons));
  assert.equal(west.status, "clear");
  assert.equal(a.recommendation.exit, west);
  assert.equal(west.name, "west exit");
});

test("the canonical answer holds across 25 different random seeds", () => {
  let seen = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const m = new SituationModel();
    runScenario(m, { ...SCENARIO, zones: [SCENARIO.zones[0]] }, { seed });
    const a = assess(m, { now: NOW });
    assert.equal(exitAt(a, 270)?.status, "clear", `seed ${seed}: west`);
    assert.equal(a.recommendation.exit, exitAt(a, 270), `seed ${seed}: recommendation`);
    // "Clear" means "nothing seen on the way". If the simulated detector missed
    // the debris or the water in every frame, FIELD cannot know - so the
    // property is: whenever the hazard was detected at all, the route is not clear.
    const sawDebris = [...m.entities.values()].some((e) => e.kind === "debris");
    const sawWater = [...m.entities.values()].some((e) => e.kind === "water");
    if (sawDebris) assert.notEqual(exitAt(a, 90)?.status, "clear", `seed ${seed}: east`);
    if (sawWater) assert.notEqual(exitAt(a, 0)?.status, "clear", `seed ${seed}: north`);
    seen += sawDebris && sawWater ? 1 : 0;
  }
  assert.ok(seen >= 23, `both hazards detected in only ${seen}/25 runs`);
});

test("the unscanned south-east is reported, every time an answer depends on coverage", () => {
  const a = assess(lobby(), { now: NOW });
  assert.ok(a.coverage.scannedDeg < 360);
  assert.ok(a.coverage.unseen.some((u) => u.name === "south-east"), JSON.stringify(a.coverage.unseen));
  assert.ok(a.caveats.some((c) => /south-east/.test(c)));
  assert.equal(a.recommendation.confidence, "high", "330 degrees scanned with a clear marked exit");
});

test("a fire glimpsed in one frame is listed as unconfirmed and blocks nothing", () => {
  const a = assess(lobby(), { now: NOW });
  const fire = a.hazards.find((h) => h.kind === "fire");
  assert.ok(fire);
  assert.equal(fire.level, "glimpsed");
  for (const x of a.exits) assert.ok(!x.reasons.some((r) => /fire/.test(r.text)), `${x.name}: ${JSON.stringify(x.reasons)}`);
});

test("debris glimpsed once only makes a route worse; it takes two sightings to block it", () => {
  const door = { kind: "door", bearing: 0, d: 8, w: 1, h: 2.03 };
  const debris = { kind: "debris", bearing: 0, d: 6, w: 1.5, h: 0.4, floor: true };
  const m1 = new SituationModel();
  scan(m1, [door], [0, 5, 10]);
  m1.ingest({ t: 0, width: W, height: H, heading: 0, pitch: 0, fovLong: 65, detections: [det("debris", debris, 0)] });
  const once = assess(m1, { now: NOW }).exits[0];
  assert.equal(once.status, "caution");
  assert.match(once.reasons[0].text, /possible debris/);

  const m2 = new SituationModel();
  scan(m2, [door, debris], [0, 5, 10]);
  assert.equal(assess(m2, { now: NOW }).exits[0].status, "blocked");
});

test("a hazard with no range in the same direction is a caution, never a block", () => {
  const m = new SituationModel();
  scan(m, [{ kind: "door", bearing: 0, d: 8, w: 1, h: 2.03 }, { kind: "fire", bearing: 2, d: 5, w: 0.6, h: 0.6, lift: 1 }], [0, 5, 10]);
  const x = assess(m, { now: NOW }).exits[0];
  assert.equal(x.status, "caution");
  assert.match(x.reasons[0].text, /same direction \(range unknown\) - may block it/);
});

test("the responder outranks the camera", () => {
  const m = new SituationModel();
  scan(m, [{ kind: "door", bearing: 0, d: 8, w: 1, h: 2.03 }, { kind: "exit_sign", bearing: 0, d: 8, w: 0.4, h: 0.25, lift: 2.2 }], [0, 5, 10]);
  const door = [...m.entities.values()].find((e) => e.kind === "door");
  m.setAttr(door.id, "state", "blocked");
  let a = assess(m, { now: NOW });
  assert.equal(a.exits[0].status, "blocked");
  assert.equal(a.recommendation.exit, null);
  m.setAttr(door.id, "state", "clear");
  a = assess(m, { now: NOW });
  assert.equal(a.exits[0].status, "clear");
  assert.match(a.exits[0].reasons[0].text, /you marked it clear/);
});

test("no exit seen means no recommendation - FIELD does not invent a way out", () => {
  const m = new SituationModel();
  scan(m, [{ kind: "extinguisher", bearing: 0, d: 3, w: 0.2, h: 0.6, lift: 0.5 }], ALL_ROUND);
  const a = assess(m, { now: NOW });
  assert.equal(a.exits.length, 0);
  assert.equal(a.recommendation.exit, null);
  assert.equal(a.recommendation.route, undefined);
});

test("an exit sign without its door is unverified, and confidence says so", () => {
  const m = new SituationModel();
  scan(m, [{ kind: "exit_sign", bearing: 40, d: 9, w: 0.4, h: 0.25, lift: 2.2 }], ALL_ROUND);
  const a = assess(m, { now: NOW });
  assert.equal(a.exits[0].type, "sign_only");
  assert.equal(a.exits[0].status, "unverified");
  assert.equal(a.recommendation.confidence, "low");
});

test("dead end: route back to the last area that had a usable exit, through the door used", () => {
  const m = new SituationModel();
  runScenario(m);
  const a = assess(m, { now: NOW });
  assert.equal(a.zone.name, "Stair lobby");
  assert.equal(a.exits.every((x) => x.status === "blocked"), true);
  assert.equal(a.recommendation.exit, null);
  const r = a.recommendation.route;
  assert.ok(r, "expected a route back");
  assert.equal(r.zone.name, "Lobby");
  assert.equal(r.exit.name, "west exit");
  assert.equal(r.via?.name, "north exit");
});

test("a person beside smoke is a priority rescue", () => {
  const m = new SituationModel();
  runScenario(m);
  const a = assess(m, { now: NOW });
  const p = a.people.needsHelp.find((x) => x.reasons.some((r) => /smoke - priority rescue/.test(r)));
  assert.ok(p, JSON.stringify(a.people.needsHelp.map((x) => x.reasons)));
});

test("fire incident: elevators are ruled out by name, and smoke weighs more", () => {
  const objs = [
    { kind: "door", bearing: 0, d: 8, w: 1, h: 2.03 },
    { kind: "exit_sign", bearing: 0, d: 8, w: 0.4, h: 0.25, lift: 2.2 },
    { kind: "smoke", bearing: 2, d: 5, w: 1, h: 1, lift: 1.2 },
    { kind: "elevator", bearing: 90, d: 6, w: 1.2, h: 2.1 },
  ];
  const quake = new SituationModel({ incident: "unknown" });
  scan(quake, objs, ALL_ROUND);
  const fire = new SituationModel({ incident: "fire" });
  scan(fire, objs, ALL_ROUND);
  const a = assess(fire, { now: NOW });
  assert.ok(a.directives.some((d) => /^Elevator to the east: do not use it \(fire\)/.test(d)), a.directives.join("|"));
  assert.ok(a.exits[0].rank > assess(quake, { now: NOW }).exits[0].rank);
});

test("old sightings are flagged: conditions may have changed", () => {
  const m = new SituationModel({ incident: "fire" });
  scan(m, [{ kind: "door", bearing: 0, d: 8, w: 1, h: 2.03 }], [0, 5, 10], { t: 0 });
  const a = assess(m, { now: 5 * 60_000 });
  assert.ok(a.caveats.some((c) => /5 min ago; conditions may have changed/.test(c)), a.caveats.join("|"));
});

test("a wheelchair user makes a stairs-only route worse", () => {
  const m = new SituationModel();
  scan(
    m,
    [
      { kind: "stairs", bearing: 0, d: 6, w: 1.4, h: 1, floor: true },
      { kind: "wheelchair", bearing: 180, d: 4, w: 0.7, h: 0.95 },
    ],
    ALL_ROUND,
  );
  const a = assess(m, { now: NOW });
  assert.ok(a.exits[0].reasons.some((r) => /wheelchair/.test(r.text)));
  assert.ok(a.people.needsHelp.some((p) => p.reasons.some((r) => /step-free/.test(r))));
});
