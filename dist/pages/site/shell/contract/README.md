# shell/contract — the authoritative E1 bridge contract

`bridge-v1.json` here is a **byte-for-byte copy** of the authoritative contract:

    .scratch/contracts/bridge-v1.json

That canonical file is read-only for the shell worker. This copy exists only so
the shell can (a) generate its enum tables offline and (b) run contract checks
under Node. It must never diverge from the canonical file.

- Verify equality with the canonical path (when reachable):
  `node tools/check-contract.mjs`
- Regenerate the derived tables after a contract change:
  `node tools/gen-contract.mjs`
- The adapter (`shell/ui/bridge.js`) imports every state/gesture/event/mode table
  from the generated `shell/ui/contract.js`; there is no second hand-copied table.

Do not edit `bridge-v1.json` by hand. If the contract changes, re-copy it from
the canonical path and re-run the generator.

## Additive deltas (feature-detected by NAME)

The frozen `bridge-v1.json` (state 0..24, events 1..8, commands 1..8,
gestures 1..8) never changes. Later engine work lands as **additive deltas**:

- `bridge-v1.1-delta.json` — E2b: `TARGET_*` (25..34), `FIXTURE_*` (35..38),
  `SAVE_RESULT`/`LOAD_RESULT` (7/8). Copied from the canonical
  `.scratch/contracts/` path; read-only upstream, never hand-edited here.
- `bridge-v1.2-delta.json` — E2c (CP14): `AVATAR_SCREEN_X/Y/OK` (39..41),
  `LOGICAL_W/H` (42/43), `WINDOW_W/H` (44/45), `GAME_DRAW_X/Y/W/H` (46..49),
  `VIEWPORT_OK` (50), `TEXT_INPUT_ACTIVE` (51); facade
  `viewport()`/`clientToLogical()`.
- `bridge-v1.3-delta.json` — E3 (CP15/CP16): `AUDIO_SYNTH` (53) ..
  `ALWAYS_RUN` (60), options `MUSIC_SYNTH` (6) / `ALWAYS_RUN` (7), facade
  `setSoundFont(bytes)`/`audio()`. These are read by the generator because the
  delta publishes explicit frozen ids, so `ui/contract.js` gains `OPTION` and
  `AUDIO_STATE` (v1.1/v1.2 stay read-by-name through the snapshot).

`bridge-v1.json` stays 0..24, so the generated `ui/contract.js` tables have no
slot for the delta fields. `ui/bridge.js` therefore reads every delta field by
its **published string name** through the snapshot (`pickNumber`), never a
hard-coded index, and feature-detects before use (missing => decline, not a
guess). Re-copy these two files from canonical when the engine publishes a
newer delta; they are documentation, not generated input.
