# Shell → engine mapping

The shell turns player input into abstract actions (`core/actions.js`) and hands
them to the real bridge (`ui/bridge.js`). The bridge speaks the frozen v1
contract: the engine page is a **same-origin iframe**
(`../scummvm.html#ultima8`) and the shell calls the engine's own JS facade
(`iframe.contentWindow.Ultima8Bridge`) directly. There is no postMessage
envelope and no synthetic event sink.

## One authoritative contract

Every symbolic engine name — message ids, state indices, action ids, gesture
ids — lives in the generated table `ui/contract.js`, produced from
`shell/contract/bridge-v1.json` (copied byte-for-byte from the canonical
`.scratch/contracts/bridge-v1.json`). `shell/tools/check-contract.mjs` fails the
build if the copy or the generated table drifts. Nothing is invented: anything
the contract does not expose is reported as a gap in `CHECKPOINT.md` and
degraded visibly in the UI rather than faked.

Abstract action → contract call resolution (`ui/bridge.js`):

| Abstract action | Contract call |
| --- | --- |
| MOVE_* (8-way) | `engineAction` MOVE_UP/DOWN/LEFT/RIGHT (diagonals send two held flags) |
| RUN / JUMP / CLIMB | `engineAction` MOVE_RUN / JUMP (CLIMB is approximate) |
| ATTACK / KICK / BLOCK / USE / PICK_UP | `gesture` (mouse click kinds) |
| INVENTORY / COMBAT_TOGGLE / QUICK_SAVE / QUICK_LOAD / MENU | `engineAction` |
| PAUSE | `pause` |

Player-facing copy and the one engine URL constant live in `ui/config.js`.

## Dev mock

The product default is **always** the real bridge. A recording mock
(`createMockShellBridge`) is reachable only behind an explicit flag —
`?dev`, `?dev=mock`, `?bridge=mock`, `window.__U8_DEV_MOCK__ === true`, or
`localStorage["ultima8.dev.mock"] === "1"` — so the Node suites and the host
UI-wiring harness can observe commands without claiming playability. The mock
records dispatches with `declined: "dev-mock"` and deliberately exposes no
`exportSave`/`importSave`, so the save UI reports the gap honestly.

## Classic mode: keyboard passthrough

Classic does **not** map keyboard keys to abstract actions. `getBindings
("classic")` sets `passthrough: true` with an empty keyboard table, so the shell
forwards the physical key straight to the engine's own keymapper
(`ui/bridge.js` `rawKey` → `pushEvent`). There is **no second keymap**; the
engine keeps its own native defaults:

| Key | Meaning |
| --- | --- |
| F1 | quicksave |
| F5 | save |
| F7 | load |
| Space | jump |

These are the engine-native U8 defaults from
`vendor/scummvm/engines/ultima/ultima8/metaengine.cpp` (`U8_KEYS`). **Space is
`ACTION_JUMP`, not attack** — `Space` is attack only in `CRUSADER_KEYS`
(Crusader games), which Ultima VIII does not use.

Ultima VIII melee is **mouse-driven**, not a keyboard attack key (ground truth:
`ultima8/world/actors/u8_avatar_mover_process.cpp`):

| Input | Meaning |
| --- | --- |
| Hold left mouse | block |
| Double left mouse | attack |
| Double right mouse | kick |

Classic also forces `gameSpeed 1`, `combatAssist false`, `fastTravel false`
(`core/settings.js` `applyModePolicy`). Gamepad and touch keep explicit
bindings in Classic so mobile stays usable.

Modern mode maps WASD/arrows/numpad and dedicated action keys through
`core/inputmap.js`, and the shell owns those bound actions in `world` — even
when the engine iframe has focus.
