// What FIELD knows about the things it can see.
//
// The detector only says "a box, probably a door, 0.71". Everything that turns
// that into a judgement lives here, as data rather than code, so a reviewer can
// read the whole safety model in one screen: how tall a door is (which is how
// far away it is), which hazards block a route and which only slow it down, and
// which *pairs* of ordinary things are dangerous together.

export const CATEGORY = Object.freeze({
  PERSON: "person",
  EGRESS: "egress",
  HAZARD: "hazard",
  RESOURCE: "resource",
  INFRA: "infrastructure",
});

// heightM  real-world height, for distance. null when it varies too much to
//          use (smoke, a puddle, a staircase) - those get a bearing, no range.
// minScore detector score below which a box is ignored. Hazards sit higher:
//          on 128 ordinary COCO photos (no emergencies in any of them) a 0.25
//          floor put a hazard box on 9 images (7%); 0.35 cuts it to 5 (3.9%).
//          tools/measure_false_alarms.py reproduces this.
// severity 3 critical, 2 high, 1 caution - how much it costs a route.
// blocks   whether it makes a route impassable rather than merely worse.
// radiusM  how close counts as "at" it when deciding whether a route passes it.
// onFloor  lies on the floor, so its range comes from where its near edge meets
//          the floor (camera height and tilt) rather than from its size.
export const KINDS = Object.freeze({
  person: { name: "person", plural: "people", category: CATEGORY.PERSON, heightM: 1.7, minScore: 0.3 },
  wheelchair: { name: "wheelchair", category: CATEGORY.PERSON, heightM: 0.95, minScore: 0.35 },

  exit_sign: { name: "exit sign", category: CATEGORY.EGRESS, heightM: 0.25, minScore: 0.3 },
  door: { name: "door", category: CATEGORY.EGRESS, heightM: 2.03, minScore: 0.3 },
  stairs: { name: "stairwell", category: CATEGORY.EGRESS, heightM: null, onFloor: true, minScore: 0.35 },
  elevator: { name: "elevator", category: CATEGORY.INFRA, heightM: 2.1, minScore: 0.35 },
  window: { name: "window", category: CATEGORY.INFRA, heightM: null, minScore: 0.35 },
  sign: { name: "sign", category: CATEGORY.INFRA, heightM: null, minScore: 0.35 },
  electrical_panel: { name: "electrical panel", category: CATEGORY.INFRA, heightM: 0.9, minScore: 0.35 },

  fire: { name: "fire", category: CATEGORY.HAZARD, heightM: null, minScore: 0.35, severity: 3, blocks: true, radiusM: 3 },
  smoke: { name: "smoke", category: CATEGORY.HAZARD, heightM: null, minScore: 0.35, severity: 2, radiusM: 3 },
  debris: { name: "debris", category: CATEGORY.HAZARD, heightM: null, onFloor: true, minScore: 0.35, severity: 2, blocks: true, radiusM: 1.5 },
  structural_damage: { name: "structural damage", category: CATEGORY.HAZARD, heightM: null, minScore: 0.35, severity: 2, radiusM: 2.5 },
  water: { name: "standing water", category: CATEGORY.HAZARD, heightM: null, onFloor: true, minScore: 0.35, severity: 1, radiusM: 2 },
  exposed_wires: { name: "exposed wiring", category: CATEGORY.HAZARD, heightM: null, minScore: 0.35, severity: 2, radiusM: 1.5 },
  broken_glass: { name: "broken glass", category: CATEGORY.HAZARD, heightM: null, onFloor: true, minScore: 0.35, severity: 1, radiusM: 1.5 },
  gas_cylinder: { name: "gas cylinder", category: CATEGORY.HAZARD, heightM: 1.0, minScore: 0.35, severity: 1, radiusM: 1.5 },

  extinguisher: { name: "fire extinguisher", category: CATEGORY.RESOURCE, heightM: 0.6, minScore: 0.3 },
  first_aid: { name: "first-aid kit", category: CATEGORY.RESOURCE, heightM: 0.3, minScore: 0.35 },
  aed: { name: "AED", category: CATEGORY.RESOURCE, heightM: 0.4, minScore: 0.35 },
  fire_alarm: { name: "fire alarm", category: CATEGORY.RESOURCE, heightM: 0.15, minScore: 0.35 },
  fire_hose: { name: "fire hose", category: CATEGORY.RESOURCE, heightM: 0.8, minScore: 0.35 },
});

