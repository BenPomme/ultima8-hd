# ScummVM GPL source offer (pinned) and how to actually obtain the source

The shipped `scummvm.wasm` / `scummvm.js` are a build of **ScummVM**, free
software under the GNU GPL (upstream is GPL-3.0-or-later; the authoritative text
ships in the release under `doc/COPYING`, `doc/COPYRIGHT`, `doc/COPYING.*`).
Because this is a *modified* build, the complete corresponding source is
provided as a single archive (see below). This is the written offer and the
concrete route to it.

## What you get

| piece | value |
|---|---|
| Upstream project | ScummVM (`https://github.com/scummvm/scummvm`) |
| Pinned upstream commit | `929be8852be275b23c1cf9a8b036d262a236e8af` |
| Emscripten SDK | `4.0.10` (wasm32-unknown-emscripten) |
| SDL | `3.2.4`, patched (Emscripten port) |
| FluidLite | `b0f187b404e393ee0a495b277154d55d7d03cbeb` |
| Our changes | the source archive's `scummvm/` tree + `patches/` |

## The complete corresponding source archive

`tools/release/make_source_archive.sh` produces ONE archive,
`ultima-pagan-modern-corresponding-source-<pin12>-<stamp>.tar.gz`, containing:

```
<name>-source/
  scummvm/        the modified ScummVM tree at the pin, as REAL source
                  (ultima8_bridge.cpp/.h, modern_combat.cpp/.h,
                   dists/emscripten/assets/ultima8-bridge.js included --
                   not as a patch tar). No .git, no build outputs, no game data.
  sdl3/           the patched SDL 3.2.4 source
  deps/fluidlite/ FluidLite source at the pinned commit (+ non-runtime note)
  licences/       every licence/attribution text
  patches/        cumulative delta + SDL port patch + source manifest
  BUILD.md        the exact manual build recipe (configure flags, strip step)
  SOURCE-OFFER.md what this is
```

It is materialized from real git objects via a throwaway index/object store, and
its completeness is proven two ways: the packed tree is compared against the
staged git tree, and the cumulative patch is re-applied to a pristine pinned
extraction and required to yield the identical manifest.

## Manual rebuild (no download wrapper, no SDK reset)

Unlike a generic `build.sh`, this route never re-downloads or overwrites the
patched SDL. The exact commands are in the archive's `BUILD.md`; in short:

```sh
# 1. Activate the pinned SDK.
./emsdk install 4.0.10 && ./emsdk activate 4.0.10 && source emsdk_env.sh

# 2. Build the ALREADY patched SDL 3.2.4 from sdl3/ as the -sUSE_SDL=3 port.
#    Do not apply the supplementary SDL patch again. See BUILD.md for the
#    source-cache marker and embuilder command.

# 3. Build FluidLite from deps/fluidlite/ (CMake, wasm32-unknown-emscripten)
#    into an install prefix.

# 4. Configure ScummVM (exact flags):
cd scummvm
emconfigure ./configure \
  --host=wasm32-unknown-emscripten --build=wasm32-unknown-emscripten \
  --disable-all-engines --enable-engine=ultima8 --enable-fluidlite \
  --with-fluidlite-prefix="$PWD/dists/emscripten/libs/build"

# 5. Release strip (EXACT): flag 0 AND delete the six guarded objects FIRST,
#    because make does not track CXXFLAGS:
rm -f engines/ultima/ultima8/ultima8_bridge.o \
      engines/ultima/ultima8/misc/debugger.o \
      engines/ultima/ultima8/world/actors/modern_combat.o \
      engines/ultima/ultima8/world/actors/actor.o \
      engines/ultima/ultima8/world/actors/animation_tracker.o \
      engines/ultima/ultima8/world/actors/combat_process.o
emmake make -j12 ENABLE_U8_QA_FIXTURE=0
emmake make dist-emscripten ENABLE_U8_QA_FIXTURE=0 DIST_FILES_SOUNDFONTS=
[ -e build-emscripten/data/Roland_SC-55.sf2 ] && rm -f build-emscripten/data/Roland_SC-55.sf2
```

**No reproducibility claim.** The recipe above is the exact one used; the host
supplies the *observed* shipped `scummvm.wasm` sha256 for comparison only. We do
not claim a byte-identical rebuild, and we do not ship any SDK binary or cache.

## Do not double-apply the MenuClose patch

Apply the cumulative patch **or** replay the per-commit series, never both, and
never also apply the standalone `0001-menuclose-idempotent.patch`: the cumulative
patch already contains those hunks, so applying both duplicates them. Per-commit
patches are supplementary audit artifacts; the cumulative patch is canonical.

## Where this offer is surfaced

- Copied into the staged release at `docs/release/licence/scummvm-source-offer.md`.
- Reachable from `docs/release/licence/INDEX.md` (the shell's "Licences" screen).

## Game data and hosted edition

**About this distribution.** This website hosts a playable browser build of *Ultima VIII: Pagan*. It includes the original game data files, which are © Electronic Arts Inc. / Origin Systems, together with an open-source engine compiled to WebAssembly. Ultima and Pagan are trademarks of their respective owners. This is a non-commercial fan project and is not affiliated with or endorsed by Electronic Arts. Rights holders with concerns may contact: `jckduncan6@gmail.com`.

**Source code.** The complete corresponding source for the engine (including our modifications), the patched SDL3 and FluidLite libraries, the browser front end and the NPC proxy is available at `https://github.com/BenPomme/ultima8-hd`. Download the complete corresponding source from https://github.com/BenPomme/ultima8-hd/releases/tag/source-v1. The source archive does not contain the original game data files.

**AI dialogue.** Some NPC replies are generated by a large language model via OpenRouter. Memory of your conversations is stored only in your browser and can be erased with "Forget this NPC".
