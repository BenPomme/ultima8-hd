// shell/visual/framefilter.js
// Whole-frame "Modern" presentation filter for the framed Ultima VIII canvas.
//
// WHAT IT IS
//   A pointer-transparent overlay canvas that sits exactly on top of the
//   ScummVM <canvas> inside the same-origin engine iframe and re-presents the
//   SAME pixels through an edge-aware Scale2x upscaler (see ./scale2x.js). It
//   reads the original frame, never writes to it, and draws nothing that is not
//   derived from real source pixels. The original canvas, its internal
//   resolution, its bounds and its input handling are left completely alone, so
//   SDL/bridge pointer mapping and gameplay positions are unaffected.
//
// WHAT IT IS NOT
//   It is not extra art, redrawn sprites, HD upscaling, sharpening, blur,
//   brightness or any CSS-only trick, and it claims no fidelity improvement to
//   the source assets. Classic mode simply hides the overlay and lets the
//   browser show the untouched original canvas, with no reload.
//
// FAIL-OPEN
//   If the source canvas cannot be reached, is empty because its WebGL context
//   uses preserveDrawingBuffer:false, or loses its context, the overlay hides
//   itself and the original game frame shows through. It never blacks the game
//   out and never raises into the host app.
//
// PUBLIC API
//   mountFrameFilter(iframe, { mode = 'modern', ... }) =>
//     { setMode(mode), getMode(), attach(), detach(), stats(), destroy() }
//
// All numbers reported by stats() come from the real source canvas / real
// render loop; nothing is synthesised.

import { scale2x } from "./scale2x.js";

const MODES = Object.freeze(["modern", "classic"]);
const SOURCE_CANVAS_ID = "canvas";
const GL_SAMPLE_PERIOD = 45;      // frames between capture-freshness probes
const GL_FAIL_THRESHOLD = 4;      // consecutive stale probes before fail-open
const SLOW_FRAME_MS = 40;         // frame interval counted as a slow frame

function normalizeMode(mode) {
  if (mode === undefined || mode === null) return "modern";
  if (typeof mode !== "string") throw new TypeError(`framefilter: mode must be a string (got ${typeof mode})`);
  const m = mode.toLowerCase();
  if (!MODES.includes(m)) throw new RangeError(`framefilter: unknown mode "${mode}" (expected ${MODES.join(" | ")})`);
  return m;
}