export function kindInfo(kind) {
  return KINDS[kind] ?? { name: kind, category: CATEGORY.INFRA, heightM: null, minScore: 0.4 };
}

export function isHazard(kind) {
  return kindInfo(kind).category === CATEGORY.HAZARD;
}

// When the detector puts two labels on one object, keep the specific one.
// An exit sign is also "a sign"; an elevator is also "a door".
export const MORE_SPECIFIC = Object.freeze([
  ["sign", "exit_sign"],
  ["door", "elevator"],
]);

// Things that are ordinary apart and dangerous together. This is the part a
// sign-reader cannot do: nothing in the frame says "electrocution risk", it has
// to be inferred from two objects and the distance between them.
//
// risk      what the combination means, said after the pair
// near      metres apart that triggers the rule when both have a range
// sameView  degrees apart that triggers it when either has no range - reported
//           as "next to each other in view", never as a distance
export const COMPOUND_RULES = Object.freeze([
  {
    id: "electrocution",
    risk: "electrocution risk",
    a: ["water"],
    b: ["electrical_panel", "exposed_wires"],
    near: 3,
    sameView: 10,
    severity: 3,
    say: ({ a, b, apart }) => `${a} ${apart} the ${b}`,
    advice: "Treat the water as live. Do not wade through it.",
  },
  {
    id: "explosion",
    risk: "explosion risk",
    a: ["fire"],
    b: ["gas_cylinder"],
    near: 6,
    sameView: 12,
    severity: 3,
    say: ({ a, b, apart }) => `${a} ${apart} a ${b}`,
    advice: "Keep clear of the cylinder; do not fight this fire.",
  },
  {
    id: "smoke_stairs",
    risk: "the stairs may be untenable",
    a: ["smoke", "fire"],
    b: ["stairs"],
    near: 4,
    sameView: 10,
    severity: 3,
    say: ({ a, b, apart }) => `${a} ${apart} the ${b}`,
    advice: "Do not take this stairwell unless there is no other way.",
  },
  {
    id: "person_in_danger",
    risk: "priority rescue",
    a: ["person", "wheelchair"],
    b: ["fire", "smoke", "exposed_wires", "structural_damage"],
    near: 4,
    sameView: 10,
    severity: 3,
    say: ({ a, b, apart }) => `a ${a} ${apart} ${b}`,
    advice: "Reach this person first.",
  },
  {
    id: "glass_and_water",
    risk: "hidden glass under water",
    a: ["broken_glass"],
    b: ["water"],
    near: 2,
    sameView: 8,
    severity: 1,
    say: ({ a, b, apart }) => `${a} ${apart} ${b}`,
    advice: "Do not step where you cannot see the floor.",
  },
]);

// What kind of emergency changes what is dangerous. The directives are
// standard public guidance, stated plainly; FIELD repeats them, it does not
// invent them. staleMinutes is how old a sighting can be before FIELD says
// conditions may have changed since - fire moves fastest.
export const INCIDENTS = Object.freeze({
  unknown: {
    name: "Unknown",
    staleMinutes: 5,
    weights: {},
    avoidElevators: false,
    directives: [],
  },
  fire: {
    name: "Fire",
    staleMinutes: 2,
    weights: { fire: 2, smoke: 2, gas_cylinder: 2 },
    avoidElevators: true,
    directives: [
      "Do not use elevators in a fire.",
      "Under smoke, stay low. Check a closed door for heat with the back of your hand before opening it - FIELD cannot see heat.",
    ],
  },
  earthquake: {
    name: "Earthquake",
    staleMinutes: 10,
    weights: { structural_damage: 2, broken_glass: 1.5, debris: 1.5 },
    avoidElevators: true,
    directives: [
      "Expect aftershocks. Keep away from windows, glass and anything that can fall.",
      "Do not use elevators.",
    ],
  },
  flood: {
    name: "Flood",
    staleMinutes: 5,
    weights: { water: 2.5, exposed_wires: 1.5 },
    avoidElevators: true,
    directives: [
      "Do not walk through water when you cannot see the floor. Treat any water near electrical equipment as live.",
      "Move up, not down.",
    ],
  },
  outage: {
    name: "Power outage",
    staleMinutes: 15,
    weights: {},
    avoidElevators: true,
    directives: ["Elevators can stop between floors without power - use the stairs."],
  },
});

export function incidentProfile(incident) {
  return INCIDENTS[incident] ?? INCIDENTS.unknown;
}
