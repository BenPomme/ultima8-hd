#!/usr/bin/env bash
# make_source_archive.sh -- build the COMPLETE corresponding source archive for
# the shipped Ultima VIII: Pagan browser port.
#
# *** Runs offline. Never writes inside the engine tree. ***
#
# This is the GPL/ LGPL "corresponding source" deliverable: one archive that
# contains everything needed to rebuild the shipped engine AND the shipped
# runtime assets, with no reliance on a network, an SDK cache, a git checkout or
# the user's private game data:
#
#   <label>-source/
#     scummvm/            the modified ScummVM tree at the pin (all new/modified
#                         files -- bridge, modern_combat, bridge JS -- included;
#                         no .git, no build outputs, no game data, no caches)
#     sdl3/               the patched SDL 3.2.4 source (source only)
#     deps/fluidlite/     the FluidLite source at the pinned commit
#     licences/           every licence/attribution text
#     patches/            cumulative delta + out-of-tree SDL patch + manifest
#     BUILD.md            the exact manual build recipe
#     SOURCE-OFFER.md     what this is and how to use it
#     SOURCE-MANIFEST.txt deterministic file list (path, size, sha256)
#
# The modified tree is materialized from real git objects via a throwaway index
# and object store (never the engine's real index/worktree), so the archive is a
# genuine source tree, NOT a tar of patches. Completeness is proven by
# (a) comparing the packed tree against the staged git tree, and (b) re-applying
# the cumulative patch to a pristine pinned extraction and requiring the same
# manifest.
#
# No reproducibility claim: BUILD.md documents the recipe and the *observed*
# shipped wasm hash (passed with --engine-sha256) for comparison; it does not
# claim a byte-identical rebuild.
#
# Usage (all paths outside the engine tree):
#   tools/release/make_source_archive.sh \
#     --engine      <scummvm-worktree-root> \
#     --out         <out-dir> \
#     --engine-sha256 04bcb1e6... \
#     --sdl-src     <patched SDL 3.2.4 source dir> \
#     --fluidlite-src <FluidLite source dir or .tar.gz> \
#     --licence-src <licence dir> \
#     --extra-patch engine-patches/0002-sdl3-emscripten-unregister.patch \
#     --label ultima-pagan-modern
#
#   # plan only (no writes):
#   tools/release/make_source_archive.sh --engine <root> --out <dir> --check
set -euo pipefail

DEFAULT_PIN="929be8852be275b23c1cf9a8b036d262a236e8af"
DEFAULT_LABEL="ultima-pagan-modern"
# Non-ignored Emscripten build outputs at the engine tree root: build products,
# never source. (The .o/.deps/build-* siblings are covered by .gitignore.)
DEFAULT_BUILD_ARTIFACTS=(scummvm.js scummvm.wasm scummvm.html scummvm.html.symbols scummvm-conf.js scummvm-conf.wasm)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MAIN="${MAIN:-$ROOT}"

ENGINE=""
PIN="$DEFAULT_PIN"
OUT=""
LABEL="$DEFAULT_LABEL"
ENGINE_SHA256=""
SDL_SRC=""
FLUIDLITE_SRC=""
LICENCE_SRC=""
EXTRA_PATCH=""
FILELIST=""
RELEASE_EVIDENCE=""
DISPLAY_PATCH=""
RELEASE_NOTES=""
STAMP=""
CHECK_ONLY=0
VERIFY=1

