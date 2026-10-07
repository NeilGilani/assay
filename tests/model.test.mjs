import { test } from "node:test";
import assert from "node:assert/strict";
import { SituationModel, evidence, suppressGeneric } from "../web/js/model.js";
import { cameraModel } from "../web/js/geometry.js";
import { project } from "../web/js/scenario.js";

const W = 720;
const H = 1280;
const cam = cameraModel(W, H, 65);

/** A detector box for a real object at a bearing/range, seen with the lens at `heading`. */
function det(kind, obj, heading, score = 0.8) {
  const box = project({ kind, w: 0.5, h: 1, ...obj }, heading, cam);
  assert.ok(box, `${kind} at ${obj.bearing} is out of shot at heading ${heading}`);
  return { kind, score, box };
}

function frame(heading, detections, t = 0, extra = {}) {
  return { t, width: W, height: H, heading, pitch: 0, fovLong: 65, detections, ...extra };
}

const DOOR = { bearing: 10, d: 6, w: 1, h: 2.03 };

test("the same door across a pan is one entity, placed where it really is", () => {
  const m = new SituationModel();
  for (const [i, h] of [0, 5, 10, 15, 20].entries()) m.ingest(frame(h, [det("door", DOOR, h)], i * 500));
  const doors = [...m.entities.values()].filter((e) => e.kind === "door");
  assert.equal(doors.length, 1);
  assert.equal(doors[0].sightings, 5);
  assert.ok(Math.abs(doors[0].bearing - 10) < 0.5, `bearing ${doors[0].bearing}`);
  assert.ok(Math.abs(doors[0].distance - 6) < 0.2, `distance ${doors[0].distance}`);
  assert.equal(evidence(doors[0]), "seen");
});

test("two people in one frame stay two people, however close", () => {
  const m = new SituationModel();
  const a = { bearing: 0, d: 5, w: 0.5, h: 1.7 };
  const b = { bearing: 4, d: 5, w: 0.5, h: 1.7 };
  m.ingest(frame(0, [det("person", a, 0), det("person", b, 0)]));
  m.ingest(frame(2, [det("person", a, 2), det("person", b, 2)]));
  const people = [...m.entities.values()].filter((e) => e.kind === "person");
  assert.equal(people.length, 2);
  assert.equal(m.zone.maxPeopleInFrame, 2);
});

test("one frame is a glimpse; it takes a second sighting to be 'seen'", () => {
  const m = new SituationModel();
  m.ingest(frame(0, [det("fire", { bearing: 0, d: 5 }, 0, 0.5)]));
  const fire = [...m.entities.values()][0];
  assert.equal(evidence(fire), "glimpsed");
  m.ingest(frame(3, [det("fire", { bearing: 0, d: 5 }, 3, 0.5)]));
  assert.equal(evidence(fire), "seen");
});

test("boxes under the kind's score floor are ignored", () => {
  const m = new SituationModel();
  m.ingest(frame(0, [det("smoke", { bearing: 0, d: 5 }, 0, 0.3)]));
  assert.equal(m.entities.size, 0);
});

test("an exit sign is not also counted as a generic sign", () => {
  const box = [100, 100, 200, 140];
  const kept = suppressGeneric([
    { kind: "exit_sign", score: 0.7, box },
    { kind: "sign", score: 0.8, box: [102, 101, 199, 141] },
  ]);
  assert.deepEqual(
    kept.map((d) => d.kind),
    ["exit_sign"],
  );
});

test("a frame pointed at the floor is not used to place anything", () => {
  const m = new SituationModel();
  const r = m.ingest(frame(0, [det("door", DOOR, 0)], 0, { pitch: -80 }));
  assert.ok(r.skipped);
  assert.equal(m.entities.size, 0);
});

test("without a compass, bearings are relative and the zone says so", () => {
  const m = new SituationModel();
  m.ingest(frame(null, [det("door", { ...DOOR, bearing: 0 }, 0)]));
  assert.equal(m.zone.headingSource, "relative");
});

test("coverage records the arc the lens actually swept", () => {
  const m = new SituationModel();
  for (const h of [0, 20, 40]) m.ingest(frame(h, []));
  const covered = m.zone.coverage.map((c, i) => (c > 0 ? i * 10 + 5 : null)).filter((x) => x != null);
  // portrait hfov ~39 deg: 0..40 headings cover roughly 340..60
  assert.ok(covered.includes(345) && covered.includes(55), covered.join(","));
  assert.ok(!covered.includes(95) && !covered.includes(305), covered.join(","));
});

test("a person lying down is flagged as down, and ranged by body length", () => {
  const m = new SituationModel();
  const lying = { bearing: 0, d: 5, w: 1.7, h: 0.45, floor: true };
  m.ingest(frame(0, [det("person", lying, 0)]));
  m.ingest(frame(2, [det("person", lying, 2)]));
  const p = [...m.entities.values()][0];
  assert.equal(p.posture, "down");
  assert.ok(Math.abs(p.distance - 5) < 0.4, `distance ${p.distance}`);
});

test("moving to a new area records the door being faced as the probable way through", () => {
  const m = new SituationModel();
  m.newZone({ name: "Lobby" });
  for (const h of [5, 10, 15]) m.ingest(frame(h, [det("door", DOOR, h)]));
  const door = [...m.entities.values()][0];
  const z2 = m.newZone({ name: "Corridor" });
  assert.equal(z2.from, m.zones[0].id);
  assert.equal(z2.via, door.id);
});

test("responder verdicts are stored, and dismissed entities drop out of reasoning input", () => {
  const m = new SituationModel();
  m.ingest(frame(0, [det("debris", { bearing: 0, d: 4, w: 1.5, h: 0.4, floor: true }, 0)]));
  const e = [...m.entities.values()][0];
  m.dismiss(e.id);
  assert.equal(m.entitiesIn(m.zone.id).length, 0);
  m.restore(e.id);
  assert.equal(m.entitiesIn(m.zone.id).length, 1);
  m.confirm(e.id);
  assert.equal(evidence(e), "confirmed");
});

test("the model survives a save and reload", () => {
  const m = new SituationModel({ incident: "fire" });
  for (const h of [5, 10]) m.ingest(frame(h, [det("door", DOOR, h)]));
  const back = SituationModel.fromJSON(JSON.parse(JSON.stringify(m)));
  assert.equal(back.incident, "fire");
  assert.equal(back.entities.size, 1);
  back.ingest(frame(15, [det("door", DOOR, 15)]));
  assert.equal(back.entities.size, 1, "fusion keeps working after reload");
  assert.equal([...back.entities.values()][0].sightings, 3);
});
