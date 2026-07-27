# Frog Joust — movement prototype

Frogger meets Joust: you are a knight riding a giant toad, and you win by
knocking rival knights off their toads with your toad's tongue.

This repo is the **control-scheme test bench** — a single-file web page you can
open on a phone to find out whether hopping and tongue-jousting feel good,
before any of it gets built in Unity.

## Play it

Open `index.html`. It needs no build step and no server — a `file://` path
works, as does any static host.

The camera is tilted back over a checkerboard, one square per cell, with the
board squared up to the screen rather than stood on its corner: rows run across,
columns run up and down. Swipe up to go forward, down to come back, left and
right to go left and right.

| Input | Touch | Keyboard |
| --- | --- | --- |
| Hop | Swipe anywhere (four ways) | Arrows / WASD |
| Shoot the tongue | Press and hold | Hold Space |
| Steer the tongue | Drag while holding | Arrows while holding Space |
| Reel it in | Release | Release Space |

Sound is synthesised at runtime — no files — and starts on your first touch,
because browsers will not open an audio device before a gesture. **Sound**
toggles it and the choice sticks.

**Tune** opens sliders for every number that affects feel; they persist in
local storage, and **Defaults** puts them back. Those are the values to carry
into Unity once something feels right.

## The rules being tested

- A hop is a discrete, committed move — a whole number of cells over a fixed
  time, in one of four directions, Frogger-style rather than analogue walking.
  The frog is always exactly on a cell centre.
- **Holding** shoots the tongue; **releasing** reels it in. A quick tap still
  produces a full jab (`minExtend`).
- The frog is pinned only while the tongue is going **out**. That is the
  commitment, and it is the risk that makes the joust a joust. Letting go ends
  it: you can hop away immediately and the tongue trails from the mouth as it
  reels in behind you. Pressing again cuts the reel-in short and fires afresh.
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
  `unproj`. `ISO` is the foreshortening — a cell is `cell` wide and
  `cell * ISO` tall — and it is the only thing separating this from a plain
  top-down view. `0.5` is a true 2:1 board seen square-on; higher is a steeper
  camera. In Unity this is the camera's pitch, nothing more.
- **Hops snap the raw screen delta; steering unprojects it.** Those are
  deliberately different. A hop should go where the finger pointed on screen,
  so its boundary between directions sits at a true 45°; unprojecting first
  would bias it toward the squashed axis, and a swipe that looks 45° would hop
  forward. Steering *is* unprojected, so a dragged tongue follows the finger's
  on-screen angle — the only angle the player can see.
- The snap is **by comparison, not by rounding an angle** — the result is
  exactly `±1` and `0`, so repeated hops can never accumulate floating-point
  drift off the cell centres. Hop targets are whole cells and the clamp to the
  arena edge is a whole cell too.
- The whole arena is framed on screen. Squared up, the board is much wider than
  it is tall, so the fit has to measure both axes — sizing off the smaller
  viewport dimension alone over-zooms and clips the rivals at the edges. The
  camera still follows and stops at the board edge if you shrink the view.
- The toad shows the back of its head when it hops away from the camera, and
  whether the rider draws in front of the head depends on the facing. Get that
  backwards and the knight eats one of the toad's eyes.
- Input reinterpretation matters: a press starts the tongue immediately, but if
  the finger travels past `swipeThreshold` within `swipeGrace` ms it is
  retroactively a swipe and the tongue is cancelled. Extension eases in over
  the first 90 ms so a cancelled tongue never shows a visible stub.
- A hold that arrives mid-hop is buffered and fires on landing, so the control
  never feels like it ate an input.
- A press can only cut a retraction short *after* the swipe window has passed.
  Otherwise swiping away would blink the old tongue out of existence instead of
  letting it reel in behind you — and a swipe only ever cancels a tongue that
  the same press started.

## Sound

Five placeholder voices, synthesised from oscillators and filtered noise rather
than sampled: nothing to load, and each one is a handful of numbers you can
argue with in `sfx`. Hop and land, the tongue going out and coming back, and
the hit — a noise thump under two detuned squares for the armour ringing.

They are deliberately crude. They exist to answer "does this action want a
sound, and roughly what shape", not to be the game's audio.

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