function safeCall(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// WebGL presentation backend: one full-screen quad, NEAREST source sampling and
// the Scale2x quadrant rule evaluated per output pixel. Works for any output
// resolution so the overlay can render at device pixel density.
//
// ORIENTATION CONTRACT (the fix for the reported vertical flip):
//   UNPACK_FLIP_Y_WEBGL stays false, so texture row 0 is the source canvas TOP
//   row and v=0 samples it. gl_FragCoord.y is a bottom-left canvas origin, so
//   it must be converted to a top-left origin before use; otherwise the
//   presented frame is mirrored vertically. Expressing outPix in top-left
//   coordinates keeps BOTH the row order and the A/B/C/D compass identical to
//   the CPU Scale2x reference (up = smaller y), giving exact GPU==CPU output.
// ---------------------------------------------------------------------------
const VERT_SRC = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uSrcSize;
uniform vec2 uOutSize;

float same(vec3 a, vec3 b) {
  vec3 d = abs(a - b);
  return step(d.x + d.y + d.z, 0.002);   // < 1/255, so distinct palette entries differ
}

vec3 fetch(vec2 srcPix) {
  vec2 p = clamp(srcPix, vec2(0.0), uSrcSize - 1.0);
  return texture2D(uTex, (p + 0.5) / uSrcSize).rgb;
}

void main() {
  // gl_FragCoord is bottom-left origin; flip to the source image's top-left
  // origin so row 0 is the source top row and frac.y grows downward.
  vec2 outPix = vec2(gl_FragCoord.x, uOutSize.y - gl_FragCoord.y);
  vec2 scale = uOutSize / uSrcSize;
  vec2 srcPix = floor(outPix / scale);
  vec2 frac = (outPix - srcPix * scale) / scale;

  vec3 E = fetch(srcPix);
  vec3 A = fetch(srcPix + vec2(0.0, -1.0));
  vec3 B = fetch(srcPix + vec2(1.0, 0.0));
  vec3 C = fetch(srcPix + vec2(-1.0, 0.0));
  vec3 D = fetch(srcPix + vec2(0.0, 1.0));

  vec3 E0 = (same(C, A) * (1.0 - same(C, D)) * (1.0 - same(A, B))) > 0.5 ? A : E;
  vec3 E1 = (same(A, B) * (1.0 - same(A, C)) * (1.0 - same(B, D))) > 0.5 ? B : E;
  vec3 E2 = (same(D, C) * (1.0 - same(D, B)) * (1.0 - same(C, A))) > 0.5 ? C : E;
  vec3 E3 = (same(B, D) * (1.0 - same(B, A)) * (1.0 - same(D, C))) > 0.5 ? D : E;

  float right = step(0.5, frac.x);
  float bottom = step(0.5, frac.y);
  vec3 top = mix(E0, E1, right);
  vec3 bot = mix(E2, E3, right);
  gl_FragColor = vec4(mix(top, bot, bottom), 1.0);
}
`;

function createGlBackend(canvas) {
  const opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
  const gl = canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts);
  if (!gl) return null;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`framefilter: shader compile failed: ${log}`);
    }
    return sh;
  };

  // GL objects, recreated wholesale after a context restore (a restored context
  // invalidates every previously created object).
  let program = null, buf = null, tex = null, uSrcSize = null, uOutSize = null;
  function build() {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`framefilter: program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    const uTex = gl.getUniformLocation(program, "uTex");
    uSrcSize = gl.getUniformLocation(program, "uSrcSize");
    uOutSize = gl.getUniformLocation(program, "uOutSize");
    gl.uniform1i(uTex, 0);
  }
  build();

  let lost = false;
  let rebuilding = false;
  const onLost = (e) => { e.preventDefault?.(); lost = true; };
  const onRestored = () => {
    // Context restored: the old GL objects are dead. Rebuild them; if that
    // fails the backend stays "lost" so the caller keeps failing open.
    rebuilding = true;
    try {
      program = buf = tex = null;
      build();
      lost = false;
    } catch {
      lost = true;
    } finally {
      rebuilding = false;
    }
  };
  canvas.addEventListener("webglcontextlost", onLost, false);
  canvas.addEventListener("webglcontextrestored", onRestored, false);

  return {
    name: "webgl",
    originBottom: true, // gl.readPixels rows are bottom-up
    get lost() { return lost || gl.isContextLost(); },
    draw(source, srcW, srcH, outW, outH) {
      if (lost || rebuilding) throw new Error("framefilter: webgl context is lost");
      gl.viewport(0, 0, outW, outH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.useProgram(program);
      gl.uniform2f(uSrcSize, srcW, srcH);
      gl.uniform2f(uOutSize, outW, outH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    readPixel(x, y) {
      const px = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost, false);
      canvas.removeEventListener("webglcontextrestored", onRestored, false);
      safeCall(() => gl.deleteTexture(tex));
      safeCall(() => gl.deleteBuffer(buf));
      safeCall(() => gl.deleteProgram(program));
      safeCall(() => gl.getExtension("WEBGL_lose_context")?.loseContext());
    },
  };
}

// ---------------------------------------------------------------------------
// 2D Canvas fallback: CPU Scale2x into a low-res offscreen, then a NEAREST
// drawImage upscale. Slower than the GPU path but universally available.
//
// PALETTE PRESERVATION: the upscale MUST stay NEAREST
// (imageSmoothingEnabled=false). Bilinear smoothing blends neighbouring output
// pixels and invents colours that never existed in the source palette, which
// would break the module's core claim. Nearest keeps every presented colour a
// member of the source palette, matching the WebGL path's NEAREST sampling.
// ---------------------------------------------------------------------------
function create2dBackend(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  const make = (w, h) => {
    const c = canvas.ownerDocument.createElement("canvas");
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c;
  };
  const low = make(1, 1);
  const lowCtx = low.getContext("2d", { willReadFrequently: true });
  const doubled = make(1, 1);
  const doubledCtx = doubled.getContext("2d", { willReadFrequently: true });
  if (!lowCtx || !doubledCtx) return null;
  lowCtx.imageSmoothingEnabled = false;
  doubledCtx.imageSmoothingEnabled = false;
  return {
    name: "canvas2d",
    originBottom: false, // ImageData rows are top-down
    lost: false,
    draw(source, srcW, srcH, outW, outH) {
      if (low.width !== srcW || low.height !== srcH) { low.width = srcW; low.height = srcH; }
      lowCtx.drawImage(source, 0, 0, srcW, srcH);
      const frame = lowCtx.getImageData(0, 0, srcW, srcH);
      const scaled = scale2x(frame.data, srcW, srcH);
      const dw = srcW * 2, dh = srcH * 2;
      if (doubled.width !== dw || doubled.height !== dh) { doubled.width = dw; doubled.height = dh; }
      const img = doubledCtx.createImageData(dw, dh);
      img.data.set(scaled);
      doubledCtx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false; // NEAREST: never invent palette colours
      ctx.drawImage(doubled, 0, 0, outW, outH);
    },
    readPixel(x, y) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return new Uint8Array([d[0], d[1], d[2], d[3]]);
    },
    dispose() { low.width = low.height = 0; doubled.width = doubled.height = 0; },
  };
}

