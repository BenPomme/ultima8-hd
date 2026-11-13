// shell/ui/screens.js
// Renders every shell screen from the pure UI state. Player-facing copy only:
// no engine, model, budget or debug detail ever appears here.
import { el, clear } from "./dom.js";
import { SCREEN, currentBindings, hudModel } from "./state.js";
import { effectiveSettings } from "../core/settings.js";
import { UI_TEXT as T, ENGINE_KEY_HINTS, COMBAT_MOUSE_HINTS } from "./config.js";
import { ACTIONS } from "../core/actions.js";

function button(label, onClick, opts = {}) {
  return el("button", { class: `btn ${opts.class ?? ""}`.trim(), type: "button", onClick, ...(opts.disabled ? { disabled: true } : {}), "data-test": opts.test ?? label }, label);
}

function field(label, control, hint) {
  return el("label", { class: "field" },
    el("span", { class: "field-label", text: label }),
    control,
    hint ? el("small", { class: "field-hint", text: hint }) : null);
}

function slider(value, onInput, opts) {
  return el("input", {
    class: "range", type: "range", min: opts.min, max: opts.max, step: opts.step,
    value: String(value), "data-test": opts.test, onInput: (e) => onInput(Number(e.target.value)),
  });
}

function checkbox(checked, onChange, opts) {
  return el("input", {
    class: "check", type: "checkbox", "data-test": opts.test,
    ...(checked ? { checked: true } : {}),
    ...(opts.disabled ? { disabled: true } : {}),
    onChange: (e) => onChange(e.target.checked),
  });
}

function card(...children) {
  return el("div", { class: "card" }, ...children);
}

function mount(root, ...children) {
  clear(root);
  root.append(...children);
  return root;
}

