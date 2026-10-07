// Which way the camera is pointing.
//
// Three modes, because three kinds of device turn up at an incident:
//   compass   a phone with a magnetometer: real bearings, "the east exit"
//   manual    a laptop being turned by hand: the responder says which way it faces
//   relative  no idea: bearings are relative to the view, "ahead-left"
//
// A compass reading older than two seconds is not used. A stale heading would
// put every new sighting in the wrong direction and nothing would notice.

import { angleDiff, cameraHeading, norm360 } from "./geometry.js";

const FRESH_MS = 2000;

export class Heading {
  constructor() {
    this.mode = "auto";
    this.manual = 0;
    this.compass = null;
    this.pitch = null;
    this.at = 0;
    this.started = false;
  }

  /** Must be called from a user gesture: iOS asks permission for the compass. */
  async start() {
    if (this.started) return;
    this.started = true;
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        await DeviceOrientationEvent.requestPermission();
      }
    } catch {
      // denied: fall back to relative
    }
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", (e) => {
        if (e.alpha == null || e.beta == null) return;
        const { heading, pitch } = cameraHeading(e.alpha, e.beta, e.gamma ?? 0);
        this.#push(heading, pitch);
      });
    }
    window.addEventListener("deviceorientation", (e) => {
      if (e.webkitCompassHeading != null && e.beta != null) {
        // iOS: tilt-compensated heading of the rear camera when held upright
        this.#push(e.webkitCompassHeading, cameraHeading(0, e.beta, e.gamma ?? 0).pitch);
      } else if (e.beta != null && this.compass == null) {
        this.pitch = cameraHeading(0, e.beta, e.gamma ?? 0).pitch;
      }
    });
  }

  #push(heading, pitch) {
    // light smoothing; circular so 359 -> 1 does not swing through 180
    this.compass = this.compass == null || performance.now() - this.at > FRESH_MS ? heading : norm360(this.compass + 0.35 * angleDiff(heading, this.compass));
    this.pitch = pitch;
    this.at = performance.now();
  }

  get hasCompass() {
    return this.compass != null && performance.now() - this.at < FRESH_MS;
  }

  /** { heading: degrees or null, pitch, source: "compass" | "manual" | "relative" } */
  current() {
    if (this.mode === "manual") return { heading: this.manual, pitch: this.pitch ?? 0, source: "manual" };
    if (this.mode === "auto" && this.hasCompass) return { heading: this.compass, pitch: this.pitch ?? 0, source: "compass" };
    return { heading: null, pitch: this.pitch ?? 0, source: "relative" };
  }
}
