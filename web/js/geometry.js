// Where things are, from a single camera and a compass.
//
// FIELD has no depth sensor and no SLAM. It has three facts per frame: which
// way the camera is pointing, how wide its lens is, and where in the picture a
// box landed. From those, a pinhole camera gives a bearing for every detection
// (exact up to compass error) and a distance for anything whose real size is
// known (a door is about 2 m tall wherever it is). That is enough to put an
// exit, a puddle and a fuse box on the same floor plan and ask whether the
// puddle is near the fuse box - which is the question that matters.
//
// Every function here is pure, so the geometry the map draws is the geometry
// the tests check.

export const DEG = Math.PI / 180;

/** Wrap any angle into [0, 360). */
export function norm360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Signed smallest difference a - b, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = norm360(a - b);
  if (d > 180) d -= 360;
  return d;
}

/**
 * Pinhole model for a frame of the given size. Phones and webcams quote a
 * field of view along the sensor's long side; the short side follows from the
 * aspect ratio, so a portrait phone frame is narrow and tall.
 */
export function cameraModel(width, height, longSideFovDeg = 65) {
  const longPx = Math.max(width, height);
  const focal = longPx / 2 / Math.tan((longSideFovDeg * DEG) / 2);
  return {
    width,
    height,
    focal,
    hfov: (2 * Math.atan(width / 2 / focal)) / DEG,
    vfov: (2 * Math.atan(height / 2 / focal)) / DEG,
  };
}

/** Compass bearing of a point at horizontal pixel x, given the camera heading. */
export function bearingOf(xPx, heading, cam) {
  const offset = Math.atan((xPx - cam.width / 2) / cam.focal) / DEG;
  return norm360(heading + offset);
}

/** Horizontal pixel at which a bearing would appear, or null if outside the frame. */
export function pixelOfBearing(bearing, heading, cam) {
  const off = angleDiff(bearing, heading);
  if (Math.abs(off) >= cam.hfov / 2) return null;
  return cam.width / 2 + Math.tan(off * DEG) * cam.focal;
}

/**
 * Distance to an object of known real height that spans boxHeightPx.
 * Returns null when the size is unknown - a guess here would put a hazard on
 * the wrong side of an exit, and nothing downstream could tell.
 */
export function distanceOf(realHeightM, boxHeightPx, cam) {
  if (!realHeightM || !(boxHeightPx > 0)) return null;
  return (realHeightM * cam.focal) / boxHeightPx;
}

/**
 * Range to a point on the floor seen at pixel row yPx: the ray from the lens
 * dips below the horizon by the camera's tilt plus the row's offset, and meets
 * the floor cameraHeightM below. null when the ray does not dip far enough to
 * meet the floor at a believable range (within ~25 m).
 */
export function floorDistance(yPx, cam, pitchDeg = 0, cameraHeightM = 1.4) {
  const below = -pitchDeg + Math.atan((yPx - cam.height / 2) / cam.focal) / DEG;
  if (below < 3) return null;
  return cameraHeightM / Math.tan(below * DEG);
}

/** Pixel row at which a floor point at range d appears (inverse of floorDistance). */
export function rowOfFloor(d, cam, pitchDeg = 0, cameraHeightM = 1.4) {
  const below = Math.atan(cameraHeightM / d) / DEG;
  return cam.height / 2 + Math.tan((below + pitchDeg) * DEG) * cam.focal;
}

/** Angular width of a box, in degrees - used as the matching tolerance for it. */
export function angularWidth(x0, x1, cam) {
  return (Math.atan((x1 - cam.width / 2) / cam.focal) - Math.atan((x0 - cam.width / 2) / cam.focal)) / DEG;
}

/**
 * Which way the *back camera* points, from a DeviceOrientationEvent.
 *
 * The W3C angles describe the device, not the lens. The lens looks along the
 * device's -z axis, so rotate that vector into the earth frame (Z-X'-Y''
 * intrinsic: alpha about z, beta about x, gamma about y) and read its compass
 * heading. pitch is how far the lens points above (+) or below (-) the horizon;
 * pointing at the floor makes heading meaningless, and callers should say so.
 *
 * alpha must be absolute (deviceorientationabsolute, or iOS's
 * webkitCompassHeading converted) for heading to be a real compass bearing.
 */
export function cameraHeading(alpha, beta, gamma) {
  const a = alpha * DEG;
  const b = beta * DEG;
  const g = gamma * DEG;
  // v = Rz(a) Rx(b) Ry(g) (0, 0, -1)
  const vx0 = -Math.sin(g);
  const vy0 = Math.sin(b) * Math.cos(g);
  const vz = -Math.cos(b) * Math.cos(g);
  const vx = Math.cos(a) * vx0 - Math.sin(a) * vy0;
  const vy = Math.sin(a) * vx0 + Math.cos(a) * vy0;
  return {
    heading: norm360(Math.atan2(vx, vy) / DEG),
    pitch: Math.asin(Math.max(-1, Math.min(1, vz))) / DEG,
  };
}

/** Bearing/distance to metres east (x) and north (y) of where the responder stood. */
export function polarToXY(bearing, distance) {
  return { x: distance * Math.sin(bearing * DEG), y: distance * Math.cos(bearing * DEG) };
}

export function dist(p, q) {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * Distance from point p to the segment a-b, plus how far along the segment the
 * closest point falls (0 at a, 1 at b). The "along" value is what separates a
 * puddle *on the way to* an exit from one behind the responder.
 */
export function pointSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const tc = Math.max(0, Math.min(1, t));
  const cx = a.x + tc * dx;
  const cy = a.y + tc * dy;
  return { distance: Math.hypot(p.x - cx, p.y - cy), along: t };
}

/** Weighted circular mean of bearings in degrees. */
export function circularMean(pairs) {
  let sx = 0;
  let sy = 0;
  for (const [deg, w] of pairs) {
    sx += Math.cos(deg * DEG) * w;
    sy += Math.sin(deg * DEG) * w;
  }
  return norm360(Math.atan2(sy, sx) / DEG);
}

const COMPASS8 = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const RELATIVE8 = ["ahead", "ahead-right", "right", "behind-right", "behind", "behind-left", "left", "ahead-left"];

/** "north-east", or "ahead-right" when there is no compass and bearings are relative. */
export function directionName(bearing, relative = false) {
  const i = Math.round(norm360(bearing) / 45) % 8;
  return (relative ? RELATIVE8 : COMPASS8)[i];
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
