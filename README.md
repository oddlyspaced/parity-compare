# parity-compare

Compare two screenshots of the same screen and report **structure**, **position** and **content**
separately, instead of collapsing them into one percentage.

Zero dependencies. Node 20 or later. It reads the PNGs itself.

```sh
npx parity-compare --a shots/react-native --b shots/native --masks masks.json
```

```
  home                   PASS   bands 19/19  offset -      content 0.04%
  thread                 DRIFT  bands 10/10  offset 2px    content 0.11%
  profile                FAIL   bands 11/12  offset 1px    content 0.09%
  1 pass, 1 drift, 1 fail
```

## Why not a percentage

The usual screenshot test answers one question: what fraction of pixels differ. That number cannot
tell these three cases apart, and they need different responses:

| What happened | A percentage says | What you should do |
|---|---|---|
| A row is 2 px taller, so every row below shifts | 2.8%, fail | Fix 2 px of padding |
| A button is missing | 0.3%, pass | Stop the release |
| Text renders a shade lighter everywhere | 40%, fail | Probably nothing |

The second row is the dangerous one. A missing element is small in pixels and large in meaning, and
a threshold tuned to ignore antialiasing will wave it through.

The first is the common one. We had a screen measure 2.81% and fail its gate. The two images were
indistinguishable: one row was two pixels taller and every row below it inherited the shift, so one
small layout difference was counted roughly forty thousand times.

## What it measures instead

**Structure.** The ordered content bands of each image — the horizontal strips that carry something,
found by ignoring the background. The two lists are aligned by minimum cost, so a band that changed
height pairs with itself rather than being reported as one missing and one extra. A band with no
partner is a missing or extra element, and that is always a failure however few pixels it is.

**Position.** Where each matched band sits. A cumulative shift is reported once, with the band it
starts at, instead of being multiplied into every row below. Offsets never pass silently: a screen
with any offset is `drift`, which is a thing a person has to look at and accept.

**Content.** Whether matched bands look the same, compared after the offset is removed. A pixel only
counts as different when nothing within one pixel of it matches, so subpixel text rendering does not
drown the signal — but a glyph that is absent, a different shape, or the wrong colour finds no match
and is counted.

The raw whole-image percentage is still in the output. It is reported for contrast, never as the
verdict.

## Verdicts

- **fail** — an element is missing or extra, the images are different sizes, or a matched element's
  content differs by more than `--content-threshold` (default 2%)
- **drift** — same elements, same content, but something sits at a different offset or height
- **pass** — same elements, same places, same content

## Masks

Some regions cannot match: a clock, a relative timestamp, a licensed icon you replaced. Declare them
as fractions of the image, so one file fits any scale factor:

```json
{
  "home": [
    { "x": 0, "y": 0, "w": 1, "h": 0.07, "reason": "status bar" },
    { "x": 0.48, "y": 0.25, "w": 0.13, "h": 0.03, "reason": "relative time" }
  ]
}
```

Masked regions are excluded from band detection as well as from comparison. A clock that changes
every run must not be allowed to decide where a band begins.

## Options

| Option | Default | What it does |
|---|---|---|
| `--a`, `--b` | required | A PNG, or a directory of PNGs matched by filename |
| `--masks` | none | The mask file above |
| `--out` | none | Write the full JSON report here |
| `--json` | off | Print the JSON report instead of the table |
| `--content-threshold` | `0.02` | Band content difference that fails |
| `--colour-tolerance` | `16` | Per-channel difference, 0-255, that counts as a different colour |
| `--offset-tolerance` | `0` | Vertical offset accepted without comment |
| `--antialias-radius` | `1` | How far a matching pixel may be. `0` counts every edge |

Exit code is 0 when nothing failed, 1 when something did, 2 on a usage or input error.

## Use it as a library

```js
import { compareScreens } from "parity-compare";
import { readPng } from "parity-compare/png";

const result = compareScreens(readPng("a.png"), readPng("b.png"), { masks });
if (result.structure.missingInNative.length) throw new Error("an element is missing");
```

## Why it has no dependencies

The comparator this replaces shelled out to ImageMagick and read its differing-pixel count from
`compare -metric AE`. In ImageMagick 7.1.2-32 that number quietly stopped being a count of pixels
and became a sum of normalised per-channel magnitudes. Measured on a 40x40 red rectangle over white,
which is 1600 differing pixels:

| Rectangle | Channels that differ | `AE` reports |
|---|---|---|
| `red`, `lime` or `blue` | 2 of 4 RGBA | 800 |
| `black` | 3 of 4 | 1200 |
| `rgb(254,254,254)` | 3 of 4, by 1/255 each | 4.71 |

The last row is the proof: a 1/255 difference still differs on 1600 pixels. Every threshold set
against that number moved when the tool was upgraded, and nothing announced it. A measurement you do
not control is not a measurement you can rely on, so this one reads the pixels itself: PNG decoding
is `zlib` plus the five scanline filters, and all five are tested.

## Tests

```sh
npm test
```

The tests build their own PNGs rather than shipping fixtures, and the decoder is checked against
every scanline filter. Two of them exist because they caught real bugs: a row whose content covers
more than half its width used to invert the background detection, and two identical images used to
report a one-pixel offset because a solid block matches itself at several offsets and the first one
tried won.

## Licence

MIT.
