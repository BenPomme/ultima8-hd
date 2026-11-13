// shell/ui/app.js
// Boots the game shell: builds state from the saved profile, renders the active
// screen, routes keyboard/touch input through the bridge, mounts the real engine
// surface, and plays feedback from real engine combat events.
//
// Default mode is the REAL bridge: the shell mounts the ScummVM build (the
// same-origin engine page one directory up) and speaks the frozen v1 contract.
// The mock bridge is a development-only path selected with ?dev / ?bridge=mock /
// localStorage ultima8.dev.mock=1 / window.__U8_DEV_MOCK__; it exists so the Node
// suites and the UI-wiring harness can observe commands, never to fake
// playability and never as the product default.
import { createUiState, SCREEN, navigate, setPlayerName, commitPlayerName, setMode, setSetting, beginRebind, captureRebind, cancelRebind, keyToCommand, currentBindings, isPassthroughMode, engineSpeed, hudModel } from "./state.js";
import { renderScreen } from "./screens.js";
import { mountTouchControls, buttonAction, stickAction } from "./touch.js";
import { createShellBridge, resolveBridgeMode } from "./bridge.js";
import { ENGINE_EVENT, OPTION } from "./contract.js";
import { ACTIONS, MOVE_ACTIONS } from "../core/actions.js";
import { mountFeedback } from "./feedback/index.js";
import { createHaptics } from "./feedback/haptics.js";
import { downloadBytes, pickSaveFile, saveFileName } from "./saves.js";
import { loadSettings, saveSettings } from "./persist.js";
import { effectiveSettings } from "../core/settings.js";
import { mountFrameFilter } from "../visual/framefilter.js";
// [W3 click-move] Isolated wiring block. Pure decisions come from
// core/input/clickmove.js; the pointer-transparent destination overlay comes
// from visual/clickmarker.js. Both stay inert on a build without the published
// path constants (see PATH_ACTION_IDS): nothing here synthesises movement.
import {
  detectPathCapability, effectiveClickToMove, normalizeViewport, mapClientToLogical,
  classifyClick, createClickMover, PLAY_SCREEN, facadePathMethods, liveFacade,
  readGumpRects, clickBlockReason, CANCEL,
} from "../core/input/clickmove.js";
import { mountClickMarker, logicalToClientPoint, markerModel } from "../visual/clickmarker.js";
import { downloadFont, createFontStore, chooseFontId, fontFor, musicPanelState, musicSourceOptionValue, isGmAchieved, musicEnv } from "./music.js";
import { saveResumeToken, readResumeToken, clearResumeToken, withSaveSlot } from "./reboot.js";
import { UI_TEXT as T } from "./config.js";

function safeStorage(win) {
  try { return win.localStorage ?? null; } catch { return null; }
}

function safeSession(win) {
  try { return win.sessionStorage ?? null; } catch { return null; }
}

function isTextTarget(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable === true;
}

// [W3 click-move] Touch-primary detection for the click-move gate: the on-screen
// stick stays primary on touch, so click-to-move is off there (contract).
function isTouchPrimary(win) {
  try { return Boolean(win?.matchMedia?.("(pointer: coarse)")?.matches); } catch { return false; }
}

// [W4 click-move] The engine's own W2 facade is reached DIRECTLY as
// frame.contentWindow.Ultima8Bridge (walkTo/cancelWalk). Resolved lazily so a
// reload is picked up; cross-origin or unmounted frames resolve to null.
function frameWindow(frame) {
  try { return frame?.contentWindow ?? null; } catch { return null; }
}
function pathPair(frame) {
  return facadePathMethods(liveFacade(frameWindow(frame)));
}

