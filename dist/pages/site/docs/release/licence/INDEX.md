# Licence pack index

Every licence, attribution and source record for the staged release.

| item | file | notes |
|---|---|---|
| Third-party notices (read first) | `NOTICE.md` | game data not distributed, all components |
| ScummVM GPL source offer + rebuild route | `scummvm-source-offer.md` | pinned `929be885...`, full corresponding source archive |
| Engine patches | `../../../tools/release/licence/patches/README.md` | cumulative vs per-commit rule |
| SDL 3.2.4 | `NOTICE.md` | zlib licence; SDL3 port patch included |
| FluidLite short licence | `FluidLite-LICENSE.txt` | LGPL-2.1-or-later |
| FluidLite full LGPL text (verbatim) | `LGPL-2.1.txt` | resolved; provenance in `LGPL-2.1-PROVENANCE.md` |
| FluidLite LGPL provenance | `LGPL-2.1-PROVENANCE.md` | host-supplied SPDX mirror, sha256 recorded |
| GeneralUser GS licence v2 (verbatim) | `GeneralUser-GS-LICENSE.txt` | includes sample-provenance caveat |
| TimGM6mb copyright (verbatim) | `timgm6mb-copyright.txt` | GPL-2-only, Brechbill/Bolton |
| SoundFont provenance | `soundfonts.md` | separate data files under `/fonts`, hashes, FM-vs-GM note |
| GPL-2 full text | `GPL-2.0.txt` | for TimGM6mb (GPL-2-only) |
| A1 key art | `A1-art.md` | AI-generated, clearly labelled |

All `.txt` files in this folder are byte-for-byte copies of the official
records; do not reformat them.

## Full corresponding source archive

The complete corresponding source (modified ScummVM tree + patched SDL 3.2.4 +
FluidLite + this licence pack + `BUILD.md`) is produced by
`tools/release/make_source_archive.sh` as a single
`ultima-pagan-modern-corresponding-source-*.tar.gz`. It is a real source tree
(not a tar of patches) and contains no `.git`, no SDK/caches, no build products
and no game data. See `scummvm-source-offer.md`.
