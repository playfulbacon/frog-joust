# Frog Joust — movement prototype

Frogger meets Joust: you are a knight riding a giant toad, and you win by
knocking rival knights off their toads with your toad's tongue.

This repo is the **control-scheme test bench** — a single-file web page you can
open on a phone to find out whether hopping and tongue-jousting feel good,
before any of it gets built in Unity.

## Play it

Open `index.html`. It needs no build step and no server — a `file://` path
works, as does any static host. Pick a level from the menu.

The camera is tilted back over a checkerboard, one square per cell, with the
board squared up to the screen rather than stood on its corner: rows run across,
columns run up and down. Swipe up to go forward, down to come back, left and
right to go left and right. The edges are walls by default; **Wrap at edges**
in the tuning drawer turns the board into a torus, so hopping off one side
brings you back on the other.

| Input | Touch | Keyboard |
| --- | --- | --- |
| Hop | Swipe anywhere (four ways) | Arrows / WASD |
| Shoot the tongue | Press and hold | Hold Space |
| Steer the tongue | Drag while holding | Arrows while holding Space |
| Reel it in | Release | Release Space |

**Tune** opens sliders for every number that affects feel — including how many
rivals there are and how bold they get — and they persist in local storage.
**Defaults** puts them back. Those are the values to carry into Unity once
something feels right. Sound is synthesised at runtime, so there is nothing to
load; it starts on your first touch because browsers will not open an audio
device before a gesture.

## Levels

| | |
| --- | --- |
| **The Tiltyard** | Bare ground. Just the knights and room to work. |
| **Millrace** | One stream through the middle. |
| **Twin Races** | Two streams running opposite ways, dry ground between. |
| **The King's Road** | A two-lane road, carts in both directions. |
| **Toll Crossing** | Stream, road, stream. |

Each is a stack of lanes — grass, water or road — and the water and road lanes
carry their own traffic. Adding one is a few lines in `LEVELS`.

## The rules being tested

- A hop is a discrete, committed move — a whole number of cells over a fixed
  time, in one of four directions, Frogger-style rather than analogue walking.
- **Holding** shoots the tongue; **releasing** reels it in. A quick tap still
  produces a full jab (`minExtend`). At full stretch it turns for home on its
  own — holding longer buys nothing — and **it changes colour on the way back**,
  from red to gold, because that is when you are free to move again. You keep
  steering it the whole way home either way.
- The frog is pinned only while the tongue is going **out**. That is the
  commitment, and it is the risk that makes the joust a joust. Letting go ends
  it: you can hop away immediately and the tongue trails from the mouth as it
  reels in behind you. Pressing again cuts the reel-in short and fires afresh.
- While the tongue is out, the direction input steers **the tongue** instead.
- The tongue is live along its outer length, not just at the tip, so sweeping
  it across a rival on the way home counts.
- Water drowns you and carts flatten you. A log carries you while you stand on
  it, and **a log that reaches the end of the level goes under**, taking you
  with it unless something else is beneath you by then.
- Rival knights carry exactly the same tongue you do, and will use it. Their
  toads are a darker green than yours, so which one is you never needs thinking
  about.
- **Two tongues that meet in mid-air both turn back.** Neither knight gets the
  hit, which turns a head-on charge into a parry rather than a race to see who
  registered first.
- A struck knight is thrown **the way the blow was going**, with some scatter,
  so a sweep sends them sideways rather than back along the tongue.
- Their **helm comes off** and stays on the field. Ride over it to claim it.
  Helms obey the same world rules as everyone else: they ride logs, and they
  sink in open water, so a knight unhorsed over the stream may cost you the
  spoils. They lie there for `helmetLife` seconds, blinking out at the end.
  **Rivals want them too** and will cross the field to beat you to one, which
  is what stops a dropped helm being free money you can collect at leisure.

## Scoring

| | |
| --- | --- |
| Unhorsing a knight | `pointsUnhorse` (100) |
| Collecting a fallen helm | `pointsHelmet` (150) |

The helm is worth more than the kill on purpose: the kill is the thing you were
already doing, and the helm is the thing that makes you leave safe ground to go
and get it — with a rival racing you for it.

You have `lives` knights in the stable (3 by default). Drowning, being run
down, or being unhorsed spends one; when they are gone the round ends and you
can ride again or pick different ground. Score and lives sit together at the
top centre of the screen, lives as a row of little helms.

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
4. **`tongueBehind` caps how far back it may reach** (1 cell by default; 0
   pins it to a strict forward half-plane). The bound is a line that many cells
   behind the frog, square to its facing, and *both* the tip and the curve's
   outgoing control point get pushed in front of it. Clamping the tip alone is
   not enough — the control point can still bow the visible ribbon back past
   the line while both endpoints sit in front of it. Since a cubic stays inside
   the hull of its control points, holding both puts the whole ribbon inside
   the limit.

   **The cap is a ceiling, not a promise.** The heading resets to the facing on
   every shot, and auto-retract collapses the leash before a half-turn
   completes, so at the default `steerRate` of 6 the tip cannot physically get
   behind the frog *at all* — raising it to about 10 is what makes the
   allowance reachable. The test suite asserts both halves of this: that the
   clamp stops dead on the line when the steering is fast enough to reach it,
   and that at the default rate it never gets there.