# Default read-only discovery (overridable). No hash is hardcoded here.
default_sdl() {
  local p="$MAIN/.scratch/worktrees/T2-wasm-build-spike/engine/dists/emscripten/emsdk-4.0.10/upstream/emscripten/cache/ports/sdl3/SDL-release-3.2.4"
  [[ -d "$p" ]] && printf '%s' "$p"
}
default_fluidlite() {
  local p="$MAIN/.scratch/worktrees/T2-wasm-build-spike/engine/dists/emscripten/libs/FluidLite-b0f187b404e393ee0a495b277154d55d7d03cbeb"
  [[ -d "$p" ]] && printf '%s' "$p"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine)        ENGINE="${2:-}"; shift 2 ;;
    --pin)           PIN="${2:-}"; shift 2 ;;
    --out)           OUT="${2:-}"; shift 2 ;;
    --label)         LABEL="${2:-}"; shift 2 ;;
    --engine-sha256) ENGINE_SHA256="${2:-}"; shift 2 ;;
    --sdl-src)       SDL_SRC="${2:-}"; shift 2 ;;
    --fluidlite-src) FLUIDLITE_SRC="${2:-}"; shift 2 ;;
    --licence-src)   LICENCE_SRC="${2:-}"; shift 2 ;;
    --extra-patch)   EXTRA_PATCH="${2:-}"; shift 2 ;;
    --filelist)      FILELIST="${2:-}"; shift 2 ;;
    --release-evidence) RELEASE_EVIDENCE="${2:-}"; shift 2 ;;
    --display-patch) DISPLAY_PATCH="${2:-}"; shift 2 ;;
    --release-notes) RELEASE_NOTES="${2:-}"; shift 2 ;;
    --stamp)         STAMP="${2:-}"; shift 2 ;;
    --no-verify)     VERIFY=0; shift ;;
    --check)         CHECK_ONLY=1; shift ;;
    -h|--help)       sed -n '1,60p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s ==\n' "$*"; }
die()  { echo "error: $*" >&2; exit 2; }

[[ -n "$ENGINE" ]] || die "--engine is required"
[[ -n "$OUT"   ]] || die "--out is required"
[[ -d "$ENGINE" ]] || die "engine path not found: $ENGINE"
ENGINE="$(cd "$ENGINE" && pwd -P)"
git -C "$ENGINE" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git worktree: $ENGINE"
TOP="$(git -C "$ENGINE" rev-parse --show-toplevel)"; TOP="$(cd "$TOP" && pwd -P)"
[[ "$TOP" == "$ENGINE" ]] || die "--engine must be the worktree root (root: $TOP)"
git -C "$ENGINE" cat-file -e "${PIN}^{commit}" 2>/dev/null || die "--pin does not resolve: $PIN"

OUTABS="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$OUT")"
case "$OUTABS" in
  "$ENGINE"|"$ENGINE"/*) die "--out must be outside the engine tree: $OUTABS" ;;
esac

[[ -n "$SDL_SRC" ]] || SDL_SRC="$(default_sdl)"
[[ -n "$FLUIDLITE_SRC" ]] || FLUIDLITE_SRC="$(default_fluidlite)"
[[ -n "$LICENCE_SRC" ]] || LICENCE_SRC="$MAIN/.scratch/licenses/soundfonts"
[[ -n "$STAMP" ]] || STAMP="$(date -u +%Y%m%d)"

SHORT="${PIN:0:12}"
NAME="$LABEL-corresponding-source-$SHORT-$STAMP"

step "plan"
cat <<EOF
engine:        $ENGINE
pin:           $PIN
out:           $OUTABS
label:         $LABEL
shipped-sha256: ${ENGINE_SHA256:-<not supplied>}
sdl source:    ${SDL_SRC:-<none>}
fluidlite:     ${FLUIDLITE_SRC:-<none>}
licences:      ${LICENCE_SRC:-<none>}
extra patch:   ${EXTRA_PATCH:-<none>}
filelist:      ${FILELIST:-<none>}
verify:        $VERIFY
archive name:  $NAME.tar.gz
EOF

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo; echo "check-only: validated inputs; nothing written."; exit 0
fi

mkdir -p "$OUTABS"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ultima-src-archive.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- 1. materialize the modified tree from real git objects ------------------
step "1/6 stage delta into a throwaway index"
COMMON_OBJ="$(git -C "$ENGINE" rev-parse --path-format=absolute --git-path objects)"
[[ -d "$COMMON_OBJ" ]] || die "cannot resolve engine object directory"
export GIT_INDEX_FILE="$WORK/index"
export GIT_OBJECT_DIRECTORY="$WORK/objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$COMMON_OBJ"
mkdir -p "$WORK/objects"

git -C "$ENGINE" read-tree "$PIN"
git -C "$ENGINE" add -A -- .
for p in "${DEFAULT_BUILD_ARTIFACTS[@]}"; do
  git -C "$ENGINE" rm --cached -q --ignore-unmatch -- "$p" >/dev/null 2>&1 || true
done
TREE="$(git -C "$ENGINE" write-tree)"
echo "staged tree: $TREE"

# Cumulative patch = the whole source delta at the pin (canonical audit artifact).
CUM="$OUTABS/$LABEL-cumulative-$STAMP-$SHORT.patch"
git -C "$ENGINE" diff --cached --binary "$PIN" > "$CUM"
echo "cumulative patch: $CUM ($(wc -c < "$CUM" | tr -d ' ') B)"

# Deterministic manifest straight from the staged git tree (authoritative).
MAN="$OUTABS/$LABEL-source-manifest-$STAMP.txt"
git -C "$ENGINE" ls-tree -r --long "$TREE" | awk '{print $3, $4, $5, $6}' \
  | sed 's/  */ /g' > "$MAN"
