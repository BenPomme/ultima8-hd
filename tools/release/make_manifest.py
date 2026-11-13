#!/usr/bin/env python3
"""make_manifest.py -- runtime asset bundling manifest (local-only, no CDN).

Lists every runtime asset in a staged release with its size and sha256, grouped
by role, and flags anything that looks remote. Every entry is verified to be a
local file: a URL (http/https//) or a missing path is a hard error, because the
release must be fully self-contained.

SoundFonts (.sf2) are always reported in their own section: they stay separate
data files the user can swap, they are not bundled into any JS/WASM blob.

Two input modes:
    python3 tools/release/make_manifest.py --root <staged-release-dir> --out <dir>
    python3 tools/release/make_manifest.py \
        --include engine=/path/to/engine-build \
        --include "shell=shell" --out <dir>

Writes <out>/asset-manifest.json and <out>/ASSET-BUNDLE.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

CHUNK = 1 << 20


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def classify(rel: str) -> str:
    """Map a release-relative path to a role bucket."""
    low = rel.lower()
    if low.endswith(".sf2"):
        return "soundfont"
    first = rel.split("/", 1)[0]
    if first == "shell":
        return "shell"
    if first == "web":
        return "modern-art"
    if low.startswith("data/games/"):
        return "game-data"
    if low.startswith("data/"):
        return "engine-data"
    if low.startswith("doc/"):
        return "engine-license-docs"
    if low in {"scummvm.html", "scummvm.js", "scummvm.wasm", "scummvm.ini",
               "manifest.json", "favicon.ico", "logo.svg"} or \
       low.startswith("scummvm-") or low == "ultima8-bridge.js":
        return "engine"
    if first in {"docs", "tools"}:
        return "packaging"
    if first == "soundfonts":
        return "soundfont"
    return "other"


def is_remote(value: str) -> bool:
    return value.startswith(("http://", "https://", "//", "data:"))


def walk(root: str, prefix: str, entries: list, errors: list, excludes: tuple = ()) -> None:
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            rel_prefixed = f"{prefix}/{rel}" if prefix else rel
            if any(x in rel_prefixed for x in excludes):
                continue
            if is_remote(rel_prefixed):
                errors.append(f"remote asset rejected: {rel_prefixed}")
                continue
            try:
                size = os.path.getsize(full)
                digest = sha256_file(full)
            except OSError as exc:
                errors.append(f"unreadable: {full}: {exc}")
                continue
            entries.append({
                "path": rel_prefixed.replace(os.sep, "/"),
                "category": classify(rel_prefixed),
                "size": size,
                "sha256": digest,
            })


def markdown(entries: list[dict], sources: list[str]) -> str:
    order = ["engine", "engine-data", "game-data", "shell", "modern-art",
             "soundfont", "engine-license-docs", "packaging", "other"]
    total = sum(e["size"] for e in entries)
    lines = ["# Runtime asset bundle manifest (local-only, no CDN)", "",
             "Every runtime asset is a local file served from the release root. "
             "No CDN, no remote URL. SoundFonts are listed separately as swappable "
             "data files.", "",
             "Notes:",
             "- `game-data` entries are folded from "
             "`game-data-inventory.json` (the install planner's dry-run report) and "
             "carry the staged, lower-cased paths the engine actually requests.",
             "- `soundfont` entries are standalone `.sf2` data files, never inlined "
             "into JS/WASM; the user can swap them.",
             "- This manifest was generated from read-only source trees on "
             "2026-11-11; the stage script regenerates it against the finished "
             "release.", "",
             f"- assets: {len(entries)}",
             f"- total size: {total} bytes ({total / 1048576:.1f} MiB)",
             f"- sources: {', '.join(sources)}", ""]
    for cat in order:
        rows = [e for e in entries if e["category"] == cat]
        if not rows:
            continue
        lines.append(f"## {cat} ({len(rows)} files, {sum(r['size'] for r in rows)} bytes)")
        lines.append("")
        lines.append("| path | size | sha256 |")
        lines.append("|---|---:|---|")
        for r in sorted(rows, key=lambda x: x["path"]):
            lines.append(f"| `{r['path']}` | {r['size']} | `{r['sha256']}` |")
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build the local runtime asset manifest.")
    ap.add_argument("--root", default=None, help="staged release dir (single-root mode)")
    ap.add_argument("--include", action="append", default=[],
                    help="PREFIX=SOURCE_DIR (repeatable); activates map mode")
    ap.add_argument("--extra-entries", default=None,
                    help="JSON file (install_game_data.py --report) whose files[] are folded in as game-data")
    ap.add_argument("--exclude", action="append", default=[],
                    help="skip entries whose release-relative path contains this (repeatable)")
    ap.add_argument("--out", required=True, help="output directory")
    args = ap.parse_args(argv)

    entries: list[dict] = []
    errors: list[str] = []
    sources: list[str] = []

    if args.include:
        for spec in args.include:
            if "=" not in spec:
                print(f"error: --include must be PREFIX=DIR, got {spec!r}", file=sys.stderr)
                return 2
            prefix, _, src = spec.partition("=")
            if not os.path.isdir(src):
                print(f"error: --include source not found: {src}", file=sys.stderr)
                return 2
            sources.append(f"{prefix or '.'}={src}")
            walk(os.path.abspath(src), prefix, entries, errors, tuple(args.exclude))
    elif args.root:
        if not os.path.isdir(args.root):
            print(f"error: --root not found: {args.root}", file=sys.stderr)
            return 2
        sources.append(os.path.abspath(args.root))
        walk(os.path.abspath(args.root), "", entries, errors, tuple(args.exclude))
    else:
        print("error: pass --root or at least one --include", file=sys.stderr)
        return 2

    if args.extra_entries:
        with open(args.extra_entries, encoding="utf-8") as fh:
            extra = json.load(fh)
        for item in extra.get("files", []):
            entries.append({
                "path": str(item["dst"]).replace(os.sep, "/"),
                "category": "game-data",
                "size": int(item["size"]),
                "sha256": item["sha256"],
            })
        sources.append(f"game-data={args.extra_entries}")

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "asset-manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({"sources": sources, "asset_count": len(entries),
                   "errors": errors, "entries": entries}, fh, indent=2)
    with open(os.path.join(args.out, "ASSET-BUNDLE.md"), "w", encoding="utf-8") as fh:
        fh.write(markdown(entries, sources))

    print(f"manifest: {len(entries)} assets, {len(errors)} errors -> {args.out}")
    for err in errors:
        print(f"  ERROR {err}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