function actionLabel(action) {
  return action.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function titleScreen(state, A) {
  const node = card(
    el("h1", { class: "title", text: T.title }),
    el("p", { class: "subtitle", text: T.subtitle }),
    el("div", { class: "stack" },
      button(T.play, A.start, { class: "primary", test: "start" }),
      button(T.settings, A.openSettings),
      button(T.controls, A.openControls)),
  );
  // Modern uses the host-accepted key art; Classic keeps the plain panel.
  if (state.settings.mode !== "classic") node.classList.add("keyart");
  return mount(state.root, node);
}

function nameScreen(state, A) {
  // The engine's canvas cannot raise a phone's virtual keyboard by itself, so
  // this native input IS the touch keyboard AND a proxy: every keystroke is
  // forwarded to the game's own name prompt through the real push_event path.
  // It is shown ONLY once the engine reports its real text prompt is live
  // (state.textPrompt === true). While the intro still owns input
  // (state.textPrompt === false) we wait instead of typing over the intro; when
  // the build publishes no such signal at all (null) we fall back to the proxy
  // so the flow never deadlocks. Enter accepts the engine's own prompt; Skip is
  // the real Escape to the engine's prompt.
  const waiting = state.textPrompt === false;
  const input = el("input", {
    class: "text-input", type: "text", id: "u8-name", "data-test": "name-input",
    maxlength: 16, autocomplete: "off", autocapitalize: "words", spellcheck: "false",
    placeholder: T.namePlaceholder, value: state.nameDraft,
    ...(waiting ? { disabled: true } : {}),
    onInput: (e) => A.setNameDraft(e.target.value),
    onKeyDown: (e) => A.nameKey(e, true),
    onKeyUp: (e) => A.nameKey(e, false),
    onCompositionEnd: (e) => A.setNameDraft(e.target.value),
  });
  if (!waiting) setTimeout(() => input.focus(), 0);
  const form = el("form", { class: "card", onSubmit: (e) => { e.preventDefault(); A.submitName(); } },
    el("h2", { class: "title", text: T.namePrompt }),
    field("Name", input, waiting ? T.nameWaiting : T.nameHint),
    el("div", { class: "stack row" },
      button(T.nameContinue, A.submitName, { class: "primary", test: "begin", disabled: waiting }),
      button(T.skipIntro, A.skipIntro, { test: "skip" })),
    button(T.back, A.back));
  return mount(state.root, form);
}

function loadingScreen(state) {
  return mount(state.root, card(
    el("h2", { class: "title", text: T.loading }),
    el("div", { class: "progress", "data-test": "progress" }, el("span", { class: "bar" })),
    el("p", { class: "subtitle", text: state.playerName ? `Welcome, ${state.playerName}.` : "" }),
  ));
}

function hud(state) {
  const h = hudModel(state, state.hudEngine ?? null);
  // Each value carries data-hud so a poll can update it in place, without
  // rebuilding the screen (and so without dropping a held touch control).
  const cell = (k, v, key) => el("div", { class: "hud-cell", "data-hud-cell": key, ...(v ? {} : { hidden: true }) },
    el("span", { class: "hud-k", text: k }),
    el("span", { class: "hud-v", "data-hud": key, text: v ?? "" }));
  // Health/Place are hidden until the engine actually reports them (never a
  // made-up dash). Hero falls back to the committed name the engine owns.
  return el("div", { class: "hud", id: "u8-hud", "data-test": "hud" },
    cell("Hero", h.name, "name"),
    cell("Mode", h.modeLabel, "mode"),
    cell("Health", h.hasHealth ? h.health : "", "health"),
    cell("Place", h.hasPlace ? h.location : "", "place"));
}

function playScreen(state, A) {
  return mount(state.root,
    el("div", { class: "stage" },
      el("div", { class: "viewport", id: "u8-viewport" },
        hud(state),
        el("div", { class: "play-controls" },
          button("⛶", A.fullscreen, { class: "fs-btn", test: "fullscreen" }),
          button("☰", A.requestPause, { class: "pause-btn", test: "pause" }))),
      el("div", { class: "touch-layer", id: "u8-touch" })),
  );
}

function pauseScreen(state, A) {
  return el("div", { class: "overlay", id: "u8-pause" }, card(
    el("h2", { class: "title", text: T.paused }),
    el("div", { class: "stack" },
      button(T.resume, A.resume, { class: "primary", test: "resume" }),
      button(T.settings, A.openSettings),
      button(T.controls, A.openControls),
      el("div", { class: "save-row" },
        button(T.saveGame, A.saveGame, { test: "save-game" }),
        button(T.loadGame, A.loadGame, { test: "load-game" })),
      el("div", { class: "save-row" },
        button(T.exportSave, A.exportSave, { test: "export-save" }),
        button(T.importSave, A.importSave, { test: "import-save" })),
      state.message ? el("p", { class: "message", "data-tone": "error", "data-test": "message", text: state.message }) : null,
      button(T.quitToTitle, A.quit)),
  ));
}

// A truthful one-line summary of the engine's ACHIEVED audio state, read from
// audio() values only (GM / FM / fallback / error / off / unavailable). It never
// reports the chosen preference and never infers a value the engine did not
// publish.
function audioStatusText(a) {
  if (!a) return T.audioUnknown;
  const synth = Number(a.synth);
  if (synth === 2) return T.audioGM;
  if (Number(a.fallback) > 0) return T.audioFallback;
  if (synth === 1) return T.audioFM;
  if (synth === 0) return T.audioNone;
  if (Number(a.loadError) > 0) return T.audioError;
  return T.audioUnknown;
}

// The Audio panel: live Music/SFX volumes and the Always-run toggle (persisted
// per profile and reapplied at boot), the achieved-status line above, and a
// visible retry while the real AudioContext is genuinely suspended.
function audioPanel(state, A, eff, classic) {
  const a = state.audio ?? null;
  const suspended = a ? Number(a.contextState) === 0 : false;
  return el("div", { class: "audio-panel", "data-test": "audio-panel" },
    el("span", { class: "panel-title", text: T.audioTitle }),
    field(T.music, slider(state.settings.musicVolume, (v) => A.setSetting("musicVolume", v), { min: 0, max: 1, step: 0.05, test: "music" })),
    field(T.sfx, slider(state.settings.sfxVolume, (v) => A.setSetting("sfxVolume", v), { min: 0, max: 1, step: 0.05, test: "sfx" })),
    field(T.alwaysRun, checkbox(eff.alwaysRun, (v) => A.setSetting("alwaysRun", v), { disabled: classic, test: "alwaysRun" })),
    el("p", { class: "audio-status", "data-test": "audio-status", text: audioStatusText(a) }),
    suspended ? button(T.tapSound, A.tapSound, { class: "primary", test: "tap-sound" }) : null,
  );
}

function musicPanel(state, A) {
  const classic = state.settings.mode === "classic";
  const m = state.music ?? {};
  // `m.source` is the EFFECTIVE source (Classic forces FM); never the raw pref.
  const source = classic ? "fm" : (m.source ?? (state.settings.musicSource === "gm" ? "gm" : "fm"));
  const kind = classic ? "fm" : (m.kind ?? (source === "gm" ? "prompt" : "fm"));
  let status = null;
  let action = null;
  if (kind === "downloading") {
    status = el("p", { class: "audio-status", "data-test": "music-status", text: `${T.musicDownloading} ${Math.round((Number(m.ratio) || 0) * 100)}%` });
    action = button(T.musicCancel, A.cancelMusicDownload, { test: "music-cancel" });
  } else if (kind === "failed") {
    status = el("p", { class: "audio-status", "data-tone": "error", "data-test": "music-status", text: `${T.musicFailed} ${m.error ?? ""}`.trim() });
    action = button(T.musicUseGm, A.chooseMusicGm, { test: "music-use-gm" });
  } else if (kind === "achieved") {
    status = el("p", { class: "audio-status", "data-test": "music-status", text: T.musicAchieved });
  } else if (kind === "restart") {
    status = el("p", { class: "audio-status", "data-test": "music-status", text: T.musicRestartNeeded });
  } else if (kind === "prompt") {
    status = el("p", { class: "field-hint", "data-test": "music-status", text: T.musicHint });
    action = button(T.musicUseGm, A.chooseMusicGm, { class: "primary", test: "music-use-gm" });
  } else {
    status = el("p", { class: "field-hint", "data-test": "music-status", text: T.musicHint });
  }
  return el("div", { class: "audio-panel music-panel", "data-test": "music-panel" },
    el("span", { class: "panel-title", text: T.musicTitle }),
    field(T.musicSourceLabel, el("div", { class: "segmented", id: "u8-music" },
      button(T.musicOriginal, () => A.chooseMusic("fm"), { class: source === "fm" ? "on" : "", test: "music-fm", disabled: classic }),
      button(T.musicGm, () => A.chooseMusic("gm"), { class: source === "gm" ? "on" : "", test: "music-gm", disabled: true }))),
    status,
    action ? el("div", { class: "stack row" }, action) : null,
  );
}

function musicConfirmDialog(state, A) {
  const d = state.musicConfirm ?? {};
  return el("div", { class: "overlay", id: "u8-music-confirm", "data-test": "music-confirm" }, card(
    el("h2", { class: "title", text: T.restartTitle }),
    el("p", { class: "field-hint", text: T.restartBody }),
    d.notice ? el("p", { class: "audio-status", "data-tone": "error", "data-test": "music-confirm-notice", text: d.notice }) : null,
    el("div", { class: "stack row" },
      button(T.restartSaveFirst, () => A.confirmMusicRestart("save"), { class: "primary", test: "music-save-first" }),
      button(T.restartNow, () => A.confirmMusicRestart("now"), { test: "music-restart-now" })),
    el("div", { class: "stack row" }, button(T.restartLater, () => A.confirmMusicRestart("later"), { test: "music-later" })),
  ));
}

// CP61 Art panel: Classic/HD2x/HD4x selector. Desktop shows all three; mobile
// hides HD4x and shows a memory warning when HD2x is chosen. The state line
// displays engine art state or "state unknown" when getArtState returns null.
function artPanel(state, A) {
  const artState = state.art ?? null;
  const s = state.settings;
  const isMobile = artState ? artState.isMobile : false;
  const stored = s.artMode ?? "hd2";
  
  // State line: show engine state or "state unknown" if null
  let statusText = T.artStateUnknown;
  if (artState && artState.engineState) {
    const eng = artState.engineState;
    if (eng.packState === "failed") {
      statusText = T.artPackFailed;
    } else if (eng.requested !== stored) {
      statusText = T.artRestartNeeded;
    } else {
      statusText = `${eng.activeScale}× ${eng.packState}`;
    }
  }
  
  return el("div", { class: "art-panel", "data-test": "art-panel" },
    el("span", { class: "panel-title", text: T.artTitle }),
    el("div", { class: "segmented", id: "u8-art-mode" },
      button(T.artClassic, () => A.setSetting("artMode", "classic"), { 
        class: stored === "classic" ? "on" : "", 
        test: "art-classic" 
      }),
      button(T.artHd2, () => A.setSetting("artMode", "hd2"), { 
        class: stored === "hd2" ? "on" : "", 
        test: "art-hd2" 
      }),
      isMobile ? null : button(T.artHd4, () => A.setSetting("artMode", "hd4"), { 
        class: stored === "hd4" ? "on" : "", 
        test: "art-hd4" 
      })),
    el("p", { class: "art-status", "data-test": "art-status", text: statusText }),
    (isMobile && stored === "hd2") ? el("p", { class: "field-hint", text: T.artMobileWarning }) : null,
  );
}

function settingsScreen(state, A) {
  const s = state.settings;
  const classic = s.mode === "classic";
  // In Classic the enhancement controls show their forced-off values but are
  // disabled; the stored Modern prefs stay intact (see core/settings.js).
  const eff = effectiveSettings(s);
  return card(
    el("h2", { class: "title", text: T.settings }),
    el("div", { class: "segmented", id: "u8-mode" },
      button(T.modeModern, () => A.setMode("modern"), { class: s.mode === "modern" ? "on" : "", test: "mode-modern" }),
      button(T.modeClassic, () => A.setMode("classic"), { class: classic ? "on" : "", test: "mode-classic" })),
    el("p", { class: "field-hint", text: T.modeHint }),
    field(T.speed, slider(eff.gameSpeed, (v) => A.setSetting("gameSpeed", v), { min: 0.25, max: 4, step: 0.25, test: "speed" }), classic ? T.classicRateHint : null),
    field(T.assist, checkbox(eff.combatAssist, (v) => A.setSetting("combatAssist", v), { disabled: classic, test: "assist" })),
    field(T.travel, checkbox(eff.fastTravel, (v) => A.setSetting("fastTravel", v), { disabled: classic, test: "travel" })),
    // [W3 click-move] Input section. The toggle only appears when the running
    // engine build actually publishes the path block (capability detection); it
    // is disabled in Classic (the enhancement is forced off) and on a
    // touch-primary device (the stick stays primary this phase).
    state.clickMoveAvailable
      ? field(T.clickToMove,
          checkbox(eff.clickToMove, (v) => A.setSetting("clickToMove", v), {
            disabled: classic || state.clickMoveTouch === true,
            test: "click-to-move",
          }),
          classic ? T.clickToMoveClassicHint
            : state.clickMoveTouch === true ? T.clickToMoveTouchHint
            : T.clickToMoveHint)
      : null,
    audioPanel(state, A, eff, classic),
    musicPanel(state, A),
    artPanel(state, A),
    el("div", { class: "stack row" }, button(T.controls, A.openControls), button(T.back, A.back, { class: "primary", test: "back" })),
  );
}

function rebindScreen(state, A) {
  const bindings = currentBindings(state);
  const byAction = {};
  for (const [code, action] of Object.entries(bindings.keyboard)) (byAction[action] ??= []).push(code);
  const rows = Object.values(ACTIONS).map((action) => el("div", { class: "bind-row" },
    el("span", { class: "bind-action", text: actionLabel(action) }),
    el("span", { class: "bind-keys" }, ...((byAction[action] ?? []).length
      ? byAction[action].map((c) => el("kbd", { text: c }))
      : [el("em", { class: "muted", text: bindings.passthrough ? "engine" : "unbound" })])),
    button("Change", () => A.pickRebindAction(action), { test: `rebind-${action}` })));
  return card(
    el("h2", { class: "title", text: T.rebindTitle }),
    state.rebind
      ? el("p", { class: "await", "data-test": "rebind-await", text: T.rebindAwait })
      : el("p", { class: "field-hint", text: T.rebindHint }),
    bindings.passthrough
      ? el("div", { class: "notice", "data-test": "classic-notice" },
          el("strong", { text: T.classicKeysTitle }),
          el("span", { text: ENGINE_KEY_HINTS.map((k) => `${k.key} ${k.meaning}`).join(" · ") }),
          el("span", { text: COMBAT_MOUSE_HINTS.map((m) => `${m.input} ${m.meaning}`).join(" · ") }))
      : null,
    el("div", { class: "bind-list" }, ...rows),
    el("div", { class: "stack row" }, button(T.back, A.cancelRebind, { class: "primary", test: "back" })),
  );
}

export function renderScreen(state, A) {
  let out;
  if (state.screen === SCREEN.SETTINGS) out = mount(state.root, settingsScreen(state, A));
  else if (state.screen === SCREEN.REBIND) out = mount(state.root, rebindScreen(state, A));
  else if (state.screen === SCREEN.PAUSE) { playScreen(state, A); state.root.append(pauseScreen(state, A)); out = state.root; }
  else if (state.screen === SCREEN.PLAY) out = playScreen(state, A);
  else if (state.screen === SCREEN.LOADING) out = loadingScreen(state);
  else if (state.screen === SCREEN.NAME) out = nameScreen(state, A);
  else out = titleScreen(state, A);
  if (state.musicConfirm) out.append(musicConfirmDialog(state, A));
  return out;
}
