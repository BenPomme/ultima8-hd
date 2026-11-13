# SoundFont provenance and bundling rule

**Rule:** SoundFonts stay as separate `.sf2` data files. They are never inlined
into JavaScript or WASM, and they live under `fonts/` in the release root.
The user can swap them; the engine reads the SoundFont path from the ScummVM
config (`soundfont`), so adding or replacing a file does not change the build.

| font | licence | sha256 |
|---|---|---|
| `GeneralUser-GS.sf2` | GeneralUser GS License v2.0 (author grant; contained-sample caveat retained) | `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe` |
| `TimGM6mb.sf2` | GPL-2-only | `c5378b62028c920cb11e4803327983fee2f2cdff5dc89c708e39da417e51c854` |

Only these two fonts are approved for bundling. `FluidLite-Boomwhacker.sf2`
(shipped inside the FluidLite source tree, LGPL-2.1-or-later) is deliberately
**not** staged: `tools/release/stage_release.sh` copies only `GeneralUser-GS.sf2`
and `TimGM6mb.sf2`.

## GeneralUser GS sample-provenance caveat (verbatim, from the author)

> Many of the samples are original, but some were taken from other banks freely
> (and legally) available on the Internet from various SoundFont websites. Because
> GeneralUser GS originated as a personal project with no intention for
> publication, I cannot be 100% sure where all of the samples originated, although
> I do know that none of them came from commercially published SoundFont packages
> or sample CDs. Regardless, many "free" SoundFonts available on the web may
> indeed contain samples of questionable origin. My understanding of the
> copyrights of all samples is only as good as the information provided by the
> original sources. If you become aware of any restricted samples being used in
> GeneralUser GS, please let me know so I can replace them.

The complete verbatim licence is `GeneralUser-GS-LICENSE.txt`; the caveat above
is reproduced so a redistributor sees it without opening the file.

## TimGM6mb attribution (verbatim, from the Debian copyright)

> Copyright: 2004 Tim Brechbill <https://www.timbrechbill.com>
>   2010 David Bolton <davidkbolton@gmail.com>
> License: GPL-2

Source pointer: Debian `timgm6mb-soundfont` (`.dsc` / `.orig.tar.gz` recorded in
the host's `.scratch/licenses/soundfonts/`), upstream
`github.com/musescore/musescore-old@90c33ef9d87b3f5ff92efd3b07d89eb455fb1fef`.

## Not included

The stack's own Roland SC-55 font is deliberately absent: its provenance is
verified as unverified/conflicting (embedded RIFF says Roland, sidecar claims a
different licence). Do not bundle it.

## Music modes: original FM vs real General-MIDI SoundFonts

The music score is the **original** Ultima VIII Adlib/FM soundtrack, replayed by
the engine -- it is **not** newly composed. Two playback paths exist:

- **Original FM (Adlib/MIDI, default):** the engine's built-in FM synthesis, no
  external font needed. This is the usable default.
- **Enhanced GM (optional):** the same original tracks rendered through a real
  General-MIDI SoundFont (GeneralUser-GS on desktop, TimGM6mb on mobile), loaded
  lazily from `/fonts/*.sf2` and applied on an explicit page restart. If the font
  is not loaded/staged, the engine keeps the FM path; there is no silent
  auto-switch and no network fetch.

No new music was composed for this port and no MIDI/MT-32 ROM is distributed.
