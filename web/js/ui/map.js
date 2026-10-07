// The area map: the responder at the centre, everything FIELD has placed
// around them, the route to each exit, and - drawn as plainly as the exits -
// the parts of the room nobody has pointed the camera at yet.
//
// Things with a measured range sit at that range. Things with only a bearing
// (smoke, a sign too small to range) sit on the outer ring as hollow markers,
// because putting them at a guessed distance would draw a fact that is not one.

import { COVERAGE_BINS } from "../model.js";
import { DEG, directionName } from "../geometry.js";
import { CATEGORY } from "../ontology.js";
import { COLORS, sizeCanvas } from "./overlay.js";

function niceRange(max) {
  const r = Math.max(8, Math.min(30, max * 1.15));
  return Math.ceil(r / 5) * 5;
}

/**
 * a: assessment from reason.assess(); view: { heading, hfov, selected, highlight:Set }
 * Returns hit targets [{ id, x, y, r }] in CSS pixels for tap-to-select.
 */
export function drawMap(canvas, a, zone, view = {}) {
  const dpr = sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const hits = [];
  if (!zone) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `500 ${14 * dpr}px Geist, system-ui`;
    ctx.textAlign = "center";
    ctx.fillText("Nothing scanned yet", W / 2, H / 2);
    return hits;
  }
  const relative = a.zone?.relative;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 30 * dpr;

  const ranged = [...a.exits.map((x) => x.distance), ...a.hazards.map((h) => h.distance), ...a.people.all.map((p) => p.distance), ...a.resources.map((r) => r.distance)].filter((d) => d != null);
  const maxRange = niceRange(Math.max(0, ...ranged));
  const P = (bearing, d) => {
    const r = d == null ? R : Math.min(R, (d / maxRange) * R);
    return { x: cx + r * Math.sin(bearing * DEG), y: cy - r * Math.cos(bearing * DEG), onRing: d == null };
  };

  // unscanned arcs
  const step = 360 / COVERAGE_BINS;
  ctx.save();
  for (let i = 0; i < COVERAGE_BINS; i++) {
    if (zone.coverage[i] > 0) continue;
    const a0 = (i * step - 90) * DEG;
    const a1 = ((i + 1) * step - 90) * DEG;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = "rgba(138,148,159,0.10)";
    ctx.fill();
  }
  ctx.restore();

  // range rings
  ctx.strokeStyle = "rgba(195,203,210,0.14)";
  ctx.lineWidth = 1 * dpr;
  const labels = []; // placed at the end, after every marker, without overlaps
  const boxes = []; // marker footprints labels must not cover
  for (let r = 5; r <= maxRange; r += 5) {
    const rr = (r / maxRange) * R;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    const p = P(135, r);
    labels.push({ text: `${r} m`, x: p.x, y: p.y, color: COLORS.muted, prio: 0, size: 11, weight: 500, plain: true });
  }
  for (const arc of a.coverage.unseen) {
    const p = P(arc.centre, maxRange * 0.72);
    labels.push({ text: "NOT SCANNED", x: p.x, y: p.y, color: COLORS.muted, prio: 3.5, size: 11, weight: 700, plain: true });
  }

  // cardinal labels
  ctx.font = `700 ${12 * dpr}px Geist, system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cards = relative ? [["AHEAD", 0], ["RIGHT", 90], ["BEHIND", 180], ["LEFT", 270]] : [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
  for (const [t, b] of cards) {
    const p = P(b, maxRange * 1.09);
    ctx.fillStyle = t === "N" || t === "AHEAD" ? COLORS.cyan : COLORS.muted;
    ctx.fillText(t, p.x, p.y);
  }

  // where the camera points now
  if (view.heading != null && view.hfov) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, (view.heading - view.hfov / 2 - 90) * DEG, (view.heading + view.hfov / 2 - 90) * DEG);
    ctx.closePath();
    ctx.fillStyle = "rgba(53,220,220,0.10)";
    ctx.fill();
  }

  // hazard footprints
  for (const h of a.hazards) {
    if (h.distance == null) continue;
    const p = P(h.bearing, h.distance);
    ctx.beginPath();
    ctx.arc(p.x, p.y, (h.info.radiusM / maxRange) * R, 0, Math.PI * 2);
    ctx.fillStyle = h.level === "glimpsed" ? "rgba(255,98,87,0.06)" : "rgba(255,98,87,0.14)";
    ctx.fill();
  }

  // dangerous pairs
  for (const c of a.compounds) {
    if (c.a.info.category === CATEGORY.PERSON) continue;
    const p = P(c.a.bearing, c.a.distance);
    const q = P(c.b.bearing, c.b.distance);
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.strokeStyle = COLORS.coral;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
    ctx.setLineDash([]);
    labels.push({ text: c.risk.toUpperCase(), x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, color: COLORS.coral, prio: 3, size: 11, weight: 700 });
  }

  // routes to exits
  const rec = a.recommendation?.exit;
  for (const x of a.exits) {
    const p = P(x.bearing, x.distance);
    const col = x.status === "blocked" ? COLORS.coral : x.status === "clear" ? COLORS.cyan : COLORS.amber;
    ctx.strokeStyle = col;
    ctx.lineWidth = (x === rec ? 3.5 : 1.5) * dpr;
    ctx.setLineDash(x === rec ? [] : [6 * dpr, 6 * dpr]);
    ctx.globalAlpha = x === rec ? 1 : 0.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  const marker = (item, shape, col, label) => {
    const p = P(item.bearing, item.distance);
    const sel = view.selected === item.id || view.highlight?.has(item.id);
    const s = (sel ? 9 : 7) * dpr;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = col;
    ctx.fillStyle = p.onRing || item.level === "glimpsed" ? COLORS.ink : col;
    ctx.beginPath();
    if (shape === "square") ctx.rect(p.x - s, p.y - s, 2 * s, 2 * s);
    else if (shape === "triangle") {
      ctx.moveTo(p.x, p.y - s * 1.2);
      ctx.lineTo(p.x + s * 1.1, p.y + s * 0.9);
      ctx.lineTo(p.x - s * 1.1, p.y + s * 0.9);
      ctx.closePath();
    } else ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (sel) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, s + 7 * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.text;
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
    }
    boxes.push({ x0: p.x - s, y0: p.y - s, x1: p.x + s, y1: p.y + s });
    if (label) labels.push({ text: label, x: p.x, y: p.y, gap: s + 3 * dpr, color: col, prio, size: 12, weight: 600 });
    hits.push({ id: item.id, x: p.x / dpr, y: p.y / dpr, r: 18 });
  };
  let prio = 1;

  prio = 1;
  for (const e of a.elevators ?? []) marker(e, "square", COLORS.muted, a.directives.some((d) => /^Elevator/.test(d)) ? "ELEVATOR - NO" : "elevator");
  for (const r of a.resources) marker(r, "square", r.kind === "electrical_panel" ? COLORS.muted : COLORS.text, view.selected === r.id ? r.name : null);
  for (const p of a.people.all) {
    const needs = a.people.needsHelp.some((n) => n.id === p.id);
    marker(p, "circle", COLORS.amber, needs ? "needs help" : null);
  }
  prio = 2;
  for (const h of a.hazards) marker(h, "triangle", COLORS.coral, h.level === "glimpsed" ? `${h.name}?` : h.name);
  prio = 4;
  for (const x of a.exits) {
    const col = x.status === "blocked" ? COLORS.coral : x.status === "clear" ? COLORS.cyan : COLORS.amber;
    const tag = x.status === "blocked" ? "BLOCKED" : x === rec ? "GO" : x.status === "caution" ? "CAUTION" : x.status === "unverified" ? "?" : "";
    marker({ ...x, id: x.anchor.id, level: x.level }, "square", col, `${directionName(x.bearing, relative).toUpperCase()} ${tag}`.trim());
    if (x.status === "blocked") {
      const p = P(x.bearing, x.distance);
      const s = 12 * dpr;
      ctx.strokeStyle = COLORS.coral;
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.moveTo(p.x - s, p.y - s);
      ctx.lineTo(p.x + s, p.y + s);
      ctx.moveTo(p.x + s, p.y - s);
      ctx.lineTo(p.x - s, p.y + s);
      ctx.stroke();
    }
  }

  boxes.push({ x0: cx - 12 * dpr, y0: cy - 12 * dpr, x1: cx + 12 * dpr, y1: cy + 12 * dpr });
  placeLabels(ctx, labels, boxes, dpr, W, H);

  // you
  ctx.beginPath();
  ctx.arc(cx, cy, 6 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.text;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 11 * dpr, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(242,244,246,0.5)";
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  return hits;
}

/**
 * Most important labels first (exits, then dangerous pairs, hazards...). Each
 * tries below, above, right and left of its marker and takes the first spot
 * that covers no marker and no label already placed; a low-priority label
 * with nowhere to go is dropped rather than drawn over something that matters.
 */
function placeLabels(ctx, labels, boxes, dpr, W, H) {
  const placed = [];
  const hit = (r) => [...placed, ...boxes].some((b) => r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0);
  labels.sort((p, q) => q.prio - p.prio);
  for (const l of labels) {
    ctx.font = `${l.weight} ${l.size * dpr}px Geist, system-ui`;
    const w = ctx.measureText(l.text).width + 8 * dpr;
    const h = (l.size + 5) * dpr;
    const g = l.gap ?? 0;
    const spots = [
      [l.x - w / 2, l.y + g],
      [l.x - w / 2, l.y - g - h],
      [l.x + g + 2 * dpr, l.y - h / 2],
      [l.x - g - 2 * dpr - w, l.y - h / 2],
      [l.x - w / 2, l.y + g + h],
      [l.x - w / 2, l.y - g - 2 * h],
    ];
    let r = null;
    for (const [x0, y0] of spots) {
      const cand = { x0, y0, x1: x0 + w, y1: y0 + h };
      if (cand.x0 < 0 || cand.y0 < 0 || cand.x1 > W || cand.y1 > H) continue;
      if (!hit(cand)) {
        r = cand;
        break;
      }
    }
    if (!r) {
      if (l.prio < 4) continue;
      const [x0, y0] = spots[0];
      r = { x0, y0, x1: x0 + w, y1: y0 + h };
    }
    placed.push(r);
    if (!l.plain) {
      ctx.fillStyle = "rgba(10,11,13,0.85)";
      ctx.fillRect(r.x0, r.y0, w, h);
    }
    ctx.fillStyle = l.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(l.text, r.x0 + 4 * dpr, r.y0 + h / 2 + 0.5 * dpr);
  }
}
