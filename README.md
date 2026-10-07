# FIELD

**Local AI for places where the internet can't be trusted.**

A phone camera becomes an offline situation model. Pan it around a building
and FIELD finds the exits, hazards, people and equipment on the device itself,
puts them on a map, and reasons over that map when you ask a question. It does
not just read the exit sign; it checks what lies between you and the door.

```
> Which exit is safest?

Take the west exit - about 10 m, bearing 270°.
  ● The east exit is blocked by debris at the exit.
  ● The north exit is accessible, but there is standing water on the way
    (5 m from you), 1.7 m from the electrical panel - electrocution risk.
  ● The west exit appears clear (seen in 7 frames).
  ● Scanned 330 of 360 degrees. Not yet seen: south-east.
  ● Elevator to the north-east: do not use it (earthquake).
```

Nothing in that answer came from the cloud, and nothing in it was written by a
language model. Each line is built from geometry over sightings, and each one
links back to the frames it came from.

Then turn off Wi-Fi and cellular. It still works:

```
NETWORK               Offline. No route to the internet.
CLOUD AI              Unavailable.
FIELD                 Still running, on this device: CPU (WASM, 3 threads),
                      390 ms per frame. Model verified (sha256 e61820723702).
SENT OFF THIS DEVICE  0 network requests since FIELD became ready.
```

That panel is the app's own status screen, not a mock-up. The end-to-end test
suite cuts the network, reloads the page and checks every line of it.

## Run it

```bash
npm install        # also copies the inference runtime into web/vendor/
npm start          # http://localhost:8000
```

Then pick one of three options:

- **Simulated building.** A scripted walk-through of an earthquake-damaged lobby
  and a dead-end stair lobby. It needs no camera and no model, and it is
  labelled SIMULATED the whole time it runs.
- **Start camera.** The real thing. Pan slowly, all the way round.
- **Analyse a photo.** Useful at a desk, and for checking props before a demo.

**On a phone**, the camera needs HTTPS. Deploy `web/` to any static host
(`netlify.toml` is included and builds the app), or on Android run
`adb reverse tcp:8000 tcp:8000` and open `http://localhost:8000`. Open it once
while online and wait for "Saved on this device" (66 MB, mostly the model).
After that it runs in airplane mode.

The three-minute stage demo is in [docs/DEMO.md](docs/DEMO.md).

## How it works

```
 camera frame ──┐
 compass ───────┤
                ▼
  DETECT     YOLOE, 29 emergency classes baked in at export, ONNX Runtime Web
             in a Web Worker. WebGPU if the phone has it, multi-threaded WASM if not.
                ▼                                            perception/
  PLACE      bearing = compass + where the box sits in the frame (pinhole lens)
             range   = known size (a door is ~2 m) or where it meets the floor
                ▼                                            geometry.js
  REMEMBER   thirty boxes on one extinguisher become one entity: bearing,
             range, sightings, last seen, thumbnail, your verdict on it.
             Plus which arcs of the room the camera has actually covered.
                ▼                                            model.js
  REASON     a route to every exit; every hazard tested against that route;
             dangerous pairs (water + panel, fire + gas, smoke + stairs);
             incident rules (no elevators in a fire); people who may need help.
                ▼                                            reason.js
  ANSWER     question -> one of eight intents -> sentences assembled from
             the assessment, each citing the sightings behind it.
                                                             ask.js
```

### Why no language model writes the answers

A model pointed at a smoke-filled corridor will answer every question,
including the ones the evidence cannot support, in the same confident voice as
a true answer. A responder who acts on a fluent wrong answer is the failure
this system exists to prevent. So `ask.js` resolves a sentence to an intent by
pattern, and every word of the reply is assembled from `assess()`. A question
it cannot answer gets "I can't answer that from what I've seen" and the list of
questions it can answer. A local language model can be plugged in later at
`resolve()`, to map messier phrasing onto the same intents. It would never get
to write the answer.

### The asymmetry it is built around

Calling an exit clear when it is not can kill someone. Calling it blocked when
it is not costs a few seconds. Everything below follows from that:

- **One frame is a glimpse, not a fact.** Even at FIELD's score cutoffs, the
  detector puts a hazard box on about one ordinary photo in 25. A hazard seen
  once makes a route *worse*. Only a hazard seen in two or more frames, or
  confirmed by you, can make it *blocked*. The simulated lobby plants a fire
  that appears in a single frame. FIELD lists it as "glimpsed once,
  unconfirmed" and does not route around it.
- **No range, no position.** Smoke has no standard size, so it gets a bearing
  and no distance. On the map it sits on the outer ring as a hollow marker, and
  the answer says "in the same direction (range unknown)", never "in front of
  the door".
- **"Clear" means nothing was seen on the way.** If part of the room has not
  been scanned, every answer that depends on it says which part.
- **People are counted honestly.** FIELD reports how many separate people it
  tracked and the most that were in view at once, and says which is which.
- **You outrank the camera.** Confirm, dismiss, mark an exit blocked or clear,
  flag someone as needing help. The reasoner uses your call and says so.
- **Directions only when there is a compass.** With no compass (a laptop),
  bearings become "ahead-left", and the area is labelled "relative directions".

### "Local" is enforced, not promised

- The page's Content-Security-Policy is `connect-src 'self'`: the browser
  refuses any other destination. It is sent as a header too, so it also binds
  the detector worker. An e2e test checks that a `fetch` to another origin
  fails.
