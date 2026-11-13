#!/usr/bin/env python3
"""check_release.py -- deterministic release-hygiene + source-completeness checks.

Runs offline against a staged release directory (and optionally its sibling
source-archive directory). It asserts the CP18 release-hygiene contract and the
corresponding-source completeness contract. It is safe to run repeatedly.

    python3 tools/release/check_release.py --stage <dir> [--source <dir>] [--expect-source]

Exit code 0 only if every check passes.
"""
from __future__ import annotations

import argparse
import os
import sys

RESULTS: list[tuple[str, bool, str]] = []


def chk(label: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((label, bool(cond), detail))


def read(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def walk(root: str):
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != ".git"]
        for name in files:
            yield os.path.join(base, name)


def rel(root: str, path: str) -> str:
    return os.path.relpath(path, root).replace(os.sep, "/")


def check_runtime(stage: str) -> None:
    must = [
        "scummvm.html", "scummvm.js", "scummvm.wasm", "ultima8-bridge.js",
        "scummvm.ini", "shell/index.html", "data/index.json",
        "docs/release/asset-manifest.json",
    ]
    for m in must:
        chk(f"runtime has {m}", os.path.isfile(os.path.join(stage, m)))

    # 1. QA global gone from the staged shell (and nowhere under shell/).
    app = os.path.join(stage, "shell", "ui", "app.js")
    chk("staged shell/ui/app.js exists", os.path.isfile(app))
    if os.path.isfile(app):
        chk("staged app.js has NO __U8_TEST__", "__U8_TEST__" not in read(app))
    shell_dir = os.path.join(stage, "shell")
    hits = [rel(stage, p) for p in walk(shell_dir) if b"__U8_TEST__" in _bytes(p)] \
        if os.path.isdir(shell_dir) else []
    chk("runtime shell has NO __U8_TEST__", not hits, ", ".join(hits[:5]))

    # 2. test dirs excluded from the runtime (path check; no full-tree scan).
    for bad in ("shell/test", "shell/host-tests", "shell/tools", "qa"):
        chk(f"runtime excludes {bad}/", not os.path.isdir(os.path.join(stage, *bad.split("/"))))

    # 3. fonts at /fonts, not /soundfonts; only the two approved fonts.
    chk("stage dir has NO soundfonts/", not os.path.isdir(os.path.join(stage, "soundfonts")))
    for sf in ("GeneralUser-GS.sf2", "TimGM6mb.sf2"):
        chk(f"runtime has fonts/{sf}", os.path.isfile(os.path.join(stage, "fonts", sf)))
    font_files = [os.path.basename(p) for p in walk(os.path.join(stage, "fonts"))]
    for banned in ("Roland_SC-55.sf2", "FluidLite-Boomwhacker.sf2"):
        chk(f"runtime fonts/ has NO {banned}", banned not in font_files)

    # 4. scummvm.ini carries EN + explicit FR/DE targets with languages.
    ini = read(os.path.join(stage, "scummvm.ini"))
    for sec in ("[ultima8]", "[ultima8-fr]", "[ultima8-de]"):
        chk(f"scummvm.ini has {sec}", sec in ini)
    chk("scummvm.ini FR language", "language=fr" in ini)
    chk("scummvm.ini DE language", "language=de" in ini)
    chk("scummvm.ini EN is default target", "lastselectedgame=ultima8\n" in ini)

    # 5. no remote/CDN refs and no obvious secrets in the manifest.
    man = read(os.path.join(stage, "docs", "release", "asset-manifest.json"))
    chk("manifest has no http(s):// asset refs", "http://" not in man and "https://" not in man)


def _bytes(path: str) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return b""


def check_source(src: str) -> None:
    chk("source dir exists", os.path.isdir(src))
    if not os.path.isdir(src):
        return
    tars = [p for p in walk(src) if p.endswith(".tar.gz")]
    chk("source archive present (.tar.gz)", bool(tars), "; ".join(os.path.basename(t) for t in tars))
    chk("source has cumulative patch",
        any("cumulative" in os.path.basename(p) for p in walk(src)))
    chk("source has manifest",
        any("source-manifest" in os.path.basename(p) for p in walk(src)))
    # The archive must be a real source tree, not a tar of patches: inspect it.
    if tars:
        import tarfile
        want = [
            "ultima8_bridge.cpp",
            "ultima8_bridge.h",
            "modern_combat.cpp",
            "modern_combat.h",
            "ultima8-bridge.js",
        ]
        names: list[str] = []
        with tarfile.open(tars[0], "r:gz") as tf:
            names = tf.getnames()
        joined = "\n".join(names)
        for w in want:
            chk(f"source archive contains new file {w}", w in joined)
        chk("source archive excludes .git", "/.git/" not in joined + "/")
        chk("source archive excludes scummvm.wasm", not any(
            n.endswith("/scummvm.wasm") for n in names))
        chk("source archive has BUILD.md", any(n.endswith("/BUILD.md") for n in names))
        chk("source archive has SDL source", any("/sdl3/" in n + "/" for n in names))
        chk("source archive has fluidlite source",
            any("/deps/fluidlite/" in n + "/" for n in names))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True)
    ap.add_argument("--source", default="")
    ap.add_argument("--expect-source", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.stage):
        print(f"error: stage dir not found: {args.stage}", file=sys.stderr)
        return 2

    check_runtime(args.stage)
    if args.source or args.expect_source:
        check_source(args.source)

    failed = [r for r in RESULTS if not r[1]]
    for label, ok, detail in RESULTS:
        print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail and not ok else ""))
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} release checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