echo "source manifest:  $MAN ($(wc -l < "$MAN" | tr -d ' ') entries)"

# --- 2. extract the tree (source, not a patch tar) ---------------------------
step "2/6 extract modified source tree"
mkdir -p "$WORK/src"
git -C "$ENGINE" archive --format=tar "$TREE" -o "$WORK/tree.tar"
tar -xf "$WORK/tree.tar" -C "$WORK/src"
echo "extracted $(find "$WORK/src" -type f | wc -l | tr -d ' ') files"

# --- 3. completeness proofs ---------------------------------------------------
if [[ "$VERIFY" == 1 ]]; then
  step "3/6 verify: reverse-apply + pristine re-apply"
  # (a) reverse-apply the cumulative patch inside the extracted tree: it must
  #     undo exactly to the pin with no fuzz.
  ( cd "$WORK/src" && git apply --reverse --check "$CUM" ) \
    || die "reverse-apply check failed: archived tree != cumulative patch"
  echo "reverse-apply OK"
  # (b) apply the cumulative patch to a pristine pinned extraction and require
  #     the SAME manifest -- this proves the patch is complete (not a stub).
  mkdir -p "$WORK/pristine"
  git -C "$ENGINE" archive --format=tar "$PIN" -o "$WORK/pin.tar"
  tar -xf "$WORK/pin.tar" -C "$WORK/pristine"
  ( cd "$WORK/pristine" && git apply "$CUM" ) \
    || die "cumulative patch did not apply cleanly to a pristine pinned tree"
  ( cd "$WORK/src" && find . -type f ! -name '.git*' -print0 | sort -z \
      | xargs -0 shasum -a 256 > "$WORK/a.sums" )
  ( cd "$WORK/pristine" && find . -type f ! -name '.git*' -print0 | sort -z \
      | xargs -0 shasum -a 256 > "$WORK/b.sums" )
  if ! diff -q "$WORK/a.sums" "$WORK/b.sums" >/dev/null; then
    echo "WARNING: pristine re-apply manifest differs from archived tree:" >&2
    diff "$WORK/a.sums" "$WORK/b.sums" | head -20 >&2
    die "source completeness check failed"
  fi
  echo "pristine re-apply manifest matches archived tree"
else
  step "3/6 verify skipped (--no-verify)"
fi

# --- 4. assemble the archive root --------------------------------------------
step "4/6 assemble source bundle root"
SRCO="$WORK/asm/$NAME-source"
mkdir -p "$SRCO/patches" "$SRCO/licences"
mv "$WORK/src" "$SRCO/scummvm"
cp -p "$CUM" "$SRCO/patches/"
cp -p "$MAN" "$SRCO/patches/"
mkdir -p "$SRCO/proofs"
if [[ "$VERIFY" == 1 ]]; then
  cp -p "$WORK/a.sums" "$SRCO/proofs/native-source.sha256"
  cp -p "$WORK/b.sums" "$SRCO/proofs/pristine-reapply.sha256"
  printf 'Upstream base: %s\nApplied source tree: %s\nPristine cumulative patch reapply: PASS, every source file hash matches\n' "$PIN" "$TREE" > "$SRCO/proofs/native-source-proof.txt"