- The service worker refuses any request to another origin, and counts every
  request that does reach the network. That count is the "0 sent" pill.
- Before running the model, the worker checks its SHA-256 against
  `detector.json`. A truncated download would otherwise load and quietly
  detect nothing.
- Speech uses on-device voices only (`localService`). Browser speech
  *recognition* is not used, because on Chrome it streams audio to a server.

## Measured

| What | Result |
|---|---|
| Browser detector vs Python reference, same photos | 9 of 9 boxes match; scores within 0.03 |
| Inference speed, headless Chromium, 3 WASM threads, 4-core server CPU | 340-470 ms per frame |
| Person recall, COCO128 images that contain people (score ≥ 0.30) | 59 / 61 |
| Ordinary photos with any hazard box, score ≥ 0.25 / **0.35** / 0.5 | 7.0% / **3.9%** / 1.6% |
| Reasoner on the scripted building, 25 random seeds | correct exit every time a hazard was detected at all |
| Unit tests (geometry, fusion, reasoning, answers, decoding) | 46 pass |
| End-to-end in Chromium (install, parity, airplane-mode reload, fake camera) | 6 pass |

The false-alarm row comes from `tools/measure_false_alarms.py` over 128 COCO
photos, none of which shows an emergency. FIELD's hazard score cutoff of 0.35
was chosen from it.

## What this does not yet prove

- **Hazard recall is unmeasured.** The table measures false alarms on ordinary
  scenes. Whether the detector actually finds debris, standing water or smoke
  in a real damaged building has not been tested, because no labelled
  emergency footage exists in this repo yet. The prompts "debris", "puddle" and
  "exposed wires" are the weakest link. Collecting that footage is the first
  job.
- **Ranges have not been checked against a tape measure.** They come from a
  pinhole model with a default lens field of view and standard object sizes,
  so they are only printed to whole metres.
- **Indoor compasses lie.** Steel framing and wiring can throw a magnetometer
  off by tens of degrees. Bearings *within* one scan are consistent with each
  other, but "east" may not be east. Manual and relative direction modes exist
  for this.
- **One spot per area.** FIELD assumes you scan from roughly one place, then
  tap "New area" when you move. It does no SLAM and does not track your steps.
- **It does not read sign text yet**, such as room numbers, "NO EXIT" or
  "STAIR B". That is the next feature.
- **It cannot see heat, gas, what is behind a closed door, or whether a floor
  will hold.** The fire guidance says so in its own words.
- **People.** It flags someone who may be on the floor (the box is wider than
  tall) or near danger. It does not assess injuries and never claims to.

## Where this goes

Disaster response is the proof that this matters, not necessarily the
product. The engine underneath, see, place, remember and reason with no
connection, is a local intelligence layer for physical environments:

| | Why AI | Why local |
|---|---|---|
| Emergency response | understand a chaotic, unfamiliar space | the network may be down |
| EMS | process the scene in seconds | seconds matter |
| Healthcare | interpret sensitive physical information | patient privacy |
| Utilities | inspect remote infrastructure | no coverage |
| Construction | spot hazards and errors | jobsite connectivity |
| Industrial safety | catch dangerous conditions | cannot depend on the cloud |
| Agriculture | crop and livestock problems (see Vitals) | rural connectivity |
| Accessibility | continuous understanding of surroundings | privacy and latency |

The same engine could run on phones, laptops, body cameras, drones, vehicles
and glasses. A new domain means a new `tools/vocabulary.json`, a new rule
table in `ontology.js`, and the same refusal to say more than was seen.

## Layout

```
web/                       the app (static, no build step beyond vendoring)
  index.html  app.css      page and styles (dark only: night, smoke, battery)
  sw.js                    offline install, origin lock, network counter
  models/detector.onnx     the exported detector (39 MB) + detector.json manifest
  js/geometry.js           pinhole bearings, ranges, compass maths
  js/ontology.js           what things are: sizes, severities, dangerous pairs, incidents
  js/model.js              fusion of per-frame boxes into entities; coverage
  js/reason.js             routes, hazards on routes, recommendation, people
  js/ask.js                questions -> intents -> answers; handoff report
  js/scenario.js           the scripted building with a known answer
  js/perception/           detector worker, decoding, main-thread client
  js/ui/                   overlay, map, simulated view
  js/app.js                wiring only
tools/
  vocabulary.json          the 29 prompts the detector is exported with
  export_detector.py       YOLOE + vocabulary -> web/models/detector.onnx
  measure_false_alarms.py  the false-alarm table above
tests/                     node --test: 46 unit tests, no dependencies
e2e/                       Playwright: the real page, worker, model and service worker
scripts/                   vendor runtime, build precache list, local server
```

## Rebuilding the detector

```bash
pip install -r tools/requirements.txt
python tools/export_detector.py                    # yoloe-26s-seg, 640 px
python tools/measure_false_alarms.py path/to/photos
```

The text encoder runs once at export, on a workstation. The phone only ever
gets the 29 classes it needs. Change `tools/vocabulary.json` to change what
FIELD looks for, then map any new id in `web/js/ontology.js`.

## Licences

Code: MIT. Inference runtime: onnxruntime-web (MIT). Font: Geist (OFL). The
detector weights are derived from Ultralytics YOLOE, which is **AGPL-3.0**.
Fine for a hackathon. Commercial use needs an Ultralytics licence, or a swap
to a permissively licensed open-vocabulary detector. The swap touches
`tools/export_detector.py` and the decoder, and nothing else.
