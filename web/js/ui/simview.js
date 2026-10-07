// What the simulated walk-through shows instead of a camera image: a plain
// wireframe of the boxes the scripted detector "saw", over a floor grid in the
// right perspective. It is deliberately unlike a photo - nobody should mistake
// it for one - and the page labels it SIMULATED the whole time it runs.

import { kindInfo } from "../ontology.js";
import { COLORS, sizeCanvas } from "./overlay.js";
import { cameraModel, rowOfFloor } from "../geometry.js";

export function drawSim(canvas, frame) {
  sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const s = Math.max(W / frame.width, H / frame.height);
  const ox = (W - frame.width * s) / 2;
  const oy = (H - frame.height * s) / 2;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#101317");
  g.addColorStop(0.5, "#161a1f");
  g.addColorStop(0.5, "#1b2026");
  g.addColorStop(1, "#0d0f12");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // floor grid: rows at 1 m intervals, converging to the horizon
  const cam = cameraModel(frame.width, frame.height, frame.fovLong ?? 65);
  ctx.strokeStyle = "rgba(195,203,210,0.08)";
  ctx.lineWidth = 1;
  for (let d = 1; d <= 30; d += d < 6 ? 1 : 3) {
    const y = oy + rowOfFloor(d, cam) * s;
    if (y > H) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  const hz = oy + (frame.height / 2) * s;
  for (let k = -8; k <= 8; k++) {
    ctx.beginPath();
    ctx.moveTo(W / 2, hz);
    ctx.lineTo(W / 2 + k * W * 0.25, H);
    ctx.stroke();
  }

  for (const d of frame.detections) {
    const [x0, y0, x1, y1] = d.box;
    const info = kindInfo(d.kind);
    ctx.fillStyle = "rgba(242,244,246,0.06)";
    ctx.fillRect(ox + x0 * s, oy + y0 * s, (x1 - x0) * s, (y1 - y0) * s);
    ctx.fillStyle = COLORS.muted;
    ctx.font = `600 ${Math.max(10, Math.min(16, (x1 - x0) * s * 0.12))}px Geist, system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(info.name, ox + ((x0 + x1) / 2) * s, oy + ((y0 + y1) / 2) * s);
  }
}