fi
[[ -z "$DISPLAY_PATCH" ]] || cp -p "$DISPLAY_PATCH" "$SRCO/patches/DISPLAY1.patch"
[[ -z "$RELEASE_NOTES" ]] || cp -p "$RELEASE_NOTES" "$SRCO/RELEASE-NOTES.md"
if [[ -n "$RELEASE_EVIDENCE" ]]; then
  rsync -a "$RELEASE_EVIDENCE/" "$SRCO/proofs/"
fi

# extra (out-of-tree) patch, e.g. the SDL3 Emscripten port patch
if [[ -n "$EXTRA_PATCH" ]]; then
  [[ -f "$EXTRA_PATCH" ]] || die "extra patch not found: $EXTRA_PATCH"
  cp -p "$EXTRA_PATCH" "$SRCO/patches/extra-$(basename "$EXTRA_PATCH")"
  echo "added extra patch $(basename "$EXTRA_PATCH")"
fi

# extra files handed in via a file list (host drops L2 JS additions here).
if [[ -n "$FILELIST" ]]; then
  [[ -f "$FILELIST" ]] || die "filelist not found: $FILELIST"
  n=0
  while IFS= read -r rel; do
    [[ -z "$rel" || "$rel" == \#* ]] && continue
    src="$ENGINE/$rel"
    [[ -f "$src" ]] || die "filelist entry missing in engine: $rel"
    mkdir -p "$SRCO/scummvm/$(dirname "$rel")"
    cp -p "$src" "$SRCO/scummvm/$rel"
    n=$((n + 1))
  done < "$FILELIST"
  echo "overlaid $n filelist entries"
fi

# patched SDL 3.2.4 source (source only; skip VCS + build dirs)
if [[ -n "$SDL_SRC" && -d "$SDL_SRC" ]]; then
  mkdir -p "$SRCO/sdl3"
  rsync -a --exclude '.git' --exclude 'build*' --exclude '*.o' --exclude '*.a' \
    "$SDL_SRC"/ "$SRCO/sdl3/"
  echo "staged patched SDL source: $(find "$SRCO/sdl3" -type f | wc -l | tr -d ' ') files"
fi

# FluidLite source (dir or .tar.gz)
if [[ -n "$FLUIDLITE_SRC" && -e "$FLUIDLITE_SRC" ]]; then
  mkdir -p "$SRCO/deps/fluidlite"
  FL_EXCL=(--exclude '.git' --exclude 'build*/' --exclude 'CMakeFiles/' \
    --exclude 'CMakeCache.txt' --exclude '*.o' --exclude '*.a' \
    --exclude '*.so' --exclude '*.dylib' --exclude '__pycache__/' --exclude '*.pyc')
  if [[ -d "$FLUIDLITE_SRC" ]]; then
    rsync -a "${FL_EXCL[@]}" "$FLUIDLITE_SRC"/ "$SRCO/deps/fluidlite/"
  else
    tar -xf "$FLUIDLITE_SRC" -C "$WORK"
    inner="$(find "$WORK" -maxdepth 1 -type d -name 'FluidLite*' | head -1)"
    [[ -n "$inner" ]] || die "cannot find FluidLite source in $FLUIDLITE_SRC"
    rsync -a "${FL_EXCL[@]}" "$inner"/ "$SRCO/deps/fluidlite/"
  fi
  cat > "$SRCO/deps/fluidlite/NOTICE-nonruntime.md" <<'NOTE'
# Non-runtime note (truthful)

This directory preserves the ORIGINAL FluidLite source (commit
b0f187b404e393ee0a495b277154d55d7d03cbeb), including its `example/sf_/`
sample SoundFonts. Those sample files are part of the upstream source tree and
are NOT shipped in the runtime release. Only the FluidLite library is linked
into the engine binary. The runtime SoundFonts are separate, user-served files
(GeneralUser-GS.sf2, TimGM6mb.sf2) with their own licences.
NOTE
fi

# licences
if [[ -d "$LICENCE_SRC" ]]; then
  for f in generaluser-license.txt copyright FluidLite-LICENSE GPL-2.0.txt LGPL-2.1.txt; do
    [[ -f "$LICENCE_SRC/$f" ]] && cp -p "$LICENCE_SRC/$f" "$SRCO/licences/$f"
  done
fi
if [[ -d "$ROOT/docs/release/licence" ]]; then
  cp -p "$ROOT/docs/release/licence"/*.md "$SRCO/licences/" 2>/dev/null || true
  for f in "$ROOT"/docs/release/licence/*.txt; do
    [[ -f "$f" ]] && cp -p "$f" "$SRCO/licences/$(basename "$f")"
  done
fi
[[ -f "$SRCO/sdl3/LICENSE.txt" ]] && cp -p "$SRCO/sdl3/LICENSE.txt" "$SRCO/licences/SDL3-LICENSE.txt"
[[ -f "$SRCO/deps/fluidlite/LICENSE" ]] && cp -p "$SRCO/deps/fluidlite/LICENSE" "$SRCO/licences/FluidLite-LICENSE.txt"

# Host integration: preserve the model-authored browser sources and exact
# staging transform alongside the engine sources. Private game data stays out.
for rel in web tools/release; do
  if [[ -d "$ROOT/$rel" ]]; then
    mkdir -p "$SRCO/$rel"
    rsync -a --exclude node_modules --exclude host-tests --exclude '__pycache__/' \
      --exclude '*.pyc' --exclude '.DS_Store' "$ROOT/$rel/" "$SRCO/$rel/"
  fi
done
[[ -d "$ROOT/dist/pages/site/shell" ]] || die "shipped Pages shell is required"
mkdir -p "$SRCO/shell" "$SRCO/pages-site/docs/release" "$SRCO/pages-site/.github/workflows"
rsync -a --exclude node_modules --exclude '__pycache__/' --exclude '*.pyc' --exclude '.DS_Store' \
  "$ROOT/dist/pages/site/shell/" "$SRCO/shell/"
rsync -a "$ROOT/dist/pages/site/docs/release/" "$SRCO/pages-site/docs/release/"
for rel in index.html NOTICE.md SOURCE-NOTES.md; do
  [[ ! -f "$ROOT/dist/pages/site/$rel" ]] || cp -p "$ROOT/dist/pages/site/$rel" "$SRCO/pages-site/$rel"
done
[[ ! -f "$ROOT/.scratch/deploy/ultima8-hd/.github/workflows/pages.yml" ]] || \
  cp -p "$ROOT/.scratch/deploy/ultima8-hd/.github/workflows/pages.yml" "$SRCO/pages-site/.github/workflows/pages.yml"
cp -p "$ROOT/SOURCE-EXCEPTIONS.txt" "$SRCO/SOURCE-EXCEPTIONS.txt"
cp -p "$ROOT/SOURCE-NOTES.md" "$SRCO/SOURCE-NOTES.md"
if find "$SRCO" \( -name '__pycache__' -o -name '*.pyc' -o -name '*.o' -o -name '*.a' \
   -o -name 'CMakeCache.txt' -o -name 'CMakeFiles' -o -name '.DS_Store' \) -print | grep -q .; then
  echo "source hygiene FAIL"; exit 1; fi
mkdir -p "$SRCO/build-support"
[[ -f "$SDL_SRC/../.emscripten_url" ]] && cp -p "$SDL_SRC/../.emscripten_url" "$SRCO/build-support/sdl3.emscripten_url"
NPROC_SRC="$MAIN/.scratch/worktrees/T2-wasm-build-spike/tools/feasibility/bin/nproc"
[[ -f "$NPROC_SRC" ]] && cp -p "$NPROC_SRC" "$SRCO/build-support/nproc"

# --- 5. recipes + offer -------------------------------------------------------
step "5/6 write BUILD.md / SOURCE-OFFER.md"
cat > "$SRCO/BUILD.md" <<EOF
# Rebuild recipe (manual, offline, no download wrapper)

Pin (ScummVM upstream): \`$PIN\`
Emscripten SDK: 4.0.10 (wasm32-unknown-emscripten)
SDL: 3.2.4 (patched -- see \`patches/extra-*.patch\`)
FluidLite: b0f187b404e393ee0a495b277154d55d7d03cbeb
Observed shipped wasm sha256: ${ENGINE_SHA256:-<not supplied for this archive>}

We do NOT claim a byte-identical rebuild. This is the exact recipe used; the
hash above is for comparison only, and was supplied by the host, not computed
from this archive.

## 1. Toolchain
Install the pinned Emscripten SDK 4.0.10 and activate it:

    ./emsdk install 4.0.10
    ./emsdk activate 4.0.10
    source emsdk_env.sh

Run the remaining commands from the extracted archive root:

    ARCHIVE_ROOT="\$PWD"
    FLUID_PREFIX="\$ARCHIVE_ROOT/scummvm/dists/emscripten/libs/build"
    export PATH="\$ARCHIVE_ROOT/build-support:\$PATH"

## 2. Patched SDL 3.2.4
The supplied \`sdl3/\` is ALREADY patched; do not apply the patch again.
The recorded build used the existing port cache and \`embuilder build sdl3 --force\`.
To use the supplied source with the pinned SDK, preserve its URL marker so the
port fetcher keeps the patched source instead of re-extracting an upstream copy:

    SDL_PORT="\$EMSDK/upstream/emscripten/cache/ports/sdl3"
    mkdir -p "\$SDL_PORT/SDL-release-3.2.4"
    cp -R "\$ARCHIVE_ROOT/sdl3/." "\$SDL_PORT/SDL-release-3.2.4/"
    cp "\$ARCHIVE_ROOT/build-support/sdl3.emscripten_url" "\$SDL_PORT/.emscripten_url"
    embuilder build sdl3 --force

Use a separate SDK/cache when preserving another project's port build matters.
The patch makes an empty keyboard target a no-op and accepts \`#none\`.

## 3. FluidLite static lib
Configure \`deps/fluidlite\` with CMake for \`wasm32-unknown-emscripten\` and
install to a prefix, e.g. \`dists/emscripten/libs/build\`:

    emcmake cmake -S "\$ARCHIVE_ROOT/deps/fluidlite" -B "\$ARCHIVE_ROOT/build-fluidlite" \\
      -DFLUIDLITE_BUILD_STATIC:BOOL=1 -DFLUIDLITE_BUILD_SHARED:BOOL=0 \\
      -DCMAKE_INSTALL_PREFIX="\$FLUID_PREFIX" -DCMAKE_INSTALL_LIBDIR=lib \\
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5
    cmake --build "\$ARCHIVE_ROOT/build-fluidlite"
    cmake --install "\$ARCHIVE_ROOT/build-fluidlite"

## 4. Configure ScummVM (exact flags used)
    cd "\$ARCHIVE_ROOT/scummvm"
    emconfigure ./configure \\
      --host=wasm32-unknown-emscripten --build=wasm32-unknown-emscripten \\
      --disable-all-engines --enable-engine=ultima8 --enable-fluidlite \\
      --with-fluidlite-prefix="\$FLUID_PREFIX"

## 5. Release strip (EXACT -- do not skip)
The engine has a QA fixture gated on \`ENABLE_U8_QA_FIXTURE\`. The release build
MUST pass the flag as 0/unset AND delete the guarded objects first, because
\`make\` does not track \`CXXFLAGS\`:

    # delete the SIX guarded objects BEFORE make:
    rm -f engines/ultima/ultima8/ultima8_bridge.o \\
          engines/ultima/ultima8/misc/debugger.o \\
          engines/ultima/ultima8/world/actors/modern_combat.o \\
          engines/ultima/ultima8/world/actors/actor.o \\
          engines/ultima/ultima8/world/actors/animation_tracker.o \\
          engines/ultima/ultima8/world/actors/combat_process.o
    emmake make -j12 ENABLE_U8_QA_FIXTURE=0
    emmake make dist-emscripten ENABLE_U8_QA_FIXTURE=0 DIST_FILES_SOUNDFONTS=
    # upstream dist re-adds Roland_SC-55.sf2; ensure it is absent:
    [ -e build-emscripten/data/Roland_SC-55.sf2 ] && rm -f build-emscripten/data/Roland_SC-55.sf2

There is no \`dists/emscripten/build.sh\` wrapper in the shipped route, and no
\`emstrip\` shim; the only extra PATH entry was a 167-byte \`nproc\` shim.

The exact shipped browser shell is in \`shell/\`; Pages publication sources are
in \`pages-site/\`, and the other browser/backend sources are in \`web/\`.
The exact staged-only QA
transform is \`tools/release/strip_qa_globals.py\`. The staging script keeps
private game files separate and takes their path explicitly. The archive
generator's commands have been checked against the original model-authored
build handoffs; an independent clean rebuild has not been claimed.

EOF

cat > "$SRCO/SOURCE-OFFER.md" <<EOF
# Complete corresponding source offer

This archive is the complete corresponding source for the shipped Ultima VIII:
Pagan browser build (ScummVM + patched SDL 3.2.4 + FluidLite + assets recipe).

- Engine: ScummVM at upstream pin \`$PIN\`, with every modification and new file
  in \`scummvm/\` (see \`patches/\`). The new bridge (\`ultima8_bridge.cpp/.h\`),
  \`modern_combat.cpp/.h\` and \`dists/emscripten/assets/ultima8-bridge.js\` are
  present as real source, not as patches.
- SDL: patched SDL 3.2.4 source in \`sdl3/\`; the patch is also in \`patches/\`.
- FluidLite: source in \`deps/fluidlite/\` (see its NOTICE-nonruntime.md).
- Licences: \`licences/\`.
- Rebuild: \`BUILD.md\`.

What is DELIBERATELY NOT here: git history, the Emscripten SDK binary/cache, any
build products (\`.o\`, \`scummvm.wasm\`, \`scummvm.js\`, \`*.map\`), and the user's
private game data. Original game data is not included in this source archive;
see \`licences/NOTICE.md\`.
EOF

# --- 6. manifest + pack -------------------------------------------------------
step "6/6 manifest + deterministic pack"
python3 "$HERE/pack_tar.py" --root "$SRCO" \
  --prefix "$NAME-source" \
  --out "$OUTABS/$NAME.tar.gz" \
  --sha256sums "$OUTABS/$NAME.filelist.sha256"

# a human-readable manifest inside the tree (path<TAB>size<TAB>sha256)
( cd "$SRCO" && find . -type f ! -name 'SOURCE-MANIFEST.txt' -print0 \
    | sort -z | xargs -0 shasum -a 256 ) > "$WORK/fl.sums"
printf '# path\tsha256\n' > "$SRCO/SOURCE-MANIFEST.txt"
cat "$WORK/fl.sums" >> "$SRCO/SOURCE-MANIFEST.txt"
# repack once so the manifest travels inside the archive
python3 "$HERE/pack_tar.py" --root "$SRCO" \
  --prefix "$NAME-source" \
  --out "$OUTABS/$NAME.tar.gz" \
  --sha256sums "$OUTABS/$NAME.filelist.sha256" >/dev/null

# --- checksums over every emitted audit artifact -----------------------------
( cd "$OUTABS" && for f in "$LABEL"*; do
    [[ "$(basename "$f")" == "SHA256SUMS" ]] && continue
    shasum -a 256 "$f"
  done ) > "$OUTABS/SHA256SUMS"

step "done"
cat <<EOF
Archive:  $OUTABS/$NAME.tar.gz
Filelist: $OUTABS/$NAME.filelist.sha256
Audit:    $CUM
          $MAN
          $OUTABS/SHA256SUMS

Nothing was written inside the engine tree ($ENGINE).
EOF