export function boot(win = window, doc = document) {
  const storage = safeStorage(win);
  const isMobile = isTouchPrimary(win);
  // CP68: load settings with device-aware default; if null (fresh), pass device default to createUiState
  const loaded = loadSettings(storage, isMobile);
  const freshDefault = loaded ?? { artMode: isMobile ? "classic" : "hd2" };
  let state = createUiState(freshDefault);

  const mode = resolveBridgeMode(win, doc, storage);
  const bridge = createShellBridge({ mode, win, doc });

  const root = doc.getElementById("app");
  state = { ...state, root, returnTo: SCREEN.TITLE };

  // CP68 artMode preboot key: write u8_art_mode BEFORE iframe creation
  try { storage?.setItem?.("u8_art_mode", state.settings.artMode); } catch { /* best-effort */ }

  // --- persistent overlays (never rebuilt by a screen render) -------------
  const engineHost = doc.createElement("div");
  engineHost.id = "u8-engine";
  engineHost.className = "engine-host";
  engineHost.setAttribute("data-test", "engine-host");
  doc.body.append(engineHost);

  const fx = doc.createElement("div");
  fx.id = "u8-fx";
  fx.className = "u8-fx";
  fx.setAttribute("aria-hidden", "true");
  const statusEl = doc.createElement("div");
  statusEl.className = "u8-status";
  fx.append(statusEl);
  doc.body.append(fx);

  // Visible "tap to enable sound" retry: shown ONLY while the engine's real
  // SDL3 AudioContext is genuinely suspended. Nothing here forces autoplay --
  // the tap is the trusted gesture the browser requires, and it reuses the same
  // resume path as the first pointerdown/keydown.
  const tapSound = doc.createElement("button");
  tapSound.type = "button";
  tapSound.className = "u8-tap-sound";
  tapSound.setAttribute("data-test", "tap-sound");
  tapSound.textContent = "Tap to enable sound";
  tapSound.addEventListener("pointerdown", (ev) => { ev.preventDefault?.(); unlockOnce(); updateAudioUi(); });
  fx.append(tapSound);

  const feedback = mountFeedback(fx, {
    doc,
    shakeTarget: root,
    haptics: createHaptics({ navigator: win.navigator }),
    onStatus: (event, text) => {
      if (!text) return;
      statusEl.textContent = text;
      statusEl.dataset.tone = event.kind;
      statusEl.classList.add("on");
      const t = setTimeout(() => statusEl.classList.remove("on"), 1200);
      statusEl.dataset.timer = String(t);
    },
  });
  // Feedback is driven ONLY by engine-originated combat events, never a button.
  if (typeof bridge.onCombat === "function") bridge.onCombat((event) => feedback.handle(event));

  // The live status line doubles as a completion toast. Save/load results come
  // ONLY from the engine's own SAVE_RESULT/LOAD_RESULT events (the same ones an
  // in-game F1 or a queued save() produces), so a real completion is visible
  // instead of quietly queued forever -- and nothing here fabricates one.
  function toastStatus(text, tone) {
    if (!text) return;
    statusEl.textContent = text;
    statusEl.dataset.tone = tone || "block";
    statusEl.classList.add("on");
    const t = setTimeout(() => statusEl.classList.remove("on"), 1600);
    statusEl.dataset.timer = String(t);
  }
  if (typeof bridge.onEngineEvent === "function") {
    bridge.onEngineEvent((e) => {
      if (!e) return;
      if (e.type === ENGINE_EVENT.SAVE_RESULT) toastStatus(e.b === 1 ? "Game saved" : "Save failed", e.b === 1 ? "block" : "hurt");
      else if (e.type === ENGINE_EVENT.LOAD_RESULT) toastStatus(e.b === 1 ? "Game loaded" : "Load failed", e.b === 1 ? "block" : "hurt");
    });
  }

  // --- real engine surface -------------------------------------------------
  // The iframe must be mounted BEFORE anything waits for world-ready, or the
  // engine would never start. mountEngine() creates/appends the frame first,
  // then lets the bridge's readiness pump run. The name screen mounts it too:
  // the game boots its own menu underneath the shell's native name proxy.
  let engineMounted = false;
  let frameFilter = null;
  function ensureFilter(frame) {
    if (!frame) return;
    try { frameFilter = mountFrameFilter(frame, { mode: state.settings.mode, autoAttach: false }); }
    catch { frameFilter = null; }
  }
  async function mountEngine() {
    if (bridge.mode !== "real" || engineMounted) return;
    engineMounted = true;
    try {
      const connecting = bridge.connect?.();
      const frame = bridge.element;
      if (frame && frame.parentNode !== engineHost) {
        frame.classList.add("engine-frame");
        engineHost.append(frame);
      }
      attachFrameKeys(frame);
      ensureFilter(frame);
      frame.addEventListener("load", () => attachFrameClicks(frame));
      await connecting;
      attachFrameClicks(frame);
    } catch (err) {
      setMessage(`Could not start the game: ${err?.message ?? err}`);
    }
  }

  // A second key listener inside the (same-origin) engine document, because a
  // focused iframe swallows the parent page's key events. Modern bound actions
  // are OWNED here: the event is stopped before the engine's own keymapper can
  // see it, so one physical key == one shell dispatch (no double input). Every
  // other key (Classic, the engine's own menu keys, pre-world) is left alone so
  // the engine keeps its original keymapper.
  function attachFrameKeys(frame) {
    if (!frame) return;
    if (!frame.__u8KeyLoadWired) {
      frame.__u8KeyLoadWired = true;
      frame.addEventListener("load", () => attachFrameKeys(frame));
    }
    let cw = null, cd = null;
    try { cw = frame.contentWindow; cd = cw && cw.document; } catch { cw = null; }
    if (!cw || !cd || typeof cw.addEventListener !== "function") return;
    if (cd.__u8FrameKeys) return;
    cd.__u8FrameKeys = true;
    const make = (phase) => (ev) => {
      if (isTextTarget(ev.target)) return;
      const cmd = keyToCommand(state, ev.code, phase);
      // Modern bound actions are owned ONLY for a genuinely movable world: while
      // the intro/dialogue still owns input (STASIS 1) the engine keeps its own
      // keys, so Space advances the conversation instead of jumping. Rebind
      // capture is owned on any screen.
      const owns = cmd.kind === "rebind-capture" || (cmd.kind === "action" && worldPlayable());
      if (!owns) return;
      ev.preventDefault?.();
      ev.stopImmediatePropagation?.();
      handleCommand(cmd, ev.code, phase, ev.repeat);
    };
    const unlock = () => unlockOnce();
    const h = frame.__u8KeyH || (frame.__u8KeyH = {
      down: make("down"), up: make("up"), unlock
    });
    h.flush || (h.flush = () => flushInputs());
    h.vis || (h.vis = (e) => { if (e.currentTarget.visibilityState === "hidden") flushInputs(); });
    try {
      cw.addEventListener("keydown", h.down, true);
      cw.addEventListener("keyup", h.up, true);
      cw.addEventListener("blur", h.flush);
      cw.addEventListener("pagehide", h.flush);
      cd.addEventListener("visibilitychange", h.vis);
      // A focused iframe swallows parent gestures too; retry the audio unlock
      // from inside the engine document as well.
      for (const evt of ["pointerdown", "keydown", "touchstart"]) {
        cw.addEventListener(evt, h.unlock, { passive: true });
      }
    } catch { /* detached/cross-origin: the parent listener still covers unfocused keys */ }
  }

  // [W4 click-move] The pointer path: a single left click on the engine canvas
  // during live PLAY walks the Avatar through W2's OWN native facade
  // (Ultima8Bridge.walkTo / cancelWalk, command queue ids 9/10). INERT unless
  // PATH_STATE is published (>= 1) AND the facade exposes the method pair --
  // both false on the accepted 7ec build. It never synthesises movement keys,
  // never teleports and never invents a destination. Native keys/touch/pause/
  // text/dialogue (incl. Classic) are untouched: every gate declines first.
  let clickCtl = null;
  function attachFrameClicks(frame) {
    if (bridge.mode !== "real" || !frame) return;
    const cw = frameWindow(frame);
    const cdoc = cw?.document;
    if (!cdoc || typeof cdoc.addEventListener !== "function" || cdoc.__u8FrameClicks) return;
    cdoc.__u8FrameClicks = true;

    // Resolve W2's method pair lazily on each use (a reload can replace the
    // content window). Never cache the facade across navigations.
    let marker = frame.__u8ClickMarker || null;
    if (!marker || frame.__u8ClickMarkerDoc !== doc) {
      try { marker && marker.destroy && marker.destroy(); } catch {}
      try { marker = mountClickMarker(frame, { doc, win }); } catch { marker = null; }
      frame.__u8ClickMarker = marker; frame.__u8ClickMarkerDoc = doc;
    }
    const mover = createClickMover({
      walkTo: (x, y) => { const p = pathPair(frame); try { return p ? (Number(p.walkTo(x, y)) | 0) : 0; } catch { return 0; } },
      cancelWalk: () => { const p = pathPair(frame); try { return p ? (Number(p.cancelWalk()) | 0) : 0; } catch { return 0; } },
    });

    const snapNow = () => { try { return bridge.snapshot?.() ?? null; } catch { return null; } };
    const textNow = () => { try { const v = bridge.textPromptActive?.(); return typeof v === "boolean" ? v : null; } catch { return null; } };
    const canvasRect = () => { try { return cdoc.getElementById("canvas")?.getBoundingClientRect?.() ?? null; } catch { return null; } };
    const pageGeom = (cr) => {
      let ir = { left: 0, top: 0 };
      try { ir = frame.getBoundingClientRect?.() ?? ir; } catch { /* detached */ }
      return { left: (Number(ir.left) || 0) + (Number(cr.left) || 0), top: (Number(ir.top) || 0) + (Number(cr.top) || 0), width: cr.width, height: cr.height };
    };
    const enabled = () => {
      try { return clickMoveEnv().available && state.screen === SCREEN.PLAY && effectiveClickToMove(state.settings, { touchPrimary: isTouchPrimary(win) }); }
      catch { return false; }
    };
    const blocked = () => {
      const snap = snapNow();
      return Number(snap?.STASIS) === 1 || textNow() === true || pauseLease === true;
    };
    // Gump / overlay-UI blocking: a click inside any published GUMP_RECT (slots
    // 63..79) is never a walk. Reuses the frozen clickBlockReason contract.
    const gumpBlocked = (logical) => Boolean(clickBlockReason({
      available: true, ready: true, screen: state.screen, playScreen: SCREEN.PLAY,
      stasis: snapNow()?.STASIS, textInputActive: textNow(), pauseLease,
      point: logical, gumpRects: readGumpRects(snapNow()),
    }));

    // Redraw the pointer-transparent marker from the engine's own PATH_STATE /
    // PATH_SEQ; draws nothing when the build never reports an ACTIVE path.
    const redraw = () => {
      if (!marker) return;
      const snap = snapNow();
      const dest = mover.target();
      const model = markerModel({ pathState: snap ? Number(snap.PATH_STATE) : null, pathSeq: snap ? Number(snap.PATH_SEQ) : null, dest });
      if (!model.kind || !dest) { marker.clear(); return; }
      const pt = canvasRect();
      const vp = normalizeViewport(bridge.engineViewport?.());
      const client = pt ? logicalToClientPoint(vp, { x: model.x, y: model.y }, pageGeom(pt)) : null;
      if (client) marker.setMarker(model.kind, client);
    };

    let press = null;
    cdoc.addEventListener("pointerdown", (ev) => {
      press = null;
      if (!enabled()) return;
      // A second, non-primary input cancels a pending walk.
      if (ev.button !== 0) { if (mover.isActive()) { mover.cancel(CANCEL.SECOND_INPUT); redraw(); } return; }
      if (blocked()) return;
      press = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
    }, true);
    cdoc.addEventListener("pointerup", (ev) => {
      const p = press; press = null;
      if (!p || ev.button !== 0 || !enabled() || blocked()) return;
      if (classifyClick(p, { x: ev.clientX, y: ev.clientY, t: ev.timeStamp }).kind !== "click") return;
      const cr = canvasRect();
      if (!cr) return;
      const vp = normalizeViewport(bridge.engineViewport?.());
      const logical = mapClientToLogical({ x: ev.clientX, y: ev.clientY }, vp, { left: cr.left, top: cr.top, width: cr.width, height: cr.height });
      if (!logical) return;                 // letterbox bar / unmappable: not a game click
      if (gumpBlocked(logical)) return;     // GUMP_RECT_0..3 / overlay UI
      if (mover.handleClick(logical, undefined, null).kind === "walk") { try { ev.preventDefault?.(); } catch { /* optional */ } }
      redraw();
    }, true);
    cdoc.addEventListener("pointercancel", () => { press = null; }, true);

    clickCtl = {
      mover, marker, redraw,
      cancel: () => { try { const r = mover.cancel("move-key"); redraw(); return r; } catch { return null; } },
      tick: redraw,
      destroy: () => { try { marker?.destroy?.(); } catch { /* optional */ } clickCtl = null; },
    };
  }

  const isPlaylike = (screen) => screen === SCREEN.PLAY || screen === SCREEN.PAUSE;
  const dispatchAction = (action, context = {}) => {
    if (!action) return;
    // [W3 click-move] A bound movement key cancels a pending click-walk (the
    // native control always wins); a no-op when click-move is off/unavailable.
    if (clickCtl && MOVE_ACTIONS.includes(action) && clickCtl.mover?.isActive?.()) clickCtl.cancel();
    // Modern owns Quick save (Classic is passthrough and never reaches here).
    // Route it through the AWAIT-CONFIRMED facade.save exactly once so the
    // engine's real SAVE_RESULT -- and its toast -- is guaranteed, instead of
    // the untracked native QUICKSAVE action, which emits no bridge event.
    if (action === ACTIONS.QUICK_SAVE && bridge.isWorld() && !isPassthroughMode(state)) {
      if (context.down !== false) saveGame();
      return;
    }
    bridge.dispatch(action, context);
  };
  const persist = () => saveSettings(storage, state.settings);

  // Push the travel speed the labels promise to the live engine. Only
  // meaningful once a real world is READY; the engine confirms the applied rate
  // through its own SPEED_RATE state (never an optimistic local value).
  async function applyEngineSpeed() {
    if (bridge.mode !== "real" || !bridge.isWorld() || typeof bridge.setSpeed !== "function") return null;
    try { return await bridge.setSpeed(engineSpeed(state.settings)); } catch { return null; }
  }

  // Push the live music/SFX volumes, the always-run flag and the mode's music
  // source to the engine. Volumes are ConfMan 0..255; Classic keeps the
  // original FM driver, Modern requests General MIDI (the engine falls back to
  // FM honestly when no SoundFont is staged). Safe to call before READY: an
  // unconnected facade simply throws and is ignored.
  function applyAudioPrefs() {
    if (bridge.mode !== "real" || typeof bridge.setOption !== "function") return;
    const eff = effectiveSettings(state.settings);
    const to255 = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
    const set = (id, value) => { try { bridge.setOption(id, value); } catch { /* engine not ready */ } };
    set(OPTION.MUSIC_VOLUME, to255(eff.musicVolume));
    set(OPTION.SFX_VOLUME, to255(eff.sfxVolume));
    set(OPTION.ALWAYS_RUN, eff.alwaysRun ? 1 : 0);
    // The user's EXPLICIT source only: default FM keeps sending 0 through
    // every mode/audio-pref change until GM is actually chosen, so a Modern
    // mode toggle never silently switches the engine to a missing SoundFont.
    set(OPTION.MUSIC_SYNTH, musicSourceOptionValue(eff.musicSource));
  }

  // --- pause lease ----------------------------------------------------------
  // The engine's native pause is a REFERENCE COUNTER, not an idempotent setter,
  // so the UI owns exactly ONE lease: acquire raises it once, and only a
  // matching release lowers it. Engine-native pauses the UI did not request
  // (NPC dialogue, modals, INTRO stasis) are never touched because release()
  // is a no-op unless the UI itself owns the lease.
  let pauseLease = false;
  function acquirePause() {
    if (pauseLease) return;          // repeated Pause cannot stack the counter
    try { clickCtl?.cancel?.(); } catch { /* click-move off: nothing to cancel */ }   // [W3 click-move] native pause ends a pending walk
    pauseLease = true;
    try { bridge.pause?.(true); } catch { /* no facade yet */ }
  }
  function releasePause() {
    if (!pauseLease) return;         // never unpause an engine-native pause
    pauseLease = false;              // clear first: re-entrant go(PLAY) is safe
    try { bridge.pause?.(false); } catch { /* ignore */ }
  }

  // Any navigation that lands on the live PLAY screen ends a UI pause lease, so
  // Settings/Controls "Back" (returnTo PLAY) resumes the engine exactly once.
  function go(screen, patch = {}) {
    if (screen === SCREEN.PLAY) releasePause();
    state = { ...navigate(state, screen), ...patch };
    render();
  }

  function openSub(screen) {
    const returnTo = state.screen === SCREEN.SETTINGS || state.screen === SCREEN.REBIND ? state.returnTo : state.screen;
    go(screen, { returnTo: isPlaylike(returnTo) ? SCREEN.PLAY : returnTo });
  }

  // --- music source & enhanced instruments ---------------------------------
  // Settings>Music is the original FM score (default) or GM instruments for the
  // SAME score. The GM driver only changes on a RESTART: download + verify a
  // SoundFont, stage it into the engine, then really restart.
  let musicDownload = null;      // { font, controller } while a download is live
  let musicProgress = 0;
  let musicStaged = false;
  let musicError = null;
  let fallbackAttempted = false; // one (1) FM fallback per boot, never a loop
  let pendingResume = null;      // { source, resumeSlot } applied on the next WORLD
  let bootToken = null;
  let artReconciled = false;     // CP68: one reconciliation per boot after engine start

  function recommendedFont() { return fontFor(chooseFontId(musicEnv(win))); }

  // The engine's own rendered frame counter (STATE.FRAME), or null when the
  // build does not publish it. A queued ConfMan option is applied on a later
  // engine frame, so a CHANGE here proves the engine consumed what we queued.
  function engineFrame() {
    try {
      const snap = typeof bridge.snapshot === "function" ? bridge.snapshot() : null;
      if (snap && snap.FRAME !== undefined && snap.FRAME !== null) {
        const n = Number(snap.FRAME);
        return Number.isFinite(n) ? n : null;
      }
    } catch { /* unreadable: treat as unavailable */ }
    return null;
  }
  function frameDelay(ms) {
    const setT = win?.setTimeout ?? (typeof setTimeout !== "undefined" ? setTimeout : null);
    return setT ? new Promise((r) => setT(r, ms)) : Promise.resolve();
  }
  // Wait (bounded) for one real engine frame boundary after a queued option.
  // True only once FRAME moves past `before`; false on timeout or when no frame
  // counter exists (never a fake success).
  async function awaitEngineFrameBoundary(before, timeoutMs = 2500) {
    if (before === null) return false;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = engineFrame();
      if (now !== null && now !== before) return true;
      if (Date.now() >= deadline) return false;
      await frameDelay(40);
    }
  }
  // A failed/aborted download or a refused stage must NOT leave GM persisted as
  // the durable preference: revert to the FM the engine is actually playing.
  function revertMusicToFm() {
    if (state.settings.musicSource !== "gm") return;
    state = setSetting(state, "musicSource", "fm");
    persist();
    try { applyAudioPrefs(); } catch { /* engine not ready */ }
  }

  // Never restart while the engine owns an unmovable state (native text prompt
  // or opening STASIS); we never clear native control to force it through.
  function musicBlockedReason() {
    if (readTextPrompt() === true) return T.restartTextBlocked;
    try {
      const snap = typeof bridge.snapshot === "function" ? bridge.snapshot() : null;
      if (snap && Number(snap.STASIS) === 1) return T.restartStasis;
    } catch { /* unreadable field: do not block on a state we cannot see */ }
    return null;
  }

  function musicPanel() {
    const a = readAudio();
    const source = effectiveSettings(state.settings).musicSource;
    const info = musicPanelState({ audio: a, source, staged: musicStaged, downloading: !!musicDownload, progress: musicProgress, error: musicError });
    return { ...info, source, error: musicError, recommended: recommendedFont().id };
  }

  // CP61 art panel: the shell reads its stored artMode and the engine's live
  // state. If they differ, the shell calls setArtMode once to reconcile.
  function artPanel() {
    const stored = effectiveSettings(state.settings).artMode;
    const engineState = typeof bridge.getArtState === "function" ? bridge.getArtState() : null;
    const isMobile = isTouchPrimary(win);
    return { stored, engineState, isMobile };
  }

  function openMusicConfirm(source) {
    state = { ...state, musicConfirm: { source, notice: musicBlockedReason() } };
    render();
  }
  function setMusicNotice(notice) {
    state = { ...state, musicConfirm: state.musicConfirm ? { ...state.musicConfirm, notice } : null };
    render();
  }

  // Cache-first verified download, then stage into the engine and prove the
  // staged font + requested source are DURABLE, not just queued. The downloading
  // flag is cleared in a finally BEFORE the last render (never a stuck panel).
  // Any failure/abort reverts the durable preference to the FM the engine is
  // actually playing (a GM choice is never persisted by a failed download).
  async function startMusicDownload() {
    if (musicDownload) return;
    if (bridge.mode !== "real" || typeof bridge.setSoundFont !== "function") { musicError = T.engineError; render(); return; }
    const font = recommendedFont();
    const AC = win.AbortController ?? (typeof AbortController !== "undefined" ? AbortController : null);
    const controller = AC ? new AC() : null;
    musicDownload = { font, controller };
    musicProgress = 0;
    musicError = null;
    render();
    try {
      const env = musicEnv(win);
      const result = await downloadFont(font, {
        store: createFontStore(env), fetch: env.fetch, signal: controller?.signal, crypto: env.crypto,
        onProgress: (p) => { musicProgress = Number(p.ratio) || 0; render(); },
      });
      // The cache read may have resolved after a cancel: never stage then.
      if (controller?.signal?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      const staged = bridge.setSoundFont(result.bytes);
      if (staged !== 1) throw new Error("the game engine could not load the instruments");
      const frameBefore = engineFrame();
      try { bridge.setOption?.(OPTION.MUSIC_SYNTH, 1); } catch { /* the engine may not be ready */ }
      await awaitEngineFrameBoundary(frameBefore);
      let durable = null;
      try { durable = typeof bridge.flushPersist === "function" ? await bridge.flushPersist() : null; } catch { durable = false; }
      if (durable !== true) throw new Error(T.musicStageError);
      musicStaged = true;
      musicDownload = null;
      openMusicConfirm("gm");
    } catch (err) {
      revertMusicToFm();
      if (err?.name !== "AbortError") musicError = err?.message ?? String(err);
    } finally {
      musicDownload = null;      // cleared before the final render
      render();
    }
  }

  function cancelMusicDownload() {
    if (musicDownload?.controller) { try { musicDownload.controller.abort(); } catch { /* ignore */ } }
    musicDownload = null;
    musicProgress = 0;
    render();
  }

  function chooseMusic(source) {
    // FM-ONLY FALLBACK (host-applied last resort): the General MIDI installer
    // is disabled, so the enhanced soundtrack can never be requested. The FM
    // path, boot guard, controls, pause lease and save flow are untouched.
    if (source !== "fm") return;
    if (source === "fm") {
      const wasGm = state.settings.musicSource === "gm";
      state = setSetting(state, "musicSource", "fm");
      persist();
      applyAudioPrefs();
      if (wasGm) openMusicConfirm("fm"); else render();
      return;
    }
    state = setSetting(state, "musicSource", "gm");
    persist();
    render();
    if (musicStaged || isGmAchieved(readAudio())) { openMusicConfirm("gm"); return; }
    startMusicDownload();
  }

  // Persist choice + durable resume token, apply the option and WAIT for the
  // engine to consume it (a real frame boundary), then require a confirmed
  // durable flush BEFORE tearing anything down. A token that cannot be stored,
  // an option the engine never consumes, or a flush that does not confirm all
  // refuse the restart with a visible error: nothing is torn down and the token
  // is not consumed (no restart on a false/queued flush).
  async function doMusicRestart(source, resume) {
    state = setSetting(state, "musicSource", source);
    persist();
    const token = { source, resumeSlot: resume ? 1 : null };
    if (!saveResumeToken(safeSession(win), token)) { setMusicNotice(T.restartStorageError); return; }
    const frameBefore = engineFrame();
    try { bridge.setOption?.(OPTION.MUSIC_SYNTH, musicSourceOptionValue(source)); } catch { /* applied on boot */ }
    await awaitEngineFrameBoundary(frameBefore);
    let durable = null;
    try { durable = typeof bridge.flushPersist === "function" ? await bridge.flushPersist() : null; } catch { durable = false; }
    if (durable !== true) {
      clearResumeToken(safeSession(win));       // do not autoboot a restart we refused
      setMusicNotice(T.restartFlushError);
      return;
    }
    // Release ONLY the UI-owned lease on the OLD engine before it is torn down,
    // so the fresh engine starts with a clean pause counter (never an unpause of
    // an engine-native pause), and drop the OLD frame's filter before the new
    // attach. A new SDL3 AudioContext starts suspended, so allow a fresh
    // trusted gesture to unlock it again.
    releasePause();
    try { frameFilter?.destroy?.(); } catch { /* best-effort */ }
    frameFilter = null;
    audioUnlocked = false;
    const url = resume ? withSaveSlot(bridge.engineUrl ?? "", 1) : null;
    state = { ...state, musicConfirm: null };
    render();
    let done = null;
    try { done = typeof bridge.restart === "function" ? bridge.restart(url ? { engineUrl: url } : {}) : null; } catch { done = null; }
    // Mount the fresh engine surface NOW (render -> mountEngine appends the new
    // iframe) instead of waiting for readiness; a failed connect stays an error
    // (onPhase reports it) and is never treated as success.
    applyResume(token);
    if (done && typeof done.then === "function") done.catch(() => { /* onPhase reports the error */ });
  }

  async function confirmMusicRestart(choice) {
    const d = state.musicConfirm;
    if (!d) return;
    // Later keeps the current world (and any engine pause) untouched.
    if (choice === "later") { state = { ...state, musicConfirm: null }; render(); return; }
    const blocked = musicBlockedReason();
    if (blocked) { setMusicNotice(blocked); return; }
    let resume = false;
    if (choice === "save") {
      if (bridge.mode !== "real" || typeof bridge.save !== "function") { setMusicNotice(T.restartSaveFailed); return; }
      // Confirmed save (SAVE_RESULT ok=1) + durable flush BEFORE any restart.
      try { await bridge.save(1); } catch { setMusicNotice(T.restartSaveFailed); return; }
      resume = true;
    }
    await doMusicRestart(d.source, resume);
  }

  // CP69 art restart: mirror doMusicRestart exactly, using the same token path.
  // Art selection lives in settings/key; restart token carries current musicSource.
  async function doArtRestart(artMode, resume) {
    state = setSetting(state, "artMode", artMode);
    persist();
    try { storage?.setItem?.("u8_art_mode", artMode); } catch { /* best-effort */ }
    // When native is not running yet (title screen), just persist—no restart.
    if (!bridge.isWorld()) { render(); return; }
    // When native is running, mirror doMusicRestart: save current musicSource in token.
    const token = { source: state.settings.musicSource, resumeSlot: resume ? 1 : null };
    if (!saveResumeToken(safeSession(win), token)) { toastStatus(T.restartStorageError, "hurt"); return; }
    const frameBefore = engineFrame();
    try { bridge.setArtMode?.(artMode); } catch { /* applied on boot */ }
    await awaitEngineFrameBoundary(frameBefore);
    let durable = null;
    try { durable = typeof bridge.flushPersist === "function" ? await bridge.flushPersist() : null; } catch { durable = false; }
    if (durable !== true) {
      clearResumeToken(safeSession(win));
      toastStatus(T.restartFlushError, "hurt");
      return;
    }
    releasePause();
    try { frameFilter?.destroy?.(); } catch { /* best-effort */ }
    frameFilter = null;
    audioUnlocked = false;
    const url = resume ? withSaveSlot(bridge.engineUrl ?? "", 1) : null;
    render();
    let done = null;
    try { done = typeof bridge.restart === "function" ? bridge.restart(url ? { engineUrl: url } : {}) : null; } catch { done = null; }
    applyResume(token);
    if (done && typeof done.then === "function") done.catch(() => { /* onPhase reports the error */ });
  }

  // Consume a restart token: clear it, skip the title, really mount the engine
  // and (for a saved restart) issue a real load(1) once READY.
  function applyResume(token) {
    if (!token) return;
    clearResumeToken(safeSession(win));
    pendingResume = { ...token, resumeSlot: token.resumeSlot === 1 ? 1 : null };
    engineMounted = false;
    state = navigate(state, SCREEN.PLAY);
    render();
  }

  // ONE honest FM fallback per boot (synth != 2 / font not loaded): force FM,
  // flush, restart once. Never a loop.
  function checkMusicFallback(resumeSlot = null) {
    if (fallbackAttempted) return;
    if (state.settings.musicSource !== "gm") return;
    const a = readAudio();
    if (!a) return;                 // no accessor: never guess, never loop
    if (isGmAchieved(a)) return;
    fallbackAttempted = true;
    toastStatus(T.fallbackNotice, "hurt");
    doMusicRestart("fm", resumeSlot === 1);
  }

  function readBootStatus() {
    try { const v = typeof bridge.bootStatus === "function" ? bridge.bootStatus() : null; return v ?? (win.Ultima8BootStatus ?? null); }
    catch { return null; }
  }
  function maybeShowBootFallback(bs) {
    if (!bs || typeof bs !== "object" || !(bs.fallback || bs.timedOut)) return;
    toastStatus(`${T.fallbackNotice}${bs.reason ? ` (${bs.reason})` : ""}`, "hurt");
  }
  try { win.addEventListener?.("u8:boot-status", (ev) => maybeShowBootFallback(ev?.detail ?? readBootStatus())); } catch { /* optional */ }

  // --- save export / import (real engine files only) -----------------------
  let message = "";
  function setMessage(text) { message = text; render(); }
  async function exportSave() {
    if (bridge.mode !== "real" || typeof bridge.exportSave !== "function") { setMessage("Saving needs the game engine."); return; }
    try {
      const bytes = await bridge.exportSave(1);
      downloadBytes(doc, saveFileName(state.playerName || "avatar", 1), bytes);
      message = "";
    } catch (err) {
      setMessage(`Could not export save: ${err?.message ?? err}`);
      return;
    }
    render();
  }
  async function importSave() {
    if (bridge.mode !== "real" || typeof bridge.importSave !== "function") { setMessage("Loading needs the game engine."); return; }
    const picked = await pickSaveFile(doc);
    if (!picked) return;
    if (picked.error) { setMessage(`Could not read file: ${picked.error}`); render(); return; }
    try {
      await bridge.importSave(1, picked.bytes);
      message = "";
    } catch (err) {
      setMessage(`Could not import save: ${err?.message ?? err}`);
      return;
    }
    render();
  }

  // Real Save / Load from the pause menu: both go through the AWAIT-CONFIRMED
  // facade (bridge.save/load), which resolves only on the engine's own
  // SAVE_RESULT/LOAD_RESULT and a durable flush. A timeout or a refused save
  // (e.g. the Avatar is still in the intro, so canSaveGameStateCurrently() is
  // false) surfaces as a visible error instead of a silent queue. The success
  // toast comes from the engine event itself (see onEngineEvent), never here.
  async function saveGame() {
    if (bridge.mode !== "real" || typeof bridge.save !== "function") { setMessage("Saving needs the game engine."); return; }
    try {
      await bridge.save(1);
      message = "";
    } catch (err) {
      setMessage(`Could not save: ${err?.message ?? err}`);
      return;
    }
    render();
  }
  async function loadGame() {
    if (bridge.mode !== "real" || typeof bridge.load !== "function") { setMessage("Loading needs the game engine."); return; }
    try {
      await bridge.load(1);
      message = "";
    } catch (err) {
      setMessage(`Could not load: ${err?.message ?? err}`);
      return;
    }
    render();
  }

  // Characters already delivered to the engine by a physical keydown, so the
  // input event that follows it does not forward the same character twice.
  const physOwed = [];

  // Forward the TEXT an <input> produced (and Backspace for deletions) over the
  // same real push_event path. A phone keyboard usually emits only input /
  // composition events with no usable `code`, so the character itself is the
  // only signal; a physical key is deduped above so nothing is sent twice.
  function forwardNameDiff(prev, cur) {
    if (prev === cur) return;
    if (bridge.mode !== "real" || typeof bridge.rawKey !== "function") return;
    let common = 0;
    const max = Math.min(prev.length, cur.length);
    while (common < max && prev[common] === cur[common]) common += 1;
    const backspaces = Math.min(prev.length - common, 16);
    for (let i = 0; i < backspaces; i += 1) {
      bridge.rawKey("Backspace", true);
      bridge.rawKey("Backspace", false);
    }
    for (const ch of cur.slice(common).slice(0, 8)) {
      if (ch <= " " || ch.charCodeAt(0) === 127) continue; // never inject control chars
      // Dedupe against a physical keydown case-insensitively: an <input> may
      // fold an uppercase keydown to its lowercase character, and a naive
      // compare would forward the same character twice.
      if (physOwed.length && physOwed[0].toLowerCase() === ch.toLowerCase()) { physOwed.shift(); continue; }
      bridge.rawKey(null, true, ch);
      bridge.rawKey(null, false, ch);
    }
  }

  const A = {
    // The title's "New game" opens the name proxy; Begin logs the name into the
    // engine's own prompt (see nameKey) and drops the player into the live menu.
    start: () => go(SCREEN.NAME),
    back: () => { state = { ...state, rebind: null }; go(state.returnTo || SCREEN.TITLE); },
    setNameDraft: (value) => {
      const prev = state.nameDraft;
      state = setPlayerName(state, value);
      const cur = state.nameDraft;
      // The phone keyboard often emits input/composition with no key code, so
      // the proxy forwards the *text* it produced (and Backspace for deletions)
      // instead of trusting ev.code. This is the same real push_event path.
      forwardNameDiff(prev, cur);
      const input = doc.getElementById("u8-name");
      if (input && input.value !== cur) input.value = cur;
    },
    // Enter is ALSO sent to the engine (so its own prompt accepts the name)
    // before the shell moves on; Escape is the shell-only accessible skip.
    // Every printable key is forwarded with its real code so the engine prompt
    // reads a proper keycode; the character is remembered so forwardNameDiff
    // does not send it a second time from the input event.
    nameKey: (ev, down) => {
      const key = ev.key;
      const isEnter = key === "Enter" || ev.code === "Enter" || ev.code === "NumpadEnter";
      const isEscape = key === "Escape" || ev.code === "Escape";
      // Enter accepts the engine's own prompt and Escape is its real skip; both
      // are sent by submitName/skipIntro so a physical key and the buttons
      // cannot double-send.
      if (isEscape) { if (down) A.skipIntro(); return; }
      if (isEnter) { if (down) A.submitName(); return; }
      const printable = typeof key === "string" && key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
      if (!printable || typeof bridge.rawKey !== "function") return;
      if (down) { physOwed.push(key); if (physOwed.length > 8) physOwed.shift(); }
      bridge.rawKey(ev.code || key, down, key);
    },
    // Enter is sent to the engine's real prompt (the key it actually reads),
    // and the engine owns the name from here on. The shell only echoes the
    // committed name into the HUD; it never claims the draft as the real name.
    submitName: () => {
      // While the engine's own prompt is provably NOT live (the intro still
      // owns input) Begin must decline rather than accept a name the game never
      // asked for. A build that publishes no prompt signal (null) keeps the
      // fallback so the flow cannot deadlock.
      if (readTextPrompt() === false) return;
      if (typeof bridge.rawKey === "function") { bridge.rawKey("Enter", true); bridge.rawKey("Enter", false); }
      state = commitPlayerName(state);
      go(SCREEN.PLAY);
    },
    // Skip is the engine's REAL Escape: the intro/prompt is dismissed by its
    // own keymapper, exactly as a native key would.
    skipIntro: () => {
      if (typeof bridge.rawKey === "function") { bridge.rawKey("Escape", true); bridge.rawKey("Escape", false); }
      state = commitPlayerName(state);
      go(SCREEN.PLAY);
    },
    openSettings: () => openSub(SCREEN.SETTINGS),
    openControls: () => openSub(SCREEN.REBIND),
    setMode: (mode) => {
      state = setMode(state, mode);
      persist();
      render();
      if (bridge.isWorld()) { try { bridge.setMode?.(state.settings.mode); } catch { /* reported by the engine state */ } }
      try { frameFilter?.setMode(state.settings.mode); } catch { /* filter is best-effort */ }
      applyEngineSpeed();
      applyAudioPrefs();
    },
    setSetting: (key, value) => {
      if (key === "artMode") {
        // CP69: title screen persists setting/key only; native world saves slot 1, persists, restarts
        const canSave = bridge.isWorld();
        if (canSave) {
          // Native is running: save slot 1, then restart with resume
          (async () => {
            try {
              await bridge.save(1);
              await doArtRestart(value, true);
            } catch (err) {
              toastStatus(`Restart failed: ${err?.message ?? err}`, "hurt");
            }
          })();
        } else {
          // Title screen or no save capability: just persist setting and key
          doArtRestart(value, false);
        }
        return;
      }
      state = setSetting(state, key, value);
      persist();
      render();
      if (key === "gameSpeed" || key === "fastTravel") applyEngineSpeed();
      if (key === "musicVolume" || key === "sfxVolume" || key === "alwaysRun") applyAudioPrefs();
    },
    pickRebindAction: (action) => { state = beginRebind(state, "keyboard", action); render(); },
    cancelRebind: () => { state = cancelRebind(state); render(); },
    requestPause: () => { acquirePause(); go(SCREEN.PAUSE); },
    resume: () => { releasePause(); go(SCREEN.PLAY); },
    quit: () => { releasePause(); go(SCREEN.TITLE); },
    exportSave,
    importSave,
    saveGame,
    loadGame,
    fullscreen: () => enterFullscreen(),
    tapSound: () => { unlockOnce(); updateAudioUi(); },
    chooseMusic,
    chooseMusicGm: () => chooseMusic("gm"),
    cancelMusicDownload,
    confirmMusicRestart,
  };

  // "Movable world" is NOT the READY flag alone: READY is 1 during the intro,
  // and STASIS stays 1 until the player actually leaves the opening conversation.
  // Only the engine's own STASIS===0 means there is something to move.
  function worldPlayable() {
    if (bridge.mode !== "real") return true;
    if (!bridge.isWorld()) return false;
    try {
      const snap = typeof bridge.snapshot === "function" ? bridge.snapshot() : null;
      if (snap && Number(snap.STASIS) === 1) return false;
    } catch { /* treat as playable once READY if the field is unavailable */ }
    return true;
  }

  let touchCtl = null;
  function mountTouch() {
    const layer = doc.getElementById("u8-touch");
    // The HUD/stick appear only once the world is actually movable; before that
    // the engine is still in its intro/conversation and there is nothing to move.
    const ready = worldPlayable();
    if (!layer || !isPlaylike(state.screen) || !ready) { touchCtl = null; return; }
    // Never rebuild over a live control layer: a HUD poll must not drop a held
    // stick/button.
    if (touchCtl && typeof layer.contains === "function" && layer.contains(touchCtl.stick)) return;
    touchCtl = mountTouchControls(layer, {
      getBindings: () => currentBindings(state),
      onAction: (action, ctx) => dispatchAction(action, ctx),
    });
  }

  // Release every held direction/button when focus leaves the page or the tab
  // is hidden, so an interrupted gesture never leaves the avatar walking.
  function flushInputs() {
    try { bridge.releaseAll?.(); } catch { /* ignore */ }
    touchCtl?.releaseStick?.();
  }

  // The live engine-read HUD source. Only values the engine actually published
  // are used; nothing is invented, and a missing value hides its field.
  let hudEngine = null;
  function readEngine() {
    let snap = null;
    try { snap = typeof bridge.snapshot === "function" ? bridge.snapshot() : null; } catch { snap = null; }
    let name = null;
    try { name = bridge.engineName?.() ?? null; } catch { name = null; }
    hudEngine = snap || name
      ? { hp: snap ? Number(snap.HP) : NaN, maxHp: snap ? Number(snap.MAX_HP) : NaN, name }
      : null;
    return hudEngine;
  }

  // The engine's ACHIEVED audio status (never the chosen preference). Null
  // until the engine publishes it; the panel then shows "status unavailable"
  // rather than inventing a value.
  function readAudio() {
    try { return typeof bridge.audio === "function" ? bridge.audio() : null; } catch { return null; }
  }

  // Surface the "tap to enable sound" retry ONLY while the real SDL3
  // AudioContext is genuinely suspended (state 0) and no resume has landed yet,
  // and only over the live world (where it must survive the #app passthrough).
  function updateAudioUi() {
    const a = readAudio();
    const suspended = a ? Number(a.contextState) === 0 : false;
    const show = suspended && !audioUnlocked && isPlaylike(state.screen);
    tapSound.classList.toggle("on", show);
    tapSound.setAttribute("aria-hidden", show ? "false" : "true");
  }

  // Update the HUD text IN PLACE. This never calls render(), so a held touch
  // control keeps its pointer/touch capture across a poll.
  function updateHud() {
    const node = doc.getElementById("u8-hud");
    if (!node) return;
    const h = hudModel(state, hudEngine);
    const set = (key, value) => {
      const v = node.querySelector(`[data-hud="${key}"]`);
      if (v) v.textContent = value ?? "";
      const cell = node.querySelector(`[data-hud-cell="${key}"]`);
      if (cell) cell.hidden = !value;
    };
    set("name", h.name);
    set("mode", h.modeLabel);
    set("health", h.hasHealth ? h.health : "");
    set("place", h.hasPlace ? h.location : "");
  }

  // The engine's real text-prompt flag (true/false), or null when the build
  // publishes no such signal (the name proxy then stays available as a fallback).
  function readTextPrompt() {
    try { const v = bridge.textPromptActive?.(); return typeof v === "boolean" ? v : null; } catch { return null; }
  }
  let lastPrompt = null;

  // [W3 click-move] Capability the settings screen reads. Available ONLY when
  // the running build publishes the path block AND a numeric WALK_TO id exists;
  // every other case (incl. the accepted 7ec build) reports unavailable so the
  // toggle stays hidden and the click path stays inert.
  function clickMoveEnv() {
    let snap = null; try { snap = bridge.snapshot?.() ?? null; } catch { snap = null; }
    const cap = detectPathCapability({ snapshot: snap, ready: worldPlayable(), pair: pathPair(bridge.element) });
    return { available: cap.available === true, touch: isTouchPrimary(win) };
  }

  function render() {
    const playlike = isPlaylike(state.screen);
    const engineActive = playlike || state.screen === SCREEN.NAME;
    readEngine();
    const textPrompt = readTextPrompt();
    lastPrompt = textPrompt;
    const clickEnv = clickMoveEnv();
    doc.body.classList.toggle("engine-live", engineActive);
    // Pointer passthrough: only the live PLAY screen lets clicks reach the
    // engine iframe underneath; every other screen keeps #app interactive.
    doc.body.classList.toggle("engine-play", state.screen === SCREEN.PLAY);
    fx.classList.toggle("live", playlike);
    renderScreen({ ...state, message, textPrompt, hudEngine, audio: readAudio(), music: musicPanel(), art: artPanel(), musicConfirm: state.musicConfirm,
      clickMoveAvailable: clickEnv.available, clickMoveTouch: clickEnv.touch }, A);
    mountTouch();
    updateOrientation();
    if (engineActive) mountEngine();
    updateHud();
    updateAudioUi();
  }

  // Poll the engine's live HUD + prompt. The HUD updates IN PLACE, never with a
  // render, so a held touch control is not dropped. The engine's real text
  // prompt is watched on ANY screen:
  //   * a Skip/Escape that lands the shell on the world BEFORE the engine opens
  //     its own prompt must still surface the accessible proxy (the intro owns
  //     input at first, so TEXT_INPUT_ACTIVE is 0 when Skip is pressed);
  //   * once the opening conversation ends and STASIS flips to 0, the live touch
  //     controls must mount -- updateHud() alone never did that.
  // Re-rendering only on a real prompt CHANGE keeps the user's in-progress
  // typing intact across polls.
  function pollTick() {
    readEngine();
    updateAudioUi();
    const playlike = isPlaylike(state.screen);
    if (playlike) updateHud();
    const prompt = readTextPrompt();
    if (prompt !== lastPrompt) {
      lastPrompt = prompt;
      // The engine's prompt became live while the shell was already on the
      // world (the intro was skipped): reopen the proxy so the phone keyboard
      // reaches the game's own prompt.
      if (prompt === true && state.screen === SCREEN.PLAY) {
        state = navigate(state, SCREEN.NAME);
        render();
        return;
      }
      if (state.screen === SCREEN.NAME) { render(); return; }
    }
    // Mount the live touch controls once the world is actually movable. The
    // control layer refuses to rebuild while its stick is held, so an active
    // gesture is never dropped by a poll.
    if (playlike) mountTouch();
    // [W3 click-move] Refresh the destination marker from the engine's own
    // path state. A no-op on a build without the path block.
    if (playlike) clickCtl?.tick?.();
  }
  win.setInterval?.(pollTick, 500);

  // One physical key -> one shell decision. `repeat` only matters for held
  // actions. Classic and pre-world raw keys go to the engine's own keymapper.
  function handleCommand(cmd, code, phase, repeat) {
    if (cmd.kind === "rebind-capture") { const res = captureRebind(state, code); state = res.state; render(); return; }
    if (cmd.kind === "passthrough") { bridge.rawKey?.(code, cmd.down); return; }
    if (cmd.kind === "action") {
      if (repeat) return;
      // Own movement/actions only once the world is actually movable; until then
      // (intro, name prompt, opening conversation) the key goes to the engine's
      // own keymapper, so dialogue keeps its native keys.
      if (worldPlayable()) { dispatchAction(cmd.action, { down: cmd.down }); return; }
      bridge.rawKey?.(code, cmd.down);
    }
  }

  function onKeyEvent(ev, phase) {
    if (isTextTarget(ev.target)) return;
    const cmd = keyToCommand(state, ev.code, phase);
    if (cmd.kind === "ignore") return;
    if (isPlaylike(state.screen) || state.screen === SCREEN.REBIND) ev.preventDefault();
    handleCommand(cmd, ev.code, phase, ev.repeat);
  }

  win.addEventListener("keydown", (ev) => onKeyEvent(ev, "down"));
  win.addEventListener("keyup", (ev) => onKeyEvent(ev, "up"));
  win.addEventListener("resize", updateOrientation);
  win.addEventListener("blur", flushInputs);
  win.addEventListener("pagehide", flushInputs);
  win.addEventListener("pointercancel", flushInputs);
  doc.addEventListener("visibilitychange", () => { if (doc.hidden) flushInputs(); });

  // Reflect the engine's own readiness: an error becomes a visible message and
  // a world-ready engine applies the persisted mode + reveals the HUD/stick.
  bridge.onPhase?.((phase) => {
    if (phase === "error") { setMessage(bridge.error || "The game engine did not load."); return; }
    if (phase === "world") {
      try { frameFilter?.attach(); } catch { /* filter is best-effort */ }
      // Apply the persisted mode and the labelled travel speed once, on READY.
      try { bridge.setMode?.(state.settings.mode); } catch { /* ignore */ }
      applyEngineSpeed();
      applyAudioPrefs();
      let resumeSlot = null;
      if (pendingResume) {
        const r = pendingResume; pendingResume = null;
        resumeSlot = r.resumeSlot === 1 ? 1 : null;
        if (resumeSlot === 1 && typeof bridge.load === "function") bridge.load(1).catch(() => { /* engine reports the result */ });
      }
      maybeShowBootFallback(readBootStatus());
      // A fallback restart must not discard a just-restored slot-1 save: it
      // keeps the resume slot instead of blindly starting a new game.
      checkMusicFallback(resumeSlot);
      // CP68 reconcile: if engine's artMode differs from stored key, call setArtMode once
      if (!artReconciled) {
        artReconciled = true;
        try {
          const keyArt = storage?.getItem?.("u8_art_mode");
          const engineState = typeof bridge.getArtState === "function" ? bridge.getArtState() : null;
          if (keyArt && engineState && engineState.requested !== keyArt) {
            bridge.setArtMode?.(keyArt);
          }
        } catch { /* reconciliation is best-effort */ }
      }
    }
    render();
  });

  // Audio may only start after a user gesture (iOS Safari / Android Chrome).
  // The first real gesture is forwarded to the engine's actual audio context.
  let audioUnlocked = false;
  function unlockOnce() {
    if (audioUnlocked) return;
    let res = false;
    try { res = bridge.resumeAudio?.(); } catch { res = false; }
    // Only an ACTUALLY running audio context counts as unlocked. If the context
    // is still suspended (or does not exist yet) we stay unlocked=false so a
    // later gesture — including one inside the engine iframe — retries.
    if (res && typeof res.then === "function") {
      res.then((v) => { if (v === true) { audioUnlocked = true; updateAudioUi(); } }).catch(() => { /* retry later */ });
    } else if (res === true) {
      audioUnlocked = true;
      updateAudioUi();
    }
  }
  for (const evt of ["pointerdown", "keydown", "touchstart"]) {
    win.addEventListener(evt, unlockOnce, { passive: true });
  }

  function updateOrientation() {
    const portrait = win.matchMedia?.("(orientation: portrait)")?.matches ?? win.innerHeight > win.innerWidth;
    doc.body.classList.toggle("portrait", Boolean(portrait));
  }

  async function enterFullscreen() {
    const el = doc.documentElement;
    try {
      if (!doc.fullscreenElement) await (el.requestFullscreen?.({ navigationUI: "hide" }) ?? Promise.resolve());
      else await doc.exitFullscreen?.();
      await win.screen?.orientation?.lock?.("landscape").catch(() => {});
    } catch { /* fullscreen is best-effort; iOS Safari cannot lock */ }
    render();
  }

  function snapshot() {
    return {
      screen: state.screen,
      playerName: state.playerName,
      settings: { ...state.settings },
      passthrough: isPassthroughMode(state),
      bindingMode: state.settings.mode,
      bridgeMode: bridge.mode,
      engineUrl: bridge.engineUrl ?? null,
      enginePhase: bridge.phase ?? null,
    };
  }

  // A restart left a validated token: skip the title, mount now (the world
  // handler then loads slot 1 for a saved restart).
  bootToken = readResumeToken(safeSession(win));
  if (bootToken) {
    clearResumeToken(safeSession(win));
    pendingResume = bootToken;
    state = navigate(state, SCREEN.PLAY);
  }


  render();
  return { state, bridge, feedback, A, render, snapshot };
}

if (typeof window !== "undefined" && !window.__U8_BOOTED__) {
  window.__U8_BOOTED__ = true;
  window.addEventListener("DOMContentLoaded", () => boot(window, document));
}
