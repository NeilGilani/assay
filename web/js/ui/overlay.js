// Detection boxes drawn over the camera view.

import { CATEGORY, kindInfo } from "../ontology.js";

export const COLORS = {
  cyan: "#35dcdc",
  amber: "#ffb547",
  coral: "#ff6257",
  text: "#f2f4f6",
  muted: "#8a949f",
  ink: "#0a0b0d",
};

export function colorFor(kind) {
  const c = kindInfo(kind).category;
  if (c === CATEGORY.HAZARD) return COLORS.coral;
  if (c === CATEGORY.EGRESS) return COLORS.cyan;
  if (c === CATEGORY.PERSON) return COLORS.amber;
  if (c === CATEGORY.RESOURCE) return COLORS.text;
  return COLORS.muted;
}

/** Map source-frame pixels to an element shown with object-fit: cover. */
export function coverTransform(srcW, srcH, dstW, dstH) {
  const s = Math.max(dstW / srcW, dstH / srcH);
  return { s, ox: (dstW - srcW * s) / 2, oy: (dstH - srcH * s) / 2 };
}

export function sizeCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

/**
 * dets: [{ kind, score, box }] in source pixels; minScore(kind) hides boxes the
 * model ignores, so the screen never shows a "detection" FIELD did not use.
 */
export function drawOverlay(canvas, dets, srcW, srcH, { minScore = () => 0 } = {}) {
  const dpr = sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!dets?.length || !srcW) return;
  const { s, ox, oy } = coverTransform(srcW, srcH, canvas.width, canvas.height);
  ctx.font = `600 ${13 * dpr}px Geist, system-ui, sans-serif`;
  ctx.textBaseline = "top";
  for (const d of dets) {
    if (d.score < minScore(d.kind)) continue;
    const [x0, y0, x1, y1] = d.box;
    const x = ox + x0 * s;
    const y = oy + y0 * s;
    const w = (x1 - x0) * s;
    const h = (y1 - y0) * s;
    const col = colorFor(d.kind);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = col;
    ctx.strokeRect(x, y, w, h);
    const label = `${kindInfo(d.kind).name} ${Math.round(d.score * 100)}`;
    const tw = ctx.measureText(label).width + 10 * dpr;
    const ty = y > 20 * dpr ? y - 19 * dpr : y;
    ctx.fillStyle = col;
    ctx.fillRect(x, ty, tw, 19 * dpr);
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(label, x + 5 * dpr, ty + 3 * dpr);
  }
}
