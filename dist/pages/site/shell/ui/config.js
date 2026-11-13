// shell/ui/config.js
// The shell's player-facing copy and the ONE engine-page URL constant.
//
// The engine page lives at the engine build root:
//   <engine build root>/scummvm.html#ultima8
// The host stages `shell/` and `web/` INTO `engine/build-emscripten`, so the
// real product URL is `/shell/index.html` and the engine is one level up:
//   ../scummvm.html#ultima8
// That single constant is the iframe src. It may be overridden at runtime with
// an `?engine=<url>` query parameter (see ui/bridge.js resolveEngineUrl).
export const ENGINE_IFRAME_URL = "../scummvm.html#ultima8";

// Player-facing labels. Plain language only, no debug or engine detail.
export const UI_TEXT = Object.freeze({
  title: "Ultima VIII · Pagan",
  subtitle: "Return to the shore of Pagan",
  play: "New game",
  resume: "Resume",
  settings: "Settings",
  controls: "Controls",
  back: "Back",
  quitToTitle: "Quit to title",
  paused: "Paused",
  loading: "Preparing the world…",
  loadingEngine: "Waking the engine…",
  engineError: "The game engine did not load.",
  engineErrorHint: "Check that the engine build is served next to this shell, then reload.",
  menuHint: "Use the game's own menu to begin a new game or continue.",
  rotate: "Rotate your device to landscape to play.",
  modeModern: "Modern",
  modeClassic: "Classic",
  modeHint: "Modern maps the shell's own movement keys and enables speed and combat feedback. Classic keeps them off and lets the game keep its own keys.",
  speed: "Game speed",
  assist: "Combat feedback",
  travel: "Fast travel",
  music: "Music",
  sfx: "Sound effects",
  alwaysRun: "Always run",
  audioTitle: "Audio",
  tapSound: "Tap to enable sound",
  audioNone: "Music off",
  audioFM: "Classic FM soundtrack",
  audioGM: "Modern General MIDI",
  audioFallback: "General MIDI unavailable — using FM",
  audioError: "SoundFont failed to load",
  audioUnknown: "Audio status unavailable",
  rebindTitle: "Controls",
  rebindHint: "Choose an action, then press a key, button or stick direction.",
  rebindAwait: "Press a key now…",
  classicKeysTitle: "The game keeps its own keys",
  namePrompt: "Name your hero",
  namePlaceholder: "Avatar",
  nameContinue: "Begin",
  skipIntro: "Skip intro",
  nameHint: "Type here — the name reaches the game's own prompt. On a phone this opens your keyboard.",
  nameWaiting: "Waiting for the game's own name prompt…",
  classicRateHint: "Classic runs at the game's original rate.",
  // [W3 click-move] Modern input enhancement. Plain language only.
  clickToMove: "Click to move",
  clickToMoveHint: "Left-click the ground to walk there. WASD, the arrows or Esc cancel.",
  clickToMoveClassicHint: "Click to move is a Modern control and is off in Classic.",
  clickToMoveTouchHint: "The on-screen stick stays primary on touch, so click to move is off there.",
  exportSave: "Export save",
  importSave: "Import save",
  saveGame: "Save",
  loadGame: "Load",
  fullscreen: "Fullscreen",
  saveQueued: "Save queued. Waiting for the engine to flush…",
  // Settings > Music: Original FM (default, always available) vs Enhanced
  // instruments (General MIDI). Both are the game's ORIGINAL score — the
  // enhanced choice only changes the instruments, never the music.
  musicTitle: "Music",
  musicSourceLabel: "Soundtrack",
  musicOriginal: "Original FM",
  musicGm: "Enhanced instruments",
  musicHint: "Both options play the game's original score. Enhanced instruments need a one-time download and a restart.",
  musicAchieved: "Enhanced instruments active.",
  musicRestartNeeded: "Ready — applies after the game restarts.",
  musicUseGm: "Download & use",
  musicDownloading: "Downloading instruments…",
  musicFailed: "Instruments could not be downloaded.",
  musicCancel: "Cancel",
  restartTitle: "Restart the game?",
  restartBody: "Changing the soundtrack restarts the game. Any progress that has not been saved will be lost.",
  restartSaveFirst: "Save first",
  restartNow: "Restart now",
  restartLater: "Later",
  restartStasis: "Finish the current scene before restarting.",
  restartTextBlocked: "Finish what you are typing before restarting.",
  restartStorageError: "Could not prepare the restart. Your browser blocked the resume note, so nothing was restarted.",
  restartSaveFailed: "The game could not be saved, so the restart was cancelled.",
  restartFlushError: "The soundtrack choice could not be written to storage, so the game was not restarted.",
  musicStageError: "The instruments could not be stored, so the original FM soundtrack is still in use.",
  fallbackNotice: "Enhanced instruments did not start, so the original FM soundtrack is being used.",
  restartWithFm: "Restart with FM",

  saveDurable: "Save written and flushed.",
  saveFailed: "The engine did not save.",

  // CP61 art mode
  artTitle: "Visual scale",
  artClassic: "Classic",
  artHd2: "HD 2×",
  artHd4: "HD 4× (experimental)",
  artHint: "Changing scale requires a restart. Your progress will be saved first.",
  artMobileWarning: "HD art uses more memory. Classic is recommended for phones.",
  artStateUnknown: "Art state unavailable",
  artRestartNeeded: "Restart to apply",
  artPackFailed: "HD art pack failed to load — using Classic",
});

// Engine-native U8 keyboard defaults. These are informational only: in Classic
// the shell does NOT intercept physical keys, so the engine's own keymapper
// receives them verbatim. Ground truth: ultima8/metaengine.cpp U8_KEYS.
export const ENGINE_KEY_HINTS = Object.freeze([
  { key: "F1", meaning: "quicksave" },
  { key: "F5", meaning: "save" },
  { key: "F7", meaning: "load" },
  { key: "Space", meaning: "jump" },
]);

// Ultima VIII melee is mouse-driven, not a keyboard attack key.
export const COMBAT_MOUSE_HINTS = Object.freeze([
  { input: "Hold left", meaning: "block" },
  { input: "Double left", meaning: "attack" },
  { input: "Double right", meaning: "kick" },
]);