Every mount owns one, player and rival alike. The only difference is where the
steering comes from: your finger, or the direction of you.

## Porting notes

- All gameplay units are **cells and seconds**. Pixels appear only in `proj` /
  `unproj`. `ISO` is the foreshortening — a cell is `cell` wide and
  `cell * ISO` tall — and it is the only thing separating this from a plain
  top-down view. In Unity it is the camera's pitch, nothing more.
- **Hops snap the raw screen delta; steering unprojects it.** Those are
  deliberately different. A hop should go where the finger pointed on screen,
  so its boundary between directions sits at a true 45°; unprojecting first
  would bias it toward the squashed axis, and a swipe that looks 45° would hop
  forward. Steering *is* unprojected, so a dragged tongue follows the finger's
  on-screen angle — the only angle the player can see.
- The snap is **by comparison, not by rounding an angle** — the result is
  exactly `±1` and `0`, so repeated hops can never accumulate floating-point
  drift off the cell centres.
- **Wrapping is a setting (`wrapEdges`), off by default**, and it reaches
  further than the hop. Rivals path by the shortest route and the tongue
  measures its reach the same way, so with walls up both have to stop reaching
  around the outside of the board — otherwise a rival on the far side hunts you
  through a wall it cannot cross.
- With walls, the hop target is clamped **at the start of the hop**, not on
  landing, so the flight never leaves the board and snaps back mid-air. A hop
  into a wall becomes a hop on the spot, which reads as bouncing off it.
- **Wrapping applies to hops, not to drifting.** Hop off an edge and you come
  out the other side; get carried off one by a log and you drown either way.
  That asymmetry is deliberate — it is what makes riding a log to the end a
  real risk rather than a free ride round the board.
- With wrapping on, a hop's landing is where the wrap happens, so the flight
  itself runs off the edge while an on-screen copy arrives at the other side.
  Copies are drawn only when a mount is genuinely past the last cell; ghosting
  anything merely *near* an edge leaves duplicate frogs parked outside the
  board.
- A mount riding a log is between columns. Hopping targets
  `round(x) + dir * hopCells`, which snaps it back onto the grid.
- Everything in a lane moves at the same speed, so a trailing log can never
  catch up to a leading one. The only way to survive your log sinking is to be
  standing where two logs **overlap** — sizing `gap` against the log lengths is
  what decides whether that is ever possible.
- The whole arena is framed on screen. Squared up, the board is much wider than
  it is tall, so the fit has to measure both axes — sizing off the smaller
  viewport dimension alone over-zooms and clips the rivals at the edges.
- The toad shows the back of its head when it hops away from the camera, and
  whether the rider draws in front of the head depends on the facing. Get that
  backwards and the knight eats one of the toad's eyes.
- Input reinterpretation matters: a press starts the tongue immediately, but if
  the finger travels past `swipeThreshold` within `swipeGrace` ms it is
  retroactively a swipe and the tongue is cancelled. Extension eases in over
  the first 90 ms so a cancelled tongue never shows a visible stub.
- A press can only cut a retraction short *after* the swipe window has passed,
  and a swipe only ever cancels a tongue that the same press started. Without
  both rules, swiping away blinks the old tongue out of existence instead of
  letting it reel in behind you.

## Rival knights

Deliberately simple: close the larger gap, and once you are in reach take a
swing. They will ride a log if one is there but will not jump into open water;
roads they will chance, and the carts do get them. They drown and they get run
over on exactly the same terms you do.

You get `graceTime` seconds of immunity after respawning — the toad pulses
while it lasts — because three rivals standing over the spawn will otherwise
simply farm you.

## Sound

Placeholder voices, synthesised from oscillators and filtered noise rather than
sampled: nothing to load, and each is a handful of numbers you can argue with
in `sfx`. Hop, land, tongue out and back, the hit, a splash, a squash.

They are deliberately crude. They exist to answer "does this action want a
sound, and roughly what shape", not to be the game's audio.

## Tests

```
node test/headless.js
```

Runs the simulation with no browser: it pulls the script out of `index.html`,
steps it at a fixed timestep, and checks the projection round-trips, that
swipes resolve to exactly four unit cardinals, that a walk leaves the frog with
zero drift off the cell centres, that the default walls hold the frog on the
board for the whole flight, that switching wrapping on carries hops across both
axes and leaves them genuinely out of bounds mid-flight, that distances stop
reaching around the edge when the walls are up, that open water drowns you and
a log does not, that
riding a log to the end drowns you unless a second log overlaps, that carts
kill, that traffic stays bounded over a minute, that no part of the tongue
curve out-reaches `tongueMax`, that steering the full 360° from all four
facings never breaches `tongueBehind` while still leaving a full sideways sweep
available, that the tongue turns for home by itself at full stretch and is
still steerable afterwards, that a struck knight is always thrown away from the
blow and never back into it, that a helm drops and can be collected for points
and sinks if it lands in open water, that two tongues meeting head-on both turn
back with neither knight unhorsed, that a rival crosses the field to steal a
helm, that lives run down and end the round and that a finished round stops
simulating, that movement frees up the instant you release,
that a rival closes and eventually unhorses you, and that every level loads and
starts you somewhere dry.
