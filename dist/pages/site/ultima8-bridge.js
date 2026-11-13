/*
 * Ultima VIII: Pagan engine bridge — bootstrap glue (bridge-v1, E1)
 * Owner: T2 (sole engine writer / build owner).  Depends on nothing.
 *
 * This file is served next to scummvm.js and is loaded by the existing
 * ScummVM HTML (add <script src="ultima8-bridge.js"></script>).  It exposes a
 * stable, promise-aware facade over the C++ exports so the UI layer never has
 * to touch Module internals or the queue protocol directly.
 *
 * Contract: .scratch/contracts/bridge-v1.json
 *   (working copy: T2-wasm-build-spike/contracts/bridge-v1.json)
 *
 * Rules enforced by the engine (see contract "design_rules"):
 *   - JS only ENQUEUES work or READS cached state; the engine drains the inbox
 *     at the frame boundary. Never call from inside a wasm Asyncify suspend.
 *   - Poll Ultima8Bridge.ready / await Ultima8Bridge.whenReady() before use.
 *
 * Export names on Module (all EMSCRIPTEN_KEEPALIVE):
 *   _bridge_ready, _bridge_frame, _bridge_read_state, _bridge_inventory_count,
 *   _bridge_inventory_entry, _bridge_get_name_ptr, _bridge_set_speed,
 *   _bridge_set_mode, _bridge_queue_command, _bridge_engine_action,
 *   _bridge_push_event, _bridge_gesture, _bridge_export_save,
 *   _bridge_export_size, _bridge_alloc, _bridge_import_save, _bridge_syncfs,
 *   _bridge_emit_event
 */
