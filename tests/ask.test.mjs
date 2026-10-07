import { test } from "node:test";
import assert from "node:assert/strict";
import { SituationModel } from "../web/js/model.js";
import { SCENARIO, runScenario } from "../web/js/scenario.js";
import { CAPABILITIES, answer, handoff, resolve } from "../web/js/ask.js";

const NOW = 60_000;

function lobby() {
  const m = new SituationModel();
  runScenario(m, { ...SCENARIO, zones: [SCENARIO.zones[0]] });
  return m;
}

test("questions people actually ask resolve to the right intent", () => {
  const cases = {
    "Which exit is safest?": "exit",
    "how do I get out": "exit",
    "safest way out?": "exit",
    "is anyone hurt": "people",
    "anybody trapped here?": "people",
    "what's dangerous here": "hazards",
    "any hazards?": "hazards",
    "where's the nearest fire extinguisher": "resource",
    "first aid kit?": "resource",
    "is there an AED": "resource",
    "what haven't I checked": "coverage",
    "where should I look": "coverage",
    "can I take the lift": "elevator",
    "give me a sitrep": "sitrep",
    "where is the fire": "where",
    "is there smoke": "where",
  };
  for (const [q, intent] of Object.entries(cases)) assert.equal(resolve(q).intent, intent, q);
  assert.equal(resolve("where's the nearest fire extinguisher").kind, "extinguisher");
  assert.equal(resolve("is there smoke").kind, "smoke");
});

test("the exit answer, word for word", () => {
  const a = answer(lobby(), "Which exit is safest?", { now: NOW });
  assert.equal(a.headline, "Take the west exit - about 10 m, bearing 270°.");
  const text = a.lines.map((l) => l.text);
  assert.match(text[0], /^The east exit is blocked by debris/);
  assert.match(text[1], /^The north exit is accessible, but there is standing water on the way \(\d m from you\), 1\.\d m from the electrical panel - electrocution risk\.$/);
  assert.match(text[2], /^The west exit appears clear \(seen in \d+ frames\)\.$/);
  assert.ok(text.some((t) => /Not yet seen: south-east/.test(t)));
});

test("a question it cannot answer gets a refusal and the list of what it can do", () => {
  const a = answer(lobby(), "what's the weather like outside", { now: NOW });
  assert.equal(a.intent, "unknown");
  assert.match(a.headline, /can't answer/);
  for (const c of CAPABILITIES) assert.ok(a.lines[0].text.includes(c));
});

test("every answer cites only things the model actually holds", () => {
  const m = new SituationModel();
  runScenario(m);
  const qs = ["exit?", "hazards", "people", "extinguisher", "coverage", "elevator", "sitrep", "where is the smoke", "first aid"];
  for (const q of qs) {
    const a = answer(m, q, { now: NOW });
    for (const id of a.evidence) assert.ok(m.entities.has(id), `${q}: cites unknown ${id}`);
  }
});

test("resources in an earlier area are found, with where they were seen from", () => {
  const m = new SituationModel();
  runScenario(m);
  const a = answer(m, "nearest fire extinguisher", { now: NOW });
  assert.match(a.headline, /^No fire extinguisher here\. There is one in Lobby/);
});

test("an empty model says so instead of answering", () => {
  const a = answer(new SituationModel(), "Which exit is safest?", { now: NOW });
  assert.equal(a.headline, "Nothing scanned yet.");
});

test("the handoff report covers every area and makes no claim the reasoner did not", () => {
  const m = new SituationModel();
  runScenario(m);
  const text = handoff(m, { now: NOW });
  assert.match(text, /## Lobby/);
  assert.match(text, /## Stair lobby/);
  assert.match(text, /Way out: west exit, clear/);
  assert.match(text, /Blocked: north stairwell/);
});
