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
function step(seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    clock += DT * 1000;
    FJ.update(DT);
  }
}

// --- 1. projection round-trips -----------------------------------------
{
  const w = FJ.unproj(FJ.CFG.tileW / 2, FJ.CFG.tileH / 2);
  check(Math.abs(w.x - 1) < 1e-9 && Math.abs(w.y) < 1e-9,
    "screen->world inverse: one tile right-down is world +x");
}

// --- 2. swipe snapping --------------------------------------------------
{
  const up = FJ.snapDir(-1, -1);          // a straight-up screen flick
  check(Math.abs(up.x - up.y) < 1e-9 && up.x < 0,
    "an up-screen swipe resolves to a real diagonal, not a coin flip");
  const all = new Set();
  let clean = true;
  for (let a = 0; a < 360; a += 7) {
    const r = (a * Math.PI) / 180;
    const d = FJ.snapDir(Math.cos(r), Math.sin(r));
    if (!finite(d.x) || !finite(d.y)) clean = false;
    // cos/sin leave 1e-16 crumbs where they should leave zero; round them away
    // or a single direction shows up as both "0.000" and "-0.000".
    const tidy = (v) => (Math.round(v * 1000) / 1000 + 0).toFixed(3);
    all.add(`${tidy(d.x)},${tidy(d.y)}`);
  }
  check(clean, "every snapped direction is finite");
  check(all.size === FJ.CFG.dirCount,
    `every swipe angle lands on one of ${FJ.CFG.dirCount} directions (got ${all.size})`);
}

// --- 3. a hop travels exactly hopDist and lands flat ---------------------
{
  FJ.reset();
  const s = FJ.state();
  const from = { x: s.player.x, y: s.player.y };
  FJ.requestHop({ x: 1, y: 0 });
  step(0.02);
  check(FJ.state().player.state === "hop", "a queued direction starts a hop");
  step(FJ.CFG.hopTime + 0.05);
  const p = FJ.state().player;
  const travelled = Math.hypot(p.x - from.x, p.y - from.y);
  check(Math.abs(travelled - FJ.CFG.hopDist) < 1e-6,
    `hop covers hopDist exactly (${travelled.toFixed(4)} tiles)`);
  check(p.state === "idle" && Math.abs(p.z) < 2,
    "hop ends idle and back on the ground plane");
}

// --- 4. hops are locked out for the whole tongue cycle -------------------
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
    "the frog cannot hop while the tongue is out");

  FJ.input.holding = false;
  step(1.2);
  check(FJ.state().tongue.state === "idle", "releasing reels the tongue all the way in");
  FJ.requestHop({ x: 1, y: 0 });
  step(0.05);
  check(FJ.state().player.state === "hop", "movement is handed back once the tongue is home");
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
      // Measured from the mouth, which sits 0.42 tiles ahead of the frog.
      const d = Math.hypot(n.x - m.x, n.y - m.y) - 0.42;
      overreach = Math.max(overreach, d - FJ.CFG.tongueMax);
    }
  }
  check(bad === 0, "no NaN anywhere in the sampled curve");
  check(overreach < 1e-6,
    `no part of the curve out-reaches tongueMax (worst overshoot ${overreach.toFixed(6)})`);
  check(Math.abs(maxLen - FJ.CFG.tongueMax) < 1e-6,
    `tongue reaches its full ${FJ.CFG.tongueMax} tiles and stops there`);

  const s = FJ.state();
  const tip = s.tongue.tip;
  const reach = Math.hypot(tip.x - s.player.x, tip.y - s.player.y);
  check(reach > FJ.CFG.tongueMax * 0.9,
    `an unsteered tongue shoots out straight to full reach (tip ${reach.toFixed(2)} tiles out)`);
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
    `steering carries the tip well off the straight path (${drift.toFixed(2)} tiles)`);

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
    `a steered tongue draws a real curve (${bulge(steered).toFixed(2)} tiles of bow)`);

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
  s.enemies[0].x = 1.6; s.enemies[0].y = 1.6;   // dead ahead of the default facing
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