// ---------------------------------------------------------------------------
// mountFrameFilter
// ---------------------------------------------------------------------------
export function mountFrameFilter(iframe, options = {}) {
  if (!iframe || typeof iframe.getBoundingClientRect !== "function") {
    throw new TypeError("mountFrameFilter: a same-origin iframe element is required");
  }
  const doc = options.doc ?? iframe.ownerDocument ?? null;
  const win = options.win ?? doc?.defaultView ?? null;
  if (!doc || typeof doc.createElement !== "function") {
    throw new TypeError("mountFrameFilter: a document is required to host the overlay canvas");
  }

  const backendPreference = options.backend ?? "auto"; // 'auto' | 'webgl' | 'canvas2d'
  let mode = normalizeMode(options.mode);
  let attached = options.autoAttach !== false;
  let destroyed = false;

  const errors = [];
  const recordError = (where, err) => {
    const entry = { where, message: err?.message ?? String(err), at: Date.now() };
    errors.push(entry);
    if (errors.length > 20) errors.shift();
  };

  // --- overlay canvas -------------------------------------------------------
  const overlay = doc.createElement("canvas");
  overlay.className = "u8-filter-overlay";
  overlay.setAttribute("data-u8-filter", "overlay");
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "fixed";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.pointerEvents = "none";   // never intercept native click/touch
  overlay.style.display = "none";
  overlay.style.zIndex = String(options.zIndex ?? 0);
  overlay.style.imageRendering = "auto";
  const host = iframe.parentElement ?? doc.body ?? doc.documentElement;
  host?.appendChild?.(overlay);

  // --- backends -------------------------------------------------------------
  let backend = null;
  let backendName = null;
  function ensureBackend() {
    if (backend || destroyed) return backend;
    try {
      if (backendPreference !== "canvas2d") {
        backend = createGlBackend(overlay);
        if (backend) backendName = "webgl";
      }
      if (!backend && backendPreference !== "webgl") {
        backend = create2dBackend(overlay);
        if (backend) backendName = "canvas2d";
      }
    } catch (err) {
      recordError("backend", err);
      backend = null;
    }
    return backend;
  }

  // --- source canvas discovery ---------------------------------------------
  let source = null;
  let sourceCtxLost = false;       // set by the source canvas's contextlost event
  let watchedSource = null;
  const onSourceLost = (e) => { e.preventDefault?.(); sourceCtxLost = true; };
  const onSourceRestored = () => { sourceCtxLost = false; };
  function watchSource(el) {
    if (watchedSource === el) return;
    if (watchedSource) {
      safeCall(() => watchedSource.removeEventListener("webglcontextlost", onSourceLost));
      safeCall(() => watchedSource.removeEventListener("webglcontextrestored", onSourceRestored));
    }
    watchedSource = el;
    sourceCtxLost = false;
    if (el) {
      safeCall(() => el.addEventListener("webglcontextlost", onSourceLost));
      safeCall(() => el.addEventListener("webglcontextrestored", onSourceRestored));
    }
  }
  function findSource() {
    const cd = safeCall(() => iframe.contentDocument, null);
    if (!cd || typeof cd.getElementById !== "function") return null;
    const el = cd.getElementById(SOURCE_CANVAS_ID);
    if (!el || typeof el.getContext !== "function") return null;
    return el;
  }
  function ensureSource() {
    if (source && source.isConnected) return source;
    source = findSource();
    watchSource(source);
    return source;
  }

  // --- geometry -------------------------------------------------------------
  let metrics = { left: 0, top: 0, cssW: 0, cssH: 0 };
  function computeGeometry(canvas) {
    const iRect = safeCall(() => iframe.getBoundingClientRect(), null);
    const cRect = safeCall(() => canvas.getBoundingClientRect(), null);
    if (!iRect || !cRect || cRect.width <= 0 || cRect.height <= 0) return false;
    metrics = {
      left: Math.round(iRect.left + cRect.left),
      top: Math.round(iRect.top + cRect.top),
      cssW: cRect.width,
      cssH: cRect.height,
    };
    return true;
  }
  function applyOverlayStyle(cssW, cssH) {
    overlay.style.left = `${metrics.left}px`;
    overlay.style.top = `${metrics.top}px`;
    overlay.style.width = `${cssW}px`;
    overlay.style.height = `${cssH}px`;
  }

  // --- fail-open bookkeeping -----------------------------------------------
  let failOpen = false;
  let staleCount = 0;             // CONSECUTIVE stale probes (not per-tick)
  let probeGated = false;         // current fail-open needs a clean probe to clear
  const probeScratch = doc.createElement("canvas");
  const probeCtx = safeCall(() => probeScratch.getContext("2d", { willReadFrequently: true }), null);

  const PIXEL_FLOOR = 6; // <=6 on every channel, in both paths, counts as "black"
  function isLit(px) { return px[3] !== 0 && (px[0] > PIXEL_FLOOR || px[1] > PIXEL_FLOOR || px[2] > PIXEL_FLOOR); }

  // Reads the source through a 2D canvas (the path the browser composites, so
  // it stays valid for a WebGL source whose drawing buffer is not preserved).
  // Returns true when viewable pixels are present, false for a genuinely dark
  // frame, and throws on a hard capture failure (e.g. a tainted canvas) so the
  // caller can fail open instead of pretending the frame is fine.
  function sourceHasContent(canvas, srcW, srcH) {
    if (!probeCtx) return true; // cannot judge; assume the GPU path is fine
    const n = Math.min(srcW, 16);
    const m = Math.min(srcH, 16);
    probeScratch.width = srcW; probeScratch.height = srcH;
    probeCtx.clearRect(0, 0, srcW, srcH);
    probeCtx.drawImage(canvas, 0, 0, srcW, srcH);
    const px = probeCtx.getImageData(0, 0, n, m).data;
    for (let i = 0; i < px.length; i += 4) if (isLit(px.subarray(i, i + 4))) return true;
    return false;
  }

  // Samples the presented overlay at a few points and reports whether any is
  // lit. A cleared / non-preserved framebuffer reads back fully transparent
  // black, which is exactly what this detects.
  function overlayHasContent(be, outW, outH) {
    const xs = outW > 4 ? [Math.floor(outW / 2), Math.floor(outW / 4), Math.floor((3 * outW) / 4)] : [0];
    const ys = outH > 4 ? [Math.floor(outH / 2), Math.floor(outH / 4), Math.floor((3 * outH) / 4)] : [0];
    for (const y of ys) {
      for (const x of xs) {
        if (isLit(be.readPixel(x, y))) return true;
      }
    }
    return false;
  }

  // --- render loop ----------------------------------------------------------
  let rafId = null;
  let running = false;
  let renderCount = 0;
  let lastTs = 0;
  let frameLast = 0, frameSum = 0, frameMax = 0, frameSamples = 0, slowFrames = 0;
  let ticks = 0;

  function hideOverlay() { overlay.style.display = "none"; }

  function renderOnce(ts) {
    ticks += 1;
    if (mode !== "modern") { hideOverlay(); frameLast = 0; return; }
    const canvas = ensureSource();
    if (!canvas) { enterFailOpen("no-source-canvas"); return; }
    if (sourceCtxLost) { enterFailOpen("source-context-lost"); return; }
    const srcW = Number(canvas.width) || 0;
    const srcH = Number(canvas.height) || 0;
    if (srcW <= 0 || srcH <= 0) { enterFailOpen("source-zero-size"); return; }

    const be = ensureBackend();
    if (!be) { enterFailOpen("no-presentation-backend"); return; }
    if (be.lost) { enterFailOpen("presentation-context-lost"); return; }

    if (!computeGeometry(canvas)) { hideOverlay(); return; }

    // Device-pixel output resolution keeps the Scale2x edges crisp.
    const dpr = Math.min(Math.max(Number(win?.devicePixelRatio) || 1, 1), 3);
    const outW = Math.max(1, Math.round(metrics.cssW * dpr));
    const outH = Math.max(1, Math.round(metrics.cssH * dpr));
    if (overlay.width !== outW || overlay.height !== outH) { overlay.width = outW; overlay.height = outH; }

    let healthy = true;      // this tick has positive evidence the capture works
    let probeOK = false;     // a probe ran and found the presentation fresh
    try {
      be.draw(canvas, srcW, srcH, outW, outH);
    } catch (err) {
      recordError("draw", err);
      healthy = false;
      enterFailOpen("draw-threw");
      return;
    }

    // Bounded periodic freshness probe. It runs unconditionally every
    // GL_SAMPLE_PERIOD ticks so a cleared / non-preserved source framebuffer is
    // caught even after the source size has settled, and staleCount counts
    // CONSECUTIVE stale probes (not intervening ticks) so the threshold is
    // actually reachable. A source that is genuinely dark reads as "no content"
    // on both paths and is left running, never forced into fail-open.
    if (ticks % GL_SAMPLE_PERIOD === 0) {
      let srcHas;
      try {
        srcHas = sourceHasContent(canvas, srcW, srcH);
      } catch (err) {
        recordError("probe", err);
        healthy = false;
        probeGated = true;
        enterFailOpen("capture-failed");
        return;
      }
      let outHas = true;
      try { outHas = overlayHasContent(be, outW, outH); } catch { outHas = true; }
      const stale = srcHas && !outHas;
      staleCount = stale ? staleCount + 1 : 0;
      probeOK = !stale;
      if (staleCount >= GL_FAIL_THRESHOLD) {
        healthy = false;
        probeGated = true;
        enterFailOpen("stale-capture");
        return;
      }
    }

    // Recover from a transient fail-open once this tick is healthy again. A
    // probe-gated failure (stale capture / capture failure) additionally needs
    // a CLEAN probe, so it cannot clear between the sparse probe ticks and mask
    // an ongoing capture problem.
    if (failOpen && healthy && (!probeGated || probeOK)) { failOpen = false; error = null; probeGated = false; }

    if (!failOpen) {
      applyOverlayStyle(metrics.cssW, metrics.cssH);
      overlay.style.display = "block";
      renderCount += 1;
      if (lastTs) {
        const interval = ts - lastTs;
        frameLast = interval;
        frameSum += interval;
        frameSamples += 1;
        if (interval > frameMax) frameMax = interval;
        if (interval > SLOW_FRAME_MS) slowFrames += 1;
      }
      lastTs = ts;
    }
  }

  let error = null;
  function enterFailOpen(reason) {
    if (!failOpen) {
      failOpen = true;
      error = reason;
      recordError("fail-open", reason);
    }
    hideOverlay();
    lastTs = 0;
  }

  function loop(ts) {
    if (!running) return;
    rafId = win?.requestAnimationFrame ? win.requestAnimationFrame(loop) : null;
    if (safeCall(() => doc.hidden, false)) return; // tab hidden: no wasted work
    try { renderOnce(ts); } catch (err) { recordError("loop", err); }
  }

  function startLoop() {
    if (running || destroyed) return;
    if (!win || typeof win.requestAnimationFrame !== "function") return;
    running = true;
    rafId = win.requestAnimationFrame(loop);
  }
  function stopLoop() {
    running = false;
    if (rafId != null && typeof win?.cancelAnimationFrame === "function") win.cancelAnimationFrame(rafId);
    rafId = null;
  }

  // --- resize / context listeners ------------------------------------------
  const onResize = () => { lastTs = 0; };
  const onVisibility = () => { lastTs = 0; };
  safeCall(() => win?.addEventListener("resize", onResize, { passive: true }));
  safeCall(() => win?.addEventListener("orientationchange", onResize, { passive: true }));
  safeCall(() => doc.addEventListener("visibilitychange", onVisibility));
  let observer = null;
  if (typeof win?.ResizeObserver === "function" && host) {
    observer = new win.ResizeObserver(onResize);
    safeCall(() => observer.observe(iframe));
  }

  // --- public API -----------------------------------------------------------
  function attach() {
    if (destroyed) return;
    attached = true;
    startLoop();
    if (mode !== "modern") hideOverlay();
  }
  function detach() {
    attached = false;
    stopLoop();
    hideOverlay();
  }
  function setMode(next) {
    const m = normalizeMode(next);
    if (m === mode) return mode;
    mode = m;
    lastTs = 0;
    failOpen = false;
    staleCount = 0;
    probeGated = false;
    error = null;
    if (m === "classic") { stopLoop(); hideOverlay(); }
    else if (attached) startLoop();
    return mode;
  }

  // Deterministic single-frame draw + readback, used by the browser test page
  // and available to the host for exact GPU==CPU verification. renderFrame()
  // performs one presentation pass (no rAF); samplePixel(x, y) then reads the
  // presented overlay in TOP-LEFT image coordinates, so it matches the CPU
  // Scale2x output and ImageData conventions regardless of backend.
  function renderFrame() {
    if (destroyed) return false;
    const now = (typeof win?.performance?.now === "function") ? win.performance.now() : Date.now();
    renderOnce(now);
    return mode === "modern" && !failOpen;
  }
  function samplePixel(x, y) {
    if (destroyed || !backend) return null;
    const yy = backend.originBottom ? overlay.height - 1 - y : y;
    try { return Array.from(backend.readPixel(x, yy)); } catch { return null; }
  }
  function stats() {
    const canvas = source;
    return {
      filter: "scale2x",
      mode,
      attached,
      running,
      active: mode === "modern" && !failOpen && overlay.style.display !== "none",
      failOpen,
      error,
      backend: backendName,
      source: {
        found: Boolean(canvas),
        id: SOURCE_CANVAS_ID,
        width: Number(canvas?.width) || 0,
        height: Number(canvas?.height) || 0,
      },
      overlay: {
        mounted: Boolean(overlay.isConnected),
        width: overlay.width,
        height: overlay.height,
        cssWidth: Math.round(metrics.cssW),
        cssHeight: Math.round(metrics.cssH),
      },
      renderCount,
      frames: {
        lastMs: Math.round(frameLast * 100) / 100,
        avgMs: frameSamples ? Math.round((frameSum / frameSamples) * 100) / 100 : 0,
        maxMs: Math.round(frameMax * 100) / 100,
        samples: frameSamples,
        slowFrames,
      },
      errors: errors.slice(),
    };
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopLoop();
    safeCall(() => win?.removeEventListener("resize", onResize));
    safeCall(() => win?.removeEventListener("orientationchange", onResize));
    safeCall(() => doc.removeEventListener("visibilitychange", onVisibility));
    safeCall(() => observer?.disconnect());
    watchSource(null);
    safeCall(() => backend?.dispose());
    backend = null;
    safeCall(() => overlay.remove());
    source = null;
  }

  if (attached) startLoop();

  return { setMode, getMode: () => mode, attach, detach, stats, destroy, renderFrame, samplePixel };
}

export { normalizeMode as _normalizeMode };
