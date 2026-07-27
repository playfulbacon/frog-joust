/**
 * Headless sanity check for the Frog Joust movement prototype.
 *
 * Pulls the <script> out of index.html, runs it with __FJ_HEADLESS__ set (so it
 * skips all DOM binding and the rAF loop), then steps update() by hand to check
 * the hop and tongue simulations behave. No browser required:
 *
 *   node test/headless.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) fail("could not find the game <script> block in index.html");

const sandbox = {
  console,
  performance: { now: () => clock },
  Math,
  JSON,
  __FJ_HEADLESS__: true,
  document: null,   // the script guards its own DOM use, but keep it obvious
  window: undefined,
  localStorage: undefined
};
sandbox.globalThis = sandbox;

let clock = 0;
let failures = 0;

function fail(msg) {
  console.error("  FAIL  " + msg);
  failures++;
}
function ok(msg) {
  console.log("  ok    " + msg);
}
function check(cond, msg) {
  cond ? ok(msg) : fail(msg);
}
function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

vm.createContext(sandbox);
vm.runInContext(match[1], sandbox, { filename: "index.html#script" });

const FJ = sandbox.FrogJoust;
if (!FJ) fail("game did not expose its headless handle");

const DT = 1 / 120;
function performanceNow() { return clock; }
function step(seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    clock += DT * 1000;
    FJ.update(DT);
  }
}

// --- 1. the isometric projection round-trips ----------------------------
{
  let worst = 0;
  for (const [wx, wy] of [[1, 0], [0, 1], [-3, 2], [5, -5], [0.5, 0.25]]) {
    const p = FJ.proj(wx, wy, 0);
    const back = FJ.unproj(p.x, p.y);
    worst = Math.max(worst, Math.abs(back.x - wx), Math.abs(back.y - wy));
  }
  check(worst < 1e-12, `world -> screen -> world is exact (worst error ${worst})`);

  const one = FJ.proj(1, 0, 0);
  check(Math.abs(one.x - FJ.CFG.cell / 2) < 1e-9 &&
        Math.abs(one.y - (FJ.CFG.cell * FJ.ISO) / 2) < 1e-9,
    "one cell east lands half a cell right and half a cell-height down");
}

// --- 2. swipe snapping is exactly four ways -----------------------------
{
  const all = new Set();
  let clean = true, exact = true;
  for (let a = 0; a < 360; a += 3) {
    const r = (a * Math.PI) / 180;
    const d = FJ.snapDir(Math.cos(r), Math.sin(r));
    if (!finite(d.x) || !finite(d.y)) clean = false;
    // No rounding here on purpose: a grid game needs exactly +/-1 and 0, or
    // the frog drifts off the cell centres over time.
    if (Math.abs(d.x) + Math.abs(d.y) !== 1) exact = false;
    if (!Number.isInteger(d.x) || !Number.isInteger(d.y)) exact = false;
    all.add(`${d.x},${d.y}`);
  }
  check(clean, "every snapped direction is finite");
  check(exact, "directions are exactly unit cardinals, no floating-point drift");
  check(all.size === 4, `every swipe angle lands on one of 4 directions (got ${all.size})`);

  // Under the tilt the four world axes run diagonally on screen, so a swipe
  // is inverse-projected first and only then snapped.
  const swipe = (sx, sy) => { const w = FJ.unproj(sx, sy); return FJ.snapDir(w.x, w.y); };
  const C = FJ.CFG.cell, H = C * FJ.ISO;

  const downRight = swipe(C, H);
  check(downRight.x === 1 && downRight.y === 0, "a down-right swipe goes east");
  const upRight = swipe(C, -H);
  check(upRight.x === 0 && upRight.y === -1, "an up-right swipe goes north");
  const upLeft = swipe(-C, -H);
  check(upLeft.x === -1 && upLeft.y === 0, "an up-left swipe goes west");
  const downLeft = swipe(-C, H);
  check(downLeft.x === 0 && downLeft.y === 1, "a down-left swipe goes south");

  // Straight up the screen sits exactly on the boundary between two world
  // axes. Two things must hold there: the same flick always gives the same
  // hop, and leaning even slightly to one side picks that side. (A real
  // finger is never exactly vertical, so in practice you get whichever way
  // you leaned — which is the point.)
  const a = swipe(0, -100), b = swipe(0, -250);
  check(a.x === b.x && a.y === b.y,
    "a dead-vertical swipe is deterministic, not a coin flip");
  const leanRight = swipe(2, -100), leanLeft = swipe(-2, -100);
  check(leanRight.x === 0 && leanRight.y === -1,
    "leaning a touch right of vertical goes north");
  check(leanLeft.x === -1 && leanLeft.y === 0,
    "leaning a touch left of vertical goes west");
}

// --- 3. a hop covers whole cells and stays grid aligned -----------------
{
  FJ.reset();
  const from = { x: FJ.state().player.x, y: FJ.state().player.y };
  FJ.requestHop({ x: 1, y: 0 });
  step(0.02);
  check(FJ.state().player.state === "hop", "a queued direction starts a hop");
  step(FJ.CFG.hopTime + 0.05);
  const p = FJ.state().player;
  const travelled = Math.hypot(p.x - from.x, p.y - from.y);
  check(Math.abs(travelled - FJ.CFG.hopCells) < 1e-9,
    `hop covers hopCells exactly (${travelled} cells)`);
  check(p.state === "idle" && p.z < 4, "hop ends idle and back on the floor");

  // Walk a lap around the board and make sure we are still on cell centres.
  const walk = [[1, 0], [0, 1], [0, 1], [-1, 0], [0, -1], [1, 0], [-1, 0]];
  let drift = 0;
  for (const [dx, dy] of walk) {
    FJ.requestHop({ x: dx, y: dy });
    step(FJ.CFG.hopTime + 0.06);
    const q = FJ.state().player;
    drift = Math.max(drift, Math.abs(q.x - Math.round(q.x)), Math.abs(q.y - Math.round(q.y)));
  }
  check(drift === 0, `after a lap the frog is still exactly on a cell (drift ${drift})`);

  // And it cannot hop off the board.
  for (let i = 0; i < 20; i++) { FJ.requestHop({ x: 1, y: 0 }); step(FJ.CFG.hopTime + 0.03); }
  const edge = FJ.state().player;
  const bound = Math.floor(FJ.CFG.arena / 2);
  check(edge.x === bound, `the frog stops at the arena edge (x=${edge.x}, bound ${bound})`);
}

// --- 4. movement is locked while extending, freed on release ------------
{
  FJ.reset();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  step(0.25);
  const before = { x: FJ.state().player.x, y: FJ.state().player.y };
  FJ.requestHop({ x: 1, y: 0 });
  step(0.1);
  const during = FJ.state().player;
  check(during.x === before.x && during.y === before.y && during.state === "idle",
    "the frog cannot hop while the tongue is going out");

  // Release, then try to move immediately — the tongue is still on its way
  // home and that must not hold the frog in place.
  FJ.input.holding = false;
  step(1 / 60);
  check(FJ.state().tongue.state === "retract", "releasing starts the retraction");
  FJ.requestHop({ x: 1, y: 0 });
  step(1 / 60);
  check(FJ.state().player.state === "hop",
    "the frog can hop the instant it releases, mid-retraction");

  // And the tongue keeps reeling in while the frog is in the air.
  const tongueMid = FJ.state().tongue;
  check(tongueMid.state === "retract" && tongueMid.len > 0,
    "the tongue carries on retracting during that hop");
  step(1.2);
  check(FJ.state().tongue.state === "idle" && FJ.state().player.state === "idle",
    "both finish cleanly");
}

// --- 4b. a fresh press cuts a retraction short --------------------------
{
  FJ.reset();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  step(0.4);
  FJ.input.holding = false;
  step(1 / 60);
  check(FJ.state().tongue.state === "retract", "tongue is on its way back");

  FJ.input.holding = true;      // a new press, as a new finger down would be
  FJ.input.consumed = false;
  step(1 / 60);
  const t = FJ.state().tongue;
  check(t.state === "extend" && t.len < 0.5,
    "pressing again interrupts the retraction and shoots a fresh tongue");
  FJ.input.holding = false;
  step(1.5);
}

// --- 4c. swiping away mid-retraction must not kill the retraction --------
{
  FJ.reset();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  step(0.4);
  FJ.input.holding = false;          // release
  step(1 / 60);
  const lenBefore = FJ.state().tongue.len;
  check(FJ.state().tongue.state === "retract" && lenBefore > 1,
    "tongue is well out and reeling in");

  // A swipe is a press that turns into travel inside the grace window. It
  // should hop the frog and leave the old tongue alone, not blink it away.
  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  step(1 / 120);
  FJ.input.holding = false;          // reinterpreted as a swipe
  FJ.requestHop({ x: 1, y: 0 });
  step(1 / 60);

  const t = FJ.state().tongue;
  check(t.state === "retract" && t.len > 0 && t.len < lenBefore,
    `the tongue keeps reeling in through the swipe (${lenBefore.toFixed(2)} -> ${t.len.toFixed(2)})`);
  check(FJ.state().player.state === "hop", "and the frog hops anyway");
  step(1.2);
}

// --- 5. the tongue reaches, stays finite, and never exceeds its reach -----
{
  FJ.reset();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;

  let maxLen = 0, bad = 0, overreach = 0;
  for (let i = 0; i < 240; i++) {
    clock += DT * 1000;
    FJ.update(DT);
    const t = FJ.state().tongue;
    const m = { x: FJ.state().player.x, y: FJ.state().player.y };
    maxLen = Math.max(maxLen, t.len);
    for (const n of t.nodes) {
      if (!finite(n.x) || !finite(n.y)) bad++;
      // Measured from the mouth, which sits 0.42 cells ahead of the frog.
      const d = Math.hypot(n.x - m.x, n.y - m.y) - 0.42;
      overreach = Math.max(overreach, d - FJ.CFG.tongueMax);
    }
  }
  check(bad === 0, "no NaN anywhere in the sampled curve");
  check(overreach < 1e-6,
    `no part of the curve out-reaches tongueMax (worst overshoot ${overreach.toFixed(6)})`);
  check(Math.abs(maxLen - FJ.CFG.tongueMax) < 1e-6,
    `tongue reaches its full ${FJ.CFG.tongueMax} cells and stops there`);

  const s = FJ.state();
  const tip = s.tongue.tip;
  const reach = Math.hypot(tip.x - s.player.x, tip.y - s.player.y);
  check(reach > FJ.CFG.tongueMax * 0.9,
    `an unsteered tongue shoots out straight to full reach (tip ${reach.toFixed(2)} cells out)`);
}

// --- 6. steering actually bends the arc ----------------------------------
{
  function shootWithSteer(sx, sy) {
    FJ.reset();
    FJ.input.holding = true;
    FJ.input.consumed = false;
    FJ.input.steer.x = sx; FJ.input.steer.y = sy;
    step(0.6);
    const t = FJ.state().tongue;
    return { tip: { x: t.tip.x, y: t.tip.y }, nodes: t.nodes.map(n => ({ x: n.x, y: n.y })) };
  }
  const straight = shootWithSteer(0, 0);
  const steered = shootWithSteer(-0.7071, 0.7071);
  const drift = Math.hypot(steered.tip.x - straight.tip.x, steered.tip.y - straight.tip.y);
  check(finite(drift) && drift > 0.5,
    `steering carries the tip well off the straight path (${drift.toFixed(2)} cells)`);

  // A steered tongue must actually bow, not just pivot as a rigid stick.
  function bulge(sample) {
    const a = sample.nodes[0], b = sample.nodes[sample.nodes.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let worst = 0;
    for (const n of sample.nodes) {
      const off = Math.abs((b.x - a.x) * (a.y - n.y) - (a.x - n.x) * (b.y - a.y)) / len;
      worst = Math.max(worst, off);
    }
    return worst;
  }
  check(bulge(straight) < 0.02, "an unsteered tongue draws a straight line");
  check(bulge(steered) > 0.3,
    `a steered tongue draws a real curve (${bulge(steered).toFixed(2)} cells of bow)`);

  // Sampling must stay smooth — no kinks for the ribbon renderer to snag on.
  let maxStep = 0, minStep = Infinity;
  for (let i = 1; i < steered.nodes.length; i++) {
    const d = Math.hypot(steered.nodes[i].x - steered.nodes[i - 1].x,
                         steered.nodes[i].y - steered.nodes[i - 1].y);
    maxStep = Math.max(maxStep, d);
    minStep = Math.min(minStep, d);
  }
  check(maxStep / minStep < 4,
    `curve samples stay evenly spaced (${(maxStep / minStep).toFixed(2)}x spread)`);
}

// --- 7. a hit unhorses the rider -----------------------------------------
{
  FJ.reset();
  const s = FJ.state();
  s.enemies[0].x = 0; s.enemies[0].y = 2;       // two cells due south, dead ahead
  for (let i = 1; i < s.enemies.length; i++) {  // clear the lane of everyone else
    s.enemies[i].x = -9; s.enemies[i].y = -9;
  }
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;
  step(0.8);
  check(FJ.state().enemies[0].rider === false, "a tongue hit knocks the rider off");
  check(FJ.state().ko === 1, "the unhorsed tally counts it once");
  check(FJ.state().debris.length === 1 && finite(FJ.state().debris[0].vz),
    "the knight is launched with finite velocity");
  FJ.input.holding = false;
  step(3.6);
  check(FJ.state().debris.length === 0, "the fallen knight is cleaned up");
}

console.log("");
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
