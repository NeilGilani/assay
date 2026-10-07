import { test } from "node:test";
import assert from "node:assert/strict";
import {
  angleDiff,
  bearingOf,
  cameraHeading,
  cameraModel,
  directionName,
  distanceOf,
  floorDistance,
  norm360,
  pixelOfBearing,
  pointSegment,
  polarToXY,
  rowOfFloor,
} from "../web/js/geometry.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("angles wrap the short way round", () => {
  close(norm360(-10), 350);
  close(norm360(725), 5);
  close(angleDiff(10, 350), 20);
  close(angleDiff(350, 10), -20);
  close(angleDiff(180, 0), 180);
});

test("a portrait phone frame is narrow: long-side FOV applies vertically", () => {
  const cam = cameraModel(720, 1280, 65);
  close(cam.vfov, 65, 1e-9);
  assert.ok(cam.hfov > 39 && cam.hfov < 40, `hfov ${cam.hfov}`);
  const land = cameraModel(1280, 720, 65);
  close(land.hfov, 65, 1e-9);
});

test("bearing: frame centre is the heading, frame edge is heading +/- half the FOV", () => {
  const cam = cameraModel(1280, 720, 60);
  close(bearingOf(640, 90, cam), 90);
  close(bearingOf(1280, 90, cam), 120, 1e-9);
  close(bearingOf(0, 10, cam), 340, 1e-9);
});

test("pixelOfBearing inverts bearingOf, and refuses bearings out of shot", () => {
  const cam = cameraModel(720, 1280, 65);
  for (const x of [5, 200, 360, 600, 715]) close(pixelOfBearing(bearingOf(x, 33, cam), 33, cam), x, 1e-6);
  assert.equal(pixelOfBearing(33 + 40, 33, cam), null);
});

test("a 2.03 m door 4 m away is the right number of pixels tall, and back", () => {
  const cam = cameraModel(720, 1280, 65);
  const px = (2.03 * cam.focal) / 4;
  close(distanceOf(2.03, px, cam), 4, 1e-9);
  assert.equal(distanceOf(null, px, cam), null, "unknown size must give unknown range");
});

test("floor ranging: a point 6 m away on the floor round-trips through the pixel row", () => {
  const cam = cameraModel(720, 1280, 65);
  for (const d of [1.5, 3, 6, 12]) close(floorDistance(rowOfFloor(d, cam, 0, 1.4), cam, 0, 1.4), d, 1e-6);
  for (const pitch of [-20, -5, 10]) close(floorDistance(rowOfFloor(5, cam, pitch, 1.4), cam, pitch, 1.4), 5, 1e-6);
  assert.equal(floorDistance(cam.height / 2, cam, 0, 1.4), null, "the horizon is not on the floor");
});

test("compass: the back camera of an upright phone points where the phone faces", () => {
  // alpha 0, upright: facing north
  close(cameraHeading(0, 90, 0).heading, 0, 1e-9);
  close(cameraHeading(0, 90, 0).pitch, 0, 1e-9);
  // alpha grows counter-clockwise, compass heading clockwise
  close(cameraHeading(90, 90, 0).heading, 270, 1e-9);
  close(cameraHeading(270, 90, 0).heading, 90, 1e-9);
  // flat on a table, screen up: the lens looks at the floor
  close(cameraHeading(0, 0, 0).pitch, -90, 1e-9);
  // tilted up 20 degrees past vertical: pitch +20, heading unchanged
  const up = cameraHeading(30, 110, 0);
  close(up.pitch, 20, 1e-9);
  close(up.heading, 330, 1e-9);
});

test("point-to-segment distance knows a puddle behind you from one in front", () => {
  const exit = polarToXY(0, 10);
  const ahead = pointSegment({ x: 0.5, y: 5 }, { x: 0, y: 0 }, exit);
  close(ahead.distance, 0.5, 1e-9);
  assert.ok(ahead.along > 0 && ahead.along < 1);
  const behind = pointSegment({ x: 0, y: -4 }, { x: 0, y: 0 }, exit);
  assert.ok(behind.along < 0);
});

test("direction names: compass and relative", () => {
  assert.equal(directionName(0), "north");
  assert.equal(directionName(91), "east");
  assert.equal(directionName(225), "south-west");
  assert.equal(directionName(350), "north");
  assert.equal(directionName(270, true), "left");
  assert.equal(directionName(0, true), "ahead");
});
