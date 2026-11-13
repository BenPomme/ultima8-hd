// shell/visual/clickmarker.js
// Click-to-move MARKER layer: a separate, pointer-transparent overlay canvas
// that draws the walk destination while the engine is pathing and a brief
// "can't reach" mark when the engine reports the target unreachable.
//
// It is deliberately NOT part of the W1 frame filter / shaders: it owns its own
// canvas, its own z-index and its own lifecycle, so the two overlays never share
// state. It only ever draws two small ring marks derived from the engine's own
// PATH_STATE / PATH_SEQ and the logical destination the engine accepted; it
// reads no game pixels and writes nothing back to the game.
//
// The marker is positioned through the SAME letterbox projection the click
// mapping uses (viewport slots 42..49): a logical point -> canvas backing ->
// CSS px -> page px. All geometry comes from the engine's published viewport,
// never a guessed aspect ratio.

import { normalizeViewport, isViewportMappable } from "../core/input/clickmove.js";

// Inverse of clickmove.mapClientToLogical: engine LOGICAL point -> client
// (page CSS) point. `geom` is the engine canvas rect in the SAME coordinate
// system as the returned point ({left, top, width, height}); pass the canvas
// rect offset into parent-page coordinates for a page-space marker. Returns
// null when the viewport is not mappable, so the caller never draws at a
// guessed position.
export function logicalToClientPoint(viewport, logical, geom) {
  const vp = normalizeViewport(viewport);
  if (!isViewportMappable(vp) || !geom || !logical) return null;
  const w = Number(geom.width) || 0;
  const h = Number(geom.height) || 0;
  if (!(w > 0) || !(h > 0)) return null;
  if (!(vp.logicalW > 0) || !(vp.logicalH > 0)) return null;
  const cx = vp.drawX + (Number(logical.x) || 0) * vp.drawW / vp.logicalW;
  const cy = vp.drawY + (Number(logical.y) || 0) * vp.drawH / vp.logicalH;
  const x = (Number(geom.left) || 0) + cx * w / vp.windowW;
  const y = (Number(geom.top) || 0) + cy * h / vp.windowH;
  return { x, y };
}

// A tiny pure model for the tests: given the engine's PATH_STATE / PATH_SEQ and
// the destination the shell last submitted ({x, y, seq}), decide what the marker
// layer should show this frame. `seq` matching is the contract's "PATH_SEQ
// identifies a fresh request": a destination is only drawn when the engine's
// sequence matches our request, so a stale marker never lingers.
export function markerModel({ pathState, pathSeq, dest, state }) {
  const ACTIVE = 2, FAILED = 4;
  if (pathState === ACTIVE && dest) {
    if (pathSeq !== undefined && pathSeq !== null && dest.seq !== undefined && dest.seq !== null && Number(pathSeq) !== Number(dest.seq)) {
      return { kind: null, x: null, y: null };
    }
    return { kind: "destination", x: dest.x, y: dest.y, seq: dest.seq ?? null };
  }
  if (pathState === FAILED && dest) return { kind: "unreachable", x: dest.x, y: dest.y, seq: dest.seq ?? null };
  return { kind: null, x: null, y: null };
}

const DEST_TTL_MS = 0;          // destination shows while the engine is ACTIVE
const UNREACHABLE_TTL_MS = 1400;

// Mount the marker overlay. `iframe` is the same-origin engine frame the shell
// already hosts; the overlay is appended next to it (its parent), sized to the
// window so client (page) coordinates map 1:1 to canvas CSS coordinates.
export function mountClickMarker(iframe, options = {}) {
  const doc = options.doc ?? iframe?.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  if (!doc) throw new TypeError("mountClickMarker: a document is required to host the marker canvas");
  const win = options.win ?? doc.defaultView ?? (typeof window !== "undefined" ? window : null);
  const zIndex = options.zIndex ?? 2;

  const overlay = doc.createElement("canvas");
  overlay.id = "u8-clickmarker";
  overlay.style.position = "fixed";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.pointerEvents = "none";   // never intercept native click/touch
  overlay.style.display = "none";
  overlay.style.zIndex = String(zIndex);
  const host = iframe?.parentElement ?? doc.body ?? doc.documentElement;
  host?.appendChild?.(overlay);

  const getCtx = () => { try { return overlay.getContext("2d"); } catch { return null; } };
  let destroyed = false;
  let current = null;             // { kind, x, y, seq, at }
  let clearTimer = null;
  let pulse = 0;

  function dpr() { return Math.max(1, Number(win?.devicePixelRatio) || 1); }

  function resize() {
    const w = Math.max(1, Math.floor((Number(win?.innerWidth) || 1)));
    const h = Math.max(1, Math.floor((Number(win?.innerHeight) || 1)));
    const ratio = dpr();
    overlay.width = Math.floor(w * ratio);
    overlay.height = Math.floor(h * ratio);
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
  }

  function clear() {
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    current = null;
    const ctx = getCtx();
    if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
    overlay.style.display = "none";
  }

  // clientPoint is page CSS pixels (as produced by logicalToClientPoint with a
  // page-space canvas rect).
  function draw() {
    const ctx = getCtx();
    if (!ctx || !current) return;
    resize();
    const ratio = dpr();
    const x = Number(current.x) * ratio;
    const y = Number(current.y) * ratio;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const r = (10 + 2 * Math.sin(pulse)) * ratio;
    ctx.lineWidth = 2 * ratio;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (current.kind === "unreachable") {
      ctx.strokeStyle = "rgba(220, 90, 70, 0.95)";
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r * 0.6, y - r * 0.6);
      ctx.lineTo(x + r * 0.6, y + r * 0.6);
      ctx.moveTo(x + r * 0.6, y - r * 0.6);
      ctx.lineTo(x - r * 0.6, y + r * 0.6);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(240, 226, 180, 0.95)";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3 * ratio, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(240, 226, 180, 0.95)";
      ctx.fill();
    }
    overlay.style.display = "block";
  }

  function setMarker(kind, clientPoint, ttlMs = null) {
    if (destroyed || !kind || !clientPoint) return;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    current = { kind, x: clientPoint.x, y: clientPoint.y, at: Date.now() };
    pulse = (pulse + 0.5) % (Math.PI * 2);
    draw();
    const ttl = ttlMs ?? (kind === "unreachable" ? UNREACHABLE_TTL_MS : DEST_TTL_MS);
    if (ttl > 0) clearTimer = setTimeout(clear, ttl);
  }

  function stats() {
    return {
      mounted: Boolean(overlay.isConnected),
      visible: overlay.style.display !== "none",
      kind: current?.kind ?? null,
      hasPoint: Boolean(current),
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clear();
    try { overlay.remove(); } catch { /* detached */ }
  }

  return { setMarker, clear, stats, destroy, element: overlay };
}

export const _INTERNAL = Object.freeze({ DEST_TTL_MS, UNREACHABLE_TTL_MS });