(function (global) {
	"use strict";

	var BRIDGE_VERSION = 1;

	var STATE = {
		WORLD_X: 0, WORLD_Y: 1, WORLD_Z: 2, IN_COMBAT: 3, STASIS: 4,
		CONTROLLED: 5, DEAD: 6, HP: 7, MAX_HP: 8, MANA: 9, MAX_MANA: 10,
		STR: 11, DEX: 12, INT: 13, MAP_NUM: 14, AVATAR_MAP_NUM: 15,
		SPEED_RATE: 16, SPEED_MULT: 17, MODE: 18, FRAME: 19, READY: 20,
		INVENTORY_COUNT: 21, QUEUE_DROPPED: 22, TRAVEL_SPEED_ACTIVE: 23,
		KERNEL_FRAME: 24,
		// [E2b] QA combat-target readout (nearest hostile actor to the avatar).
		// TARGET_SCREEN_X/Y are the renderer's own projection of the target's
		// "feet" point in engine-logical screen coords (what gesture() takes).
		TARGET_ID: 25, TARGET_HP: 26, TARGET_MAX_HP: 27, TARGET_ALIVE: 28,
		TARGET_WORLD_X: 29, TARGET_WORLD_Y: 30, TARGET_WORLD_Z: 31,
		TARGET_SCREEN_X: 32, TARGET_SCREEN_Y: 33, TARGET_SCREEN_OK: 34,
		// [E2b] QA fixture bookkeeping state indices (frozen range).
		FIXTURE_ID: 35, FIXTURE_SPAWNS: 36, FIXTURE_SHAPE: 37, FIXTURE_HP_CAP: 38,
		// [v1.2] coordinate / name-prompt contract (additive; names 0..38
		// unchanged). AVATAR_SCREEN_X/Y/OK = the Avatar's own logical-screen
		// "feet" projection (same pipeline as TARGET_SCREEN_*). LOGICAL_W/H =
		// the engine's virtual render dims (gesture() coord space). WINDOW_W/H +
		// GAME_DRAW_X/Y/W/H = the real letterbox viewport the backend scales the
		// logical surface into (canvas-backing px); VIEWPORT_OK flags validity.
		// TEXT_INPUT_ACTIVE != 0 iff an EditWidget (the actual name prompt)
		// holds focus -- READY is 1 during the intro/stasis too and cannot be
		// used to detect the prompt.
		AVATAR_SCREEN_X: 39, AVATAR_SCREEN_Y: 40, AVATAR_SCREEN_OK: 41,
		LOGICAL_W: 42, LOGICAL_H: 43,
		WINDOW_W: 44, WINDOW_H: 45,
		GAME_DRAW_X: 46, GAME_DRAW_Y: 47, GAME_DRAW_W: 48, GAME_DRAW_H: 49,
		VIEWPORT_OK: 50, TEXT_INPUT_ACTIVE: 51,
		// [v1.2] FNV-1a fingerprint of the engine's private logical screen
		// surface (the freshly painted framebuffer). A change means the
		// rendered frame changed -- the QA driver's reliable framebuffer-change
		// observable (WebGL pixels are not reliably readable in-page).
		SCREEN_HASH: 52,
		// [E3] Additive audio + input status (read-only). AUDIO_SYNTH: 0 none,
		// 1 Classic FM, 2 Modern GM. AUDIO_FONT_LOADED is the ACTUAL
		// fluid_synth_sfload() result. AUDIO_LOAD_ERROR/FALLBACK surface real
		// failure (GM requested but FM active / no font). AUDIO_CONTEXT_STATE
		// mirrors SDL3 AudioContext.state (0 suspended,1 running,2 closed,
		// 3 interrupted,-1 unknown). ALWAYS_RUN mirrors the live option.
		AUDIO_SYNTH: 53, AUDIO_FONT_LOADED: 54,
		AUDIO_MUSIC_VOL: 55, AUDIO_SFX_VOL: 56,
		AUDIO_LOAD_ERROR: 57, AUDIO_FALLBACK: 58,
		AUDIO_CONTEXT_STATE: 59, ALWAYS_RUN: 60,
		// [W2/m3] click-to-walk: PATH_STATE 0 unavailable/1 idle/2 active/
		// 3 arrived/4 failed-unreachable/5 cancelled; PATH_SEQ increments per
		// accepted walkTo; GUMP_COUNT + GUMP_RECT_0..15 publish up to four
		// visible non-map gump rects (x,y,w,h logical screen px).
		PATH_STATE: 61, PATH_SEQ: 62, GUMP_COUNT: 63,
		GUMP_RECT_0: 64, GUMP_RECT_1: 65, GUMP_RECT_2: 66, GUMP_RECT_3: 67,
		GUMP_RECT_4: 68, GUMP_RECT_5: 69, GUMP_RECT_6: 70, GUMP_RECT_7: 71,
		GUMP_RECT_8: 72, GUMP_RECT_9: 73, GUMP_RECT_10: 74, GUMP_RECT_11: 75,
		GUMP_RECT_12: 76, GUMP_RECT_13: 77, GUMP_RECT_14: 78, GUMP_RECT_15: 79
		// [HD0-E1F] Additive physical backing-store/texture dims (read-only):
		// 320x200 Classic, 640x400 at hd_scale=2, 1280x800 at 4. LOGICAL_W/H
		// stay the virtual 320x200 coordinate space gesture()/mouse use.
		, RENDER_W: 80, RENDER_H: 81
	};
	var STATE_NAMES = [];
	(function () { for (var k in STATE) STATE_NAMES[STATE[k]] = k; })();

	var INV = { SHAPE: 0, FRAME: 1, QUALITY: 2, QUANTITY: 3, OBJ_ID: 4, PARENT: 5 };

	var EVENT = {
		KEYDOWN: 1, KEYUP: 2, MOUSEMOVE: 3, LBUTTONDOWN: 4, LBUTTONUP: 5,
		RBUTTONDOWN: 6, RBUTTONUP: 7, MBUTTONDOWN: 13, MBUTTONUP: 14,
		CUSTOM_ENGINE_ACTION_START: 20, CUSTOM_ENGINE_ACTION_END: 21
	};

	var BUTTON = { LEFT: 0, RIGHT: 1, MIDDLE: 2 };

	var ACTION = {
		QUICKSAVE: 0, SAVE: 1, LOAD: 2, BEDROLL: 3, COMBAT: 4, BACKPACK: 5,
		KEYRING: 6, MINIMAP: 7, RECALL: 8, INVENTORY: 9, NEXT_WEAPON: 10,
		NEXT_INVENTORY: 11, USE_INVENTORY: 12, USE_MEDIKIT: 13, USE_ENERGYCUBE: 14,
		SELECT_ITEMS: 15, DETONATE_BOMB: 16, DROP_WEAPON: 17, USE_SELECTION: 18,
		GRAB_ITEMS: 19, MENU: 20, CLOSE_GUMPS: 21, HIGHLIGHT_ITEMS: 22,
		TOGGLE_TOUCHING: 23, JUMP: 24, SHORT_JUMP: 25, TURN_LEFT: 26,
		TURN_RIGHT: 27, MOVE_FORWARD: 28, MOVE_BACK: 29, MOVE_UP: 30,
		MOVE_DOWN: 31, MOVE_LEFT: 32, MOVE_RIGHT: 33, MOVE_RUN: 34, MOVE_STEP: 35,
		ATTACK: 36 /* CRUSADER-ONLY: never emit for ultima8 */, STEP_LEFT: 37,
		STEP_RIGHT: 38, STEP_FORWARD: 39, STEP_BACK: 40, ROLL_LEFT: 41,
		ROLL_RIGHT: 42, TOGGLE_CROUCH: 43, CAMERA_AVATAR: 44, CLIPPING: 45,
		DEC_SORT_ORDER: 46, INC_SORT_ORDER: 47, MOVE_ASCEND: 48, MOVE_DESCEND: 49,
		TOGGLE_PAINT: 50, FRAME_BY_FRAME: 51, ADVANCE_FRAME: 52,
		TOGGLE_STASIS: 53, SHAPE_VIEWER: 54, NONE: 55
	};

	var CMD = { SAVE: 1, LOAD: 2, PAUSE: 3, SET_MODE: 4, SET_OPTION: 5, RESET_INBOX: 6,
		// [W2/m3] native click-to-walk command ids (a=x, b=y for WALK_TO).
		WALK_TO: 9, CANCEL_WALK: 10 };
	var MODE = { MODERN: 0, CLASSIC: 1 };
	var GESTURE = {
		BLOCK_HOLD: 1, ATTACK_DOUBLECLICK_LEFT: 2, KICK_DOUBLECLICK_RIGHT: 3,
		COMBAT_TOGGLE_DOUBLECLICK_RIGHT_ON_AVATAR: 4, USE_DOUBLECLICK_LEFT: 5,
		LOOK_SINGLECLICK_LEFT: 6, MOVE_SINGLECLICK_MIDDLE: 7, PICK_UP_DRAG_LEFT: 8
	};
	var OPTION = { MUSIC_VOLUME: 1, SFX_VOLUME: 2, SPEECH_VOLUME: 3, MUTE_ALL: 4, SUBTITLES: 5,
		// [E3] additive: MUSIC_SYNTH 0=Classic FM / 1=Modern GM; ALWAYS_RUN 0/1.
		MUSIC_SYNTH: 6, ALWAYS_RUN: 7 };
	// 1-6 = frozen E1 engine_event_stream; 7-8 = additive v1.1 (real save/load
	// completion). Payload per event: (type, a0, a1, a2, a3, kernelFrame).
	var ENGINE_EVENT = {
		HIT: 1, BLOCK: 2, HURT: 3, DEATH: 4, ATTACK_START: 5, ATTACK_END: 6,
		SAVE_RESULT: 7, LOAD_RESULT: 8
	};

	function mod() {
		return (typeof global.Module !== "undefined" && global.Module) ? global.Module : null;
	}
	function fn(name) {
		var M = mod();
		return (M && typeof M[name] === "function") ? M[name] : null;
	}

	// Runtime-safe heap access.  On the real dist build the typed-array views
	// are top-level vars in scummvm.js (classic script -> properties of the
	// global object) and are NOT attached to Module, so Module.HEAPU8 is
	// undefined here even though the wasm heap is live.  updateMemoryViews()
	// REASSIGNS those vars on every memory growth, which detaches any previously
	// captured view.  Resolve the *current* view at every call site; never cache.
	function heapU8() {
		var M = mod();
		if (M && M.HEAPU8) return M.HEAPU8;
		if (typeof global.HEAPU8 !== "undefined" && global.HEAPU8) return global.HEAPU8;
		return null;
	}
	function utf8(ptr) {
		var M = mod();
		var f = (M && typeof M.UTF8ToString === "function") ? M.UTF8ToString
		      : (typeof global.UTF8ToString === "function") ? global.UTF8ToString : null;
		return (f && ptr) ? f(ptr) : "";
	}

	// --- engine->shell event stream (combat feedback, E2-ready) --------------
	var listeners = { all: [] };
	function on(type, cb) {
		if (typeof cb !== "function") return function () {};
		if (type == null) listeners.all.push(cb);
		else {
			if (!listeners[type]) listeners[type] = [];
			listeners[type].push(cb);
		}
		return function () { off(type, cb); };
	}
	function off(type, cb) {
		var list = (type == null) ? listeners.all : listeners[type];
		if (!list) return;
		var i = list.indexOf(cb);
		if (i >= 0) list.splice(i, 1);
	}
	// Additive v1.1: trailing d (4th L2 payload int) + kernelFrame. Existing
	// (type,a,b,c) consumers keep working; the extras are appended args.
	function dispatch(type, a, b, c, d, kernelFrame) {
		var list = listeners.all.slice();
		if (listeners[type]) list = list.concat(listeners[type]);
		for (var i = 0; i < list.length; i++) {
			try { list[i](type, a, b, c, d, kernelFrame); } catch (e) {}
		}
	}
	function installHook() {
		var M = mod();
		if (!M) return false;
		if (M.bridgeOnEngineEvent !== dispatch) M.bridgeOnEngineEvent = dispatch;
		return true;
	}

	// --- readiness -----------------------------------------------------------
	var ready = false;
	var readyWaiters = [];
	function checkReady() {
		installHook();
		var r = fn("_bridge_ready");
		if (r && r() === 1) {
			ready = true;
			var w = readyWaiters; readyWaiters = [];
			for (var i = 0; i < w.length; i++) { try { w[i](); } catch (e) {} }
			return true;
		}
		return false;
	}
	function whenReady() {
		if (ready) return Promise.resolve();
		return new Promise(function (resolve) {
			readyWaiters.push(resolve);
			var tick = function () {
				if (checkReady()) return;
				setTimeout(tick, 100);
			};
			setTimeout(tick, 0);
		});
	}
	// Keep polling until the very first ready, so the hook installs even if the
	// UI never awaits it.
	(function bootstrapPoll() {
		if (!checkReady()) setTimeout(bootstrapPoll, 200);
	})();

	// --- state reads (cached; no engine re-entry) ----------------------------
	function readState(field) {
		var r = fn("_bridge_read_state");
		return r ? r(field | 0) : 0;
	}
	function snapshot() {
		var out = {};
		for (var i = 0; i < STATE_NAMES.length; i++) out[STATE_NAMES[i]] = readState(i);
		return out;
	}
	function inventory() {
		var countFn = fn("_bridge_inventory_count");
		var entFn = fn("_bridge_inventory_entry");
		if (!countFn || !entFn) return [];
		var n = countFn() | 0;
		var out = [];
		for (var i = 0; i < n; i++) {
			out.push({
				shape: entFn(i, INV.SHAPE), frame: entFn(i, INV.FRAME),
				quality: entFn(i, INV.QUALITY), quantity: entFn(i, INV.QUANTITY),
				objId: entFn(i, INV.OBJ_ID), parent: entFn(i, INV.PARENT)
			});
		}
		return out;
	}
	function name() {
		var p = fn("_bridge_get_name_ptr");
		if (!p) return "Avatar";
		var str = utf8(p());
		return str ? str : "Avatar";
	}
	function frame() {
		var r = fn("_bridge_frame");
		return r ? r() : 0;
	}

	// --- enqueue actions -----------------------------------------------------
	function queueCommand(cmd, a, b) {
		var r = fn("_bridge_queue_command");
		return r ? r(cmd | 0, a | 0, b | 0) : 0;
	}
	function engineAction(action, down) {
		var r = fn("_bridge_engine_action");
		return r ? r(action | 0, down ? 1 : 0) : 0;
	}
	function pushEvent(type, a, b, c, d) {
		var r = fn("_bridge_push_event");
		return r ? r(type | 0, a | 0, b | 0, c | 0, d | 0) : 0;
	}
	function gesture(kind, x, y, hold) {
		var r = fn("_bridge_gesture");
		return r ? r(kind | 0, x | 0, y | 0, hold ? 1 : 0) : 0;
	}
	function setSpeed(mult) {
		var r = fn("_bridge_set_speed");
		return r ? r(+mult) : 0;
	}
	function setMode(mode) {
		var r = fn("_bridge_set_mode");
		return r ? r((mode === MODE.CLASSIC || mode === 1) ? 1 : 0) : 1;
	}
	// [W2/m3] click-to-walk. Logical game-screen pixels. Synchronous exports
	// (semantic 1 accepted / 0 rejected). The queue ids above are equivalent
	// for callers that only enqueue; the outcome is always read from
	// PATH_STATE / PATH_SEQ.
	function walkTo(x, y) {
		var r = fn("_bridge_walk_to");
		return r ? r(x | 0, y | 0) : 0;
	}
	function cancelWalk() {
		var r = fn("_bridge_cancel_walk");
		return r ? r() : 0;
	}
	function save(slot) { return queueCommand(CMD.SAVE, slot, 0); }
	function load(slot) { return queueCommand(CMD.LOAD, slot, 0); }
	function pause(flag) { return queueCommand(CMD.PAUSE, flag ? 1 : 0, 0); }
	function setOption(optionId, value) { return queueCommand(CMD.SET_OPTION, optionId, value); }
	function resetInbox() { return queueCommand(CMD.RESET_INBOX, 0, 0); }

	// --- [E3] lazy soundfont staging ----------------------------------------
	// Copies lazy-fetched SF2 bytes into the wasm heap and hands them to the
	// engine FS via _bridge_audio_set_soundfont. Never embeds a font in the
	// wasm. Returns 1 on success, 0 on any failure (caller keeps Classic FM).
	function setSoundFont(bytes) {
		var alloc = fn("_bridge_alloc");
		var put = fn("_bridge_audio_set_soundfont");
		var freeFn = fn("_free");
		if (!alloc || !put || !bytes || !bytes.length) return 0;
		var data = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		if (!data.length) return 0;
		var ptr = alloc(data.length) | 0;
		if (!ptr) return 0;
		// _bridge_alloc may trigger wasm memory growth, which REASSIGNS the
		// top-level HEAPU8 var and detaches any earlier view. Resolve the
		// CURRENT view only AFTER the allocation; never cache it (E1 lesson).
		var u8 = heapU8();
		if (!u8 || ptr < 0 || ptr + data.length > u8.length) {
			if (freeFn) freeFn(ptr);   // do not leak the staging buffer
			return 0;
		}
		u8.set(data, ptr);
		var r = put(ptr, data.length) | 0;
		if (freeFn) freeFn(ptr);
		return r ? 1 : 0;
	}
	function audio() {
		return {
			synth: readState(STATE.AUDIO_SYNTH),
			fontLoaded: readState(STATE.AUDIO_FONT_LOADED) ? true : false,
			musicVolume: readState(STATE.AUDIO_MUSIC_VOL),
			sfxVolume: readState(STATE.AUDIO_SFX_VOL),
			loadError: readState(STATE.AUDIO_LOAD_ERROR),
			fallback: readState(STATE.AUDIO_FALLBACK) ? true : false,
			contextState: readState(STATE.AUDIO_CONTEXT_STATE),
			alwaysRun: readState(STATE.ALWAYS_RUN) ? true : false
		};
	}

	// --- save export / import (byte-exact) -----------------------------------
	// Reads/writes go through heapU8() (fresh view each call) so a memory growth
	// caused by _bridge_export_save/_bridge_alloc cannot leave us holding a
	// detached view.  Return values are ordinary JS copies, not heap aliases.
	function exportSave(slot) {
		var ex = fn("_bridge_export_save");
		var sz = fn("_bridge_export_size");
		if (!ex || !sz) return null;
		var ptr = ex(slot | 0) | 0;
		var size = sz() | 0;
		if (!ptr || size <= 0) return null;
		var view = heapU8();
		if (!view || ptr < 0 || ptr + size > view.length) return null;
		var out = new Uint8Array(size);          // copy out of wasm memory
		out.set(view.subarray(ptr, ptr + size));
		return out;
	}
	function importSave(slot, bytes) {
		var al = fn("_bridge_alloc");
		var im = fn("_bridge_import_save");
		var freeFn = fn("_free");
		if (!al || !im || !freeFn) return 0;
		var data = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		if (!data.length) return 0;
		var ptr = al(data.length) | 0;
		if (!ptr) return 0;
		var view = heapU8();                     // fresh: alloc may have grown the heap
		if (!view || ptr + data.length > view.length) { freeFn(ptr); return 0; }
		view.set(data, ptr);
		var r = im(slot | 0, ptr, data.length) | 0;
		freeFn(ptr);
		return r;
	}
	function syncfs() {
		var r = fn("_bridge_syncfs");
		return r ? r() : 0;
	}
	// Additive to bridge-v1 (does not change any frozen member): the C++
	// _bridge_syncfs() returns 1 synchronously and its FS.syncfs callback is
	// fire-and-forget, so a queued save/import is NOT durable when that call
	// returns.  flushPersist() resolves against the real IDBFS callback.
	function flushPersist() {
		var M = mod();
		var F = (typeof global.FS !== "undefined" && global.FS) ? global.FS
		      : (M && M.FS) ? M.FS : null;
		if (!F || typeof F.syncfs !== "function") return Promise.resolve(false);
		return new Promise(function (resolve) {
			try { F.syncfs(false, function (errCode) { resolve(!errCode); }); }
			catch (e) { resolve(false); }
		});
	}

	// --- [v1.2] logical<->canvas mapping --------------------------------
	// The engine reports LOGICAL_W/H (the virtual surface the game draws into,
	// i.e. the coord space gesture() consumes) and the exact letterbox draw
	// rect GAME_DRAW_X/Y/W/H inside the canvas backing store (WINDOW_W/H),
	// taken straight from the graphics backend (windowed.h _gameDrawRect).  Use
	// the same affine transform the backend uses in convertWindowToVirtual()
	// instead of assuming the canvas pixels ARE game pixels.
	function viewport() {
		return {
			ok: readState(STATE.VIEWPORT_OK) ? true : false,
			logicalW: readState(STATE.LOGICAL_W), logicalH: readState(STATE.LOGICAL_H),
			// [HD0-E1F] Physical backing-store/texture size (blit/upload only).
			renderW: readState(STATE.RENDER_W), renderH: readState(STATE.RENDER_H),
			windowW: readState(STATE.WINDOW_W), windowH: readState(STATE.WINDOW_H),
			drawX: readState(STATE.GAME_DRAW_X), drawY: readState(STATE.GAME_DRAW_Y),
			drawW: readState(STATE.GAME_DRAW_W), drawH: readState(STATE.GAME_DRAW_H)
		};
	}
	// clientX/clientY are DOM (CSS px) coords, e.g. from a pointer event.
	// Returns { x, y, ok }: logical engine coords, or ok:false if unmappable.
	function clientToLogical(clientX, clientY) {
		var c = (global.document && global.document.getElementById("canvas")) || null;
		var v = viewport();
		if (!c || !v.ok || !v.drawW || !v.drawH || !v.logicalW || !v.logicalH)
			return { x: 0, y: 0, ok: false };
		var r = c.getBoundingClientRect();
		if (!r.width || !r.height) return { x: 0, y: 0, ok: false };
		// CSS client px -> canvas backing (WINDOW_*) px
		var cx = (clientX - r.left) * (v.windowW / r.width);
		var cy = (clientY - r.top) * (v.windowH / r.height);
		// backing px -> logical, via the real draw rect (source) + logical dims (target)
		var lx = ((cx - v.drawX) * v.logicalW + v.drawW / 2) / v.drawW;
		var ly = ((cy - v.drawY) * v.logicalH + v.drawH / 2) / v.drawH;
		return { x: lx | 0, y: ly | 0, ok: true };
	}

	// --- [T2/CP20] pre-main GM->FM boot guard -----------------------------
	// Fresh-process stall cause (NOT a timeout): the persisted scummvm.ini can
	// request a concrete General MIDI / MT-32 device. In particular the shell's
	// staged-soundfont path (ultima8_bridge.cpp bridge_audio_set_soundfont)
	// writes gm_device=fluidsynth + music_driver=auto + a soundfont path, and
	// applyOption(BY_MUSIC_SYNTH,1) re-asserts gm_device=fluidsynth. On the next
	// fresh process, if the staged font ($HOME/u8gm.sf2) is missing, the wrong
	// size, or not RIFF/sfbk, MidiDriver::detectDevice() reaches the
	// "preferred audio device ... cannot be used" GUI::MessageDialog
	// (engine/audio/mididrv.cpp ~L289-306) BEFORE the MIDI player exists. That
	// native modal blocks READY until a human clicks OK, which a headless or
	// fresh WebKit process never does.
	//
	// We must not touch the engine or the frozen WASM, so this JS runs AFTER
	// the IDBFS populate (the persisted ini is on the FS) and BEFORE C++ reads
	// the config: EmscriptenFilesystemFactory::_initSettings
	// (engine/backends/fs/emscripten/emscripten-fs-factory.cpp L30-65) mounts
	// IDBFS at $HOME then `await FS.syncfs(true, cb)`. Wrapping FS.mount /
	// FS.syncfs lets the guard run inside that populate callback and finish
	// before the factory constructor (and every later ConfMan read) resumes.
	// The guard only downgrades to the engine's own Classic FM representation
	// (audio_synth=0, music_driver=adlib -- see applyOption BY_MUSIC_SYNTH in
	// ultima8_bridge.cpp); it never removes files, never rewrites unrelated
	// keys or saves, and is a no-op unless a concrete GM/MT-32 device is
	// explicitly requested AND no valid staged font is present.
	var BOOT_FONT_SIZES = [32319396, 5969788];   // approved desktop/mobile SF2
	var bootState = { fallback: false, reason: "", timedOut: false };
	// Once the guard has ACTUALLY forced FM this boot, that fact and its reason
	// must survive every later ConfMan/writeFile re-check. After the guard
	// rewrites music_driver=adlib, a subsequent recheck sees the rewritten ini
	// and would otherwise clear fallback to false ("no-gm-request"), losing the
	// visible explanation the UI polls. `timedOut` (the watchdog) stays
	// independent of this.
	var forcedFmReason = null;
	function emitBootStatus() {
		try {
			if (typeof global.CustomEvent === "function" && typeof global.dispatchEvent === "function")
				global.dispatchEvent(new global.CustomEvent("u8:boot-status", { detail: bootState }));
		} catch (e) {}
	}
	function setBootStatus(patch) {
		if (patch) {
			if (forcedFmReason !== null && patch.fallback === false) {
				// The downgrade is sticky for the rest of this boot.
				bootState.fallback = true;
				bootState.reason = forcedFmReason;
				if ("timedOut" in patch) bootState.timedOut = !!patch.timedOut;
				emitBootStatus();
				return bootState;
			}
			if ("fallback" in patch) bootState.fallback = !!patch.fallback;
			if ("timedOut" in patch) bootState.timedOut = !!patch.timedOut;
			if ("reason" in patch) bootState.reason = String(patch.reason == null ? "" : patch.reason);
			if (patch.fallback === true && forcedFmReason === null) forcedFmReason = bootState.reason;
			emitBootStatus();
		}
		return bootState;
	}
	function bootStatus() { return bootState; }

	function fsRef() {
		var M = mod();
		if (typeof global.FS !== "undefined" && global.FS) return global.FS;
		if (M && M.FS) return M.FS;
		return null;
	}

	var idbfsHome = null;          // $HOME captured from FS.mount(IDBFS,...)
	var fsGuardInstalled = false;
	var inBootGuard = false;
	// [CP82] boot-guard diagnostics + deterministic install bookkeeping
	var guardDiag = { installVia: null, installAt: null, preRunQueued: false, preRunFired: false, runs: [] };
	try { global.__u8BootGuardDiag = guardDiag; } catch (e) {}

	function iniGet(text, key) {
		var m = text.match(new RegExp("^[ \\t]*" + key + "[ \\t]*=[ \\t]*(.*)$", "mi"));
		return m ? m[1].replace(/[ \t\r]+$/, "") : null;
	}
	function iniSet(text, key, value) {
		var re = new RegExp("^[ \\t]*" + key + "[ \\t]*=.*$", "mi");
		if (re.test(text)) return text.replace(re, key + "=" + value);
		var sec = /^\[scummvm\][ \t]*\r?$/mi;
		if (sec.test(text))
			return text.replace(sec, function (s) { return s + "\n" + key + "=" + value; });
		return text.replace(/\s*$/, "") + "\n[scummvm]\n" + key + "=" + value + "\n";
	}
	// A staged font is usable only if it exists, is one of the two approved
	// sizes, and carries the SF2 RIFF/sfbk header. A same-size but corrupt body
	// with an intact header cannot be detected here without re-reading 32 MB;
	// the native sfload() is the authority past this point (documented limit).
	function checkStagedFont(F, fontPath) {
		var st;
		try { st = F.stat(fontPath); } catch (e) { return { ok: false, reason: "gm-font-missing" }; }
		if (!st || typeof st.size !== "number") return { ok: false, reason: "gm-font-missing" };
		if (BOOT_FONT_SIZES.indexOf(st.size) < 0) return { ok: false, reason: "gm-font-size=" + st.size };
		var head;
		try {
			var fd = F.open(fontPath, 0);            // O_RDONLY
			head = new Uint8Array(12);
			F.read(fd, head, 0, 12, 0);
			F.close(fd);
		} catch (e) { return { ok: false, reason: "gm-font-unreadable" }; }
		var tag = function (o) {
			return String.fromCharCode(head[o], head[o + 1], head[o + 2], head[o + 3]);
		};
		if (tag(0) !== "RIFF" || tag(8) !== "sfbk") return { ok: false, reason: "gm-font-header" };
		return { ok: true, reason: "gm-font-ok", size: st.size };
	}
	function runBootGuard() {
		if (inBootGuard) return bootState;
		var F = fsRef();
		if (!F || typeof F.readFile !== "function" || typeof F.analyzePath !== "function") return bootState;
		inBootGuard = true;
		try {
			var home = idbfsHome || "/home/web_user";
			var cfgPath = home + "/scummvm.ini";
			try { guardDiag.runs.push({ t: Date.now(), phase: "enter", exists: !!F.analyzePath(cfgPath).exists }); } catch (e) {}
			if (!F.analyzePath(cfgPath).exists)
				return setBootStatus({ fallback: false, reason: "no-config" });
			var text = F.readFile(cfgPath, { encoding: "utf8" });
			// [W2] Pre-boot art_mode injection from localStorage
			var origText = text;
			try {
				var stored = global.localStorage.getItem("u8_art_mode");
				if (stored === "classic" || stored === "hd2" || stored === "hd4") {
					text = iniSet(text, "art_mode", stored);
				}
			} catch (e) {}
			if (text !== origText) {
				try { F.writeFile(cfgPath, text); } catch (e) {}
			}
			try { guardDiag.runs.push({ t: Date.now(), phase: "inject", wrote: text !== origText, artMode: iniGet(text, "art_mode") }); } catch (e) {}
			var concrete = function (v) { return !!v && v !== "auto" && v !== "null"; };
			var gmDev = (iniGet(text, "gm_device") || "").toLowerCase();
			var mtDev = (iniGet(text, "mt32_device") || "").toLowerCase();
			var mus = (iniGet(text, "music_driver") || "").toLowerCase();
			// music_driver=adlib already short-circuits detectDevice() to the
			// built-in FM driver before the GM/MT-32 branch (no modal), so a
			// stale gm_device left behind by applyOption's FM path is not a GM
			// request and must not be re-flagged as a fallback.
			if (mus === "adlib" || (!concrete(gmDev) && !concrete(mtDev) && !concrete(mus)))
				return setBootStatus({ fallback: false, reason: "no-gm-request" });
			var sf = iniGet(text, "soundfont");
			var fontPath = (sf && sf.charAt(0) === "/") ? sf : (home + "/u8gm.sf2");
			var font = checkStagedFont(F, fontPath);
			if (font.ok) return setBootStatus({ fallback: false, reason: font.reason });
			var out = iniSet(iniSet(text, "audio_synth", "0"), "music_driver", "adlib");
			if (out !== text) F.writeFile(cfgPath, out);
			return setBootStatus({ fallback: true, reason: "forced-fm:" + font.reason });
		} catch (e) {
			// Honest fall-through: never spin, mute, or mutate on an unexpected
			// runtime; leave the config exactly as the engine wrote it.
			return setBootStatus({ fallback: false, reason: "guard-error" });
		} finally {
			inBootGuard = false;
		}
	}
	function installFsGuard() {
		var F = fsRef();
		if (!F || fsGuardInstalled) return fsGuardInstalled;
		try {
			if (typeof F.mount === "function" && !F.__u8guardMount) {
				var origMount = F.mount;
				F.mount = function (type, opts, path) {
					try { if (opts && opts.autoPersist) idbfsHome = path; } catch (e) {}
					return origMount.apply(F, arguments);
				};
				F.__u8guardMount = true;
			}
			if (typeof F.syncfs === "function" && !F.__u8guardSync) {
				var origSync = F.syncfs;
				F.syncfs = function (populate, cb) {
					var done = function (err) {
						if (populate) { try { runBootGuard(); } catch (e) {} }
						if (typeof cb === "function") cb(err);
					};
					try { return origSync.call(F, populate, done); }
					catch (e) { if (typeof cb === "function") cb(e); }
				};
				F.__u8guardSync = true;
			}
			// Cover the "no persisted ini -> shell fetches a default" path: the
			// fetch writes scummvm.ini after the populate callback, so re-check
			// once the file materialises (gated so our own write cannot recurse).
			if (typeof F.writeFile === "function" && !F.__u8guardWrite) {
				var origWrite = F.writeFile;
				F.writeFile = function (path, data, opts) {
					var r = origWrite.apply(F, arguments);
					try {
						if (!inBootGuard && typeof path === "string" && /(^|\/)scummvm\.ini$/.test(path))
							runBootGuard();
					} catch (e) {}
					return r;
				};
				F.__u8guardWrite = true;
			}
			fsGuardInstalled = true;
		} catch (e) {}
		return fsGuardInstalled;
	}

	var api = {
		version: BRIDGE_VERSION,
		STATE: STATE, INV: INV, EVENT: EVENT, BUTTON: BUTTON, ACTION: ACTION,
		CMD: CMD, MODE: MODE, GESTURE: GESTURE, OPTION: OPTION, ENGINE_EVENT: ENGINE_EVENT,
		get ready() { return ready; },
		isReady: function () { return ready; },
		whenReady: whenReady,
		canvas: function () { return (global.document && global.document.getElementById("canvas")) || null; },
		on: on, off: off,
		readState: readState, snapshot: snapshot, inventory: inventory, name: name, frame: frame,
		viewport: viewport, clientToLogical: clientToLogical,
		queueCommand: queueCommand, engineAction: engineAction, pushEvent: pushEvent,
		gesture: gesture, setSpeed: setSpeed, setMode: setMode,
		walkTo: walkTo, cancelWalk: cancelWalk,
		save: save, load: load, pause: pause, setOption: setOption, resetInbox: resetInbox,
		setSoundFont: setSoundFont, audio: audio,
		exportSave: exportSave, importSave: importSave, syncfs: syncfs,
		flushPersist: flushPersist,
		bootStatus: bootStatus,
		getArtState: function () {
			if (!ready) return null;
			var getFn = fn("_u8_art_get_state");
			if (!getFn) return null;
			try {
				var ptr = getFn();
				if (!ptr) return null;
				return JSON.parse(utf8(ptr));
			} catch (e) { return null; }
		},
		setArtMode: function (mode) {
			if (typeof mode !== "string" || (mode !== "classic" && mode !== "hd2" && mode !== "hd4"))
				return false;
			// Write to localStorage first
			var storageWritten = false;
			try {
				global.localStorage.setItem("u8_art_mode", mode);
				storageWritten = true;
			} catch (e) {
				// localStorage write failed - return false immediately
				return false;
			}
			// localStorage written successfully
			// Call native if ready
			if (!ready) return true;  // localStorage written, native not ready yet
			var M = mod();
			if (!M || !M.ccall) return true;  // localStorage written, ccall not available
			try {
				var ret = M.ccall("u8_art_set_mode", "number", ["string"], [mode]);
				return ret === 0;
			} catch (e) { return false; }
		}
	};

	global.Ultima8Bridge = api;
	global.Ultima8BootStatus = bootState;
	installHook();
	// Wrap FS.syncfs/ FS.mount ASAP so the guard runs inside
	// EmscriptenFilesystemFactory::_initSettings' IDBFS populate, before any C++
	// config read. FS is a top-level var in scummvm.js, so it normally exists
	// already; retry until the runtime FS is visible if not.
	function installGuardVia(tag) {
		var was = fsGuardInstalled;
		var ok = installFsGuard();
		if (ok && !was) { guardDiag.installVia = tag; guardDiag.installAt = Date.now(); }
		return ok;
	}
	// [CP82] Deterministic path: Emscripten runs Module.preRun after FS exists
	// and before main(), i.e. before _initSettings' IDBFS populate.
	(function queuePreRunGuard() {
		try {
			var M = mod();
			if (!M) return;
			if (typeof M.preRun === "function") M.preRun = [M.preRun];
			if (!Array.isArray(M.preRun)) M.preRun = [];
			M.preRun.unshift(function () {
				guardDiag.preRunFired = true;
				try { installGuardVia("preRun"); } catch (e) {}
			});
			guardDiag.preRunQueued = true;
		} catch (e) {}
	})();
	// Fallback poll (unchanged behaviour) in case preRun was unavailable.
	(function installFsGuardSoon() {
		if (installGuardVia("poll")) return;
		setTimeout(installFsGuardSoon, 50);
	})();
	// READY-state watchdog: surface a boot timeout WITHOUT faking READY or
	// auto-clicking any native modal. The UI owns any follow-up (e.g. restart).
	setTimeout(function () { if (!ready) setBootStatus({ timedOut: true }); }, 20000);
})(typeof self !== "undefined" ? self : this);
