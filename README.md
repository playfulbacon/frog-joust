# Frog Joust — movement prototype

Frogger meets Joust: you are a knight riding a giant toad, and you win by
knocking rival knights off their toads with your toad's tongue.

This repo is the **control-scheme test bench** — a single-file web page you can
open on a phone to find out whether hopping and tongue-jousting feel good,
before any of it gets built in Unity.

## Play it

Open `index.html`. It needs no build step and no server — a `file://` path
works, as does any static host.

The view is straight top-down on a checkerboard, one square per cell.

| Input | Touch | Keyboard |
| --- | --- | --- |
| Hop | Swipe anywhere (four ways) | Arrows / WASD |
| Shoot the tongue | Press and hold | Hold Space |
| Steer the tongue | Drag while holding | Arrows while holding Space |
| Reel it in | Release | Release Space |

**Tune** opens sliders for every number that affects feel; they persist in
local storage, and **Defaults** puts them back. Those are the values to carry
into Unity once something feels right.

## The rules being tested

- A hop is a discrete, committed move — a whole number of cells over a fixed
  time, in one of four directions, Frogger-style rather than analogue walking.
  The frog is always exactly on a cell centre.
- **Holding** shoots the tongue; **releasing** reels it in. A quick tap still
  produces a full jab (`minExtend`).
- The frog cannot move for the *whole* tongue cycle — extending and retracting
  both. Committing to a shot is the risk that makes the joust a joust.
- While the tongue is out, the direction input steers **the tongue** instead.
- The tongue is live along its outer length, not just at the tip, so sweeping
  it across a rival on the way home counts.

## How the tongue works

Worth knowing before porting, because the obvious implementation does not work.
A rope of segments solved anchor-outward folds back on itself the moment the
segment length grows faster than the tip travels — the parent overshoots past
its child and the direction flips, so the tongue balls up at the mouth.

Instead:

1. **The tip is the simulation.** It travels at `extendSpeed` along a heading.
   Steering *rotates* that heading at `steerRate` rad/s rather than shoving the
   tip sideways — that is what makes the arc feel driven, and a rotation can
   never blow up.
2. **`len` is a leash.** It is the distance paid out, and the tip is clamped
   inside it. Shrinking `len` on release physically drags the tip home, while
   the tip keeps travelling at `sweepSpeed` so you can still sweep on the way
   back.
3. **The shape is a cubic curve** from mouth to tip: it leaves along the toad's
   facing and arrives along the tip's heading. The outgoing tangent is capped
   so the whole curve stays inside the leash — otherwise a bowed tongue quietly
   out-reaches its own maximum. That curve is the hit volume and the render
   path both, so what you see is exactly what hits.

In Unity this is a tip transform plus a LineRenderer fed by the same sampled
curve. Nothing here needs a third axis: all gameplay is on the ground plane and
`z` is cosmetic — under a straight-down camera it is read as sprite scale plus a
shrinking shadow rather than as a screen offset, which is what a hop actually
looks like from above.

## Porting notes

- All gameplay units are **cells and seconds**. Pixels appear only in `proj` /
  `unproj`, which top-down is just a multiply by `cell`.
- Swipes snap to the four cardinals **by comparison, not by rounding an angle**
  — the result is exactly `±1` and `0`, so repeated hops can never accumulate
  floating-point drift off the cell centres. Hop targets are whole cells and the
  clamp to the arena edge is a whole cell too.
- Sprites are authored facing east and rotated into place, so four facings need
  one drawing. `SPRITE` sets how much of a cell a mount fills.
- Input reinterpretation matters: a press starts the tongue immediately, but if
  the finger travels past `swipeThreshold` within `swipeGrace` ms it is
  retroactively a swipe and the tongue is cancelled. Extension eases in over
  the first 90 ms so a cancelled tongue never shows a visible stub.
- A hold that arrives mid-hop is buffered and fires on landing, so the control
  never feels like it ate an input.

## Tests

```
node test/headless.js
```

Runs the simulation with no browser: it pulls the script out of `index.html`,
steps it at a fixed timestep, and checks that swipes resolve to exactly four
unit cardinals, that a lap around the board leaves the frog with zero drift off
the cell centres, that it stops at the arena edge, that movement stays locked
for the whole tongue cycle, that no part of the curve out-reaches `tongueMax`,
that an unsteered tongue is straight and a steered one actually bows, and that a
hit unhorses exactly one rider.
