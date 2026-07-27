/**
 * Headless sanity check for the Frog Joust movement prototype.
 *
 * Pulls the <script> out of index.html, runs it with __FJ_HEADLESS__ set (so it
 * skips all DOM binding and the rAF loop), then steps update() by hand to check
 * the simulation behaves. No browser required:
 *
 *   node test/headless.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  console.error("could not find the game <script> block in index.html");
  process.exit(1);
}

let clock = 0;
let failures = 0;

const sandbox = {
  console,
  performance: { now: () => clock },
  Math,
  JSON,
  __FJ_HEADLESS__: true,
  document: null,   // the script guards its own DOM use, but keep it obvious
  window: undefined,
  localStorage: undefined,
  setTimeout: () => 0
};
sandbox.globalThis = sandbox;

function fail(msg) { console.error("  FAIL  " + msg); failures++; }
function ok(msg) { console.log("  ok    " + msg); }
function check(cond, msg) { cond ? ok(msg) : fail(msg); }
function finite(v) { return typeof v === "number" && Number.isFinite(v); }

vm.createContext(sandbox);
vm.runInContext(match[1], sandbox, { filename: "index.html#script" });

const FJ = sandbox.FrogJoust;
if (!FJ) { fail("game did not expose its headless handle"); process.exit(1); }

const DT = 1 / 120;
function performanceNow() { return clock; }
function step(seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { clock += DT * 1000; FJ.update(DT); }
}
const R = () => Math.floor(FJ.CFG.arena / 2);

// Park the rivals where they cannot interfere with a test. Clearing `rider`
// matters as much as `dead`: the game only ever sets the two together, and a
// benched rival that still counts as mounted is still a target the tongue can
// catch at whatever random cell it spawned on.
function benchRivals() {
  for (const e of FJ.state().enemies) {
    if (e) { e.dead = true; e.rider = false; e.respawnIn = 1e6; }
  }
}

// Bench everyone, then put one rival back on the board at a known cell.
function loneRival(x, y) {
  benchRivals();
  const foe = FJ.state().enemies[0];
  foe.dead = false;
  foe.rider = true;
  foe.x = x; foe.y = y;
  foe.state = "idle";
  return foe;
}
// Empty the board AND stop the lanes producing more, so a test sees only the
// traffic it put there itself.
function clearHazards() {
  FJ.state().hazards.length = 0;
  for (const lane of FJ.state().lanes) lane.timer = 1e6;
}

function freshLevel(i = 0) {
  FJ.loadLevel(i);
  benchRivals();
  FJ.input.holding = false;
  FJ.input.consumed = true;
  FJ.input.hopQueue = null;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;
}

// --- 1. the projection round-trips and is square to the screen ----------
{
  let worst = 0;
  for (const [wx, wy] of [[1, 0], [0, 1], [-3, 2], [5, -5], [0.5, 0.25]]) {
    const p = FJ.proj(wx, wy, 0);
    const back = FJ.unproj(p.x, p.y);
    worst = Math.max(worst, Math.abs(back.x - wx), Math.abs(back.y - wy));
  }
  check(worst < 1e-12, `world -> screen -> world is exact (worst error ${worst})`);

  const east = FJ.proj(1, 0, 0), south = FJ.proj(0, 1, 0);
  check(east.y === 0 && east.x > 0, "moving east is purely rightward on screen");
  check(south.x === 0 && south.y > 0, "moving south is purely downward on screen");
  check(Math.abs(south.y - east.x * FJ.ISO) < 1e-9,
    `only the vertical is foreshortened (by ${FJ.ISO})`);
}

// --- 2. swipe snapping is exactly four ways -----------------------------
{
  const all = new Set();
  let clean = true, exact = true;
  for (let a = 0; a < 360; a += 3) {
    const r = (a * Math.PI) / 180;
    const d = FJ.snapDir(Math.cos(r), Math.sin(r));
    if (!finite(d.x) || !finite(d.y)) clean = false;
    if (Math.abs(d.x) + Math.abs(d.y) !== 1) exact = false;
    if (!Number.isInteger(d.x) || !Number.isInteger(d.y)) exact = false;
    all.add(`${d.x},${d.y}`);
  }
  check(clean, "every snapped direction is finite");
  check(exact, "directions are exactly unit cardinals, no floating-point drift");
  check(all.size === 4, `every swipe angle lands on one of 4 directions (got ${all.size})`);

  const swipe = (sx, sy) => FJ.snapDir(sx, sy);
  check(swipe(0, -120).y === -1, "swiping up moves forward, away from the camera");
  check(swipe(0, 120).y === 1, "swiping down moves back, toward the camera");
  check(swipe(120, 0).x === 1, "swiping right moves right");
  check(swipe(-120, 0).x === -1, "swiping left moves left");
  check(swipe(100, -40).x === 1, "a shallow up-right swipe still reads as right");
  check(swipe(40, -100).y === -1, "a steep up-right swipe still reads as forward");
}

// --- 3. hops cover whole cells and stay grid aligned --------------------
{
  freshLevel(0);
  clearHazards();
  const from = { x: FJ.state().player.x, y: FJ.state().player.y };
  FJ.requestHop({ x: 120, y: 0 });
  step(0.02);
  check(FJ.state().player.state === "hop", "a queued direction starts a hop");
  step(FJ.CFG.hopTime + 0.05);
  const p = FJ.state().player;
  check(Math.abs(Math.abs(p.x - from.x) - FJ.CFG.hopCells) < 1e-9,
    `hop covers hopCells exactly (${Math.abs(p.x - from.x)} cells)`);
  check(p.state === "idle" && p.z < 4, "hop ends idle and back on the floor");

  const walk = [[120, 0], [0, 120], [0, -120], [-120, 0], [120, 0], [0, 120]];
  let drift = 0;
  for (const [dx, dy] of walk) {
    FJ.requestHop({ x: dx, y: dy });
    step(FJ.CFG.hopTime + 0.06);
    const q = FJ.state().player;
    drift = Math.max(drift, Math.abs(q.x - Math.round(q.x)), Math.abs(q.y - Math.round(q.y)));
  }
  check(drift === 0, `after a walk the frog is still exactly on a cell (drift ${drift})`);
}

// --- 4a. walls (the default) --------------------------------------------
{
  freshLevel(0);
  clearHazards();
  FJ.CFG.wrapEdges = 0;
  const s = FJ.state();
  const dry = -R() + 1;
  s.player.x = -R(); s.player.y = dry;

  FJ.requestHop({ x: -120, y: 0 });          // hop left, into the left wall
  step(FJ.CFG.hopTime + 0.06);
  check(FJ.state().player.x === -R(),
    `by default the edge is a wall and you stay put (x=${FJ.state().player.x})`);

  // And the flight itself never leaves the board, so there is nothing to snap
  // back from mid-air.
  s.player.x = -R();
  FJ.requestHop({ x: -120, y: 0 });
  let strayed = 0;
  for (let i = 0; i < Math.round((FJ.CFG.hopTime + 0.02) / DT); i++) {
    step(DT);
    if (FJ.state().player.x < -R() - 1e-9) strayed++;
  }
  check(strayed === 0, "a hop into a wall never puts the frog off the board");

  s.player.y = -R();
  FJ.requestHop({ x: 0, y: -120 });
  step(FJ.CFG.hopTime + 0.06);
  check(FJ.state().player.y === -R(), "the far edge is a wall too");

  // With walls up, a rival on the far side must not path around the outside.
  const far = FJ.wrapDelta(R() - (-R()));
  check(far === 2 * R(), `distances do not reach around the edge (${far})`);
}

// --- 4b. wrapping, when switched on --------------------------------------
{
  freshLevel(0);
  clearHazards();
  FJ.CFG.wrapEdges = 1;
  const s = FJ.state();
  // A dry row: row 0 is the stream on this level, and a drowned frog cannot
  // demonstrate anything about wrapping.
  const dry = -R() + 1;
  s.player.x = -R(); s.player.y = dry;

  FJ.requestHop({ x: -120, y: 0 });          // hop left off the left edge
  step(FJ.CFG.hopTime + 0.06);
  check(FJ.state().player.x === R(),
    `hopping off the left edge comes out on the right (x=${FJ.state().player.x})`);

  FJ.requestHop({ x: 120, y: 0 });           // and straight back again
  step(FJ.CFG.hopTime + 0.06);
  check(FJ.state().player.x === -R(), "and back again the other way");

  // Vertically too — the far and near rows are both dry on this level.
  s.player.y = -R();
  FJ.requestHop({ x: 0, y: -120 });
  step(FJ.CFG.hopTime + 0.06);
  check(FJ.state().player.y === R(), "hopping off the far edge comes out at the near edge");

  // Mid-flight the position is allowed out of bounds — that is what lets the
  // on-screen copy arrive at the other side instead of the frog teleporting.
  s.player.x = R(); s.player.y = dry;
  FJ.requestHop({ x: 120, y: 0 });
  step(FJ.CFG.hopTime * 0.5);
  check(FJ.state().player.x > R(), "mid-hop the frog is genuinely past the edge");
  step(FJ.CFG.hopTime);
  check(FJ.state().player.x === -R(), "and lands wrapped");

  const across = FJ.wrapDelta(R() - (-R()));
  check(across === -1, `and distances take the short way round the edge (${across})`);

  FJ.CFG.wrapEdges = 0;      // back to the default for everything after this
}

// --- 5. water kills, logs carry -----------------------------------------
{
  freshLevel(0);                       // Millrace: one water row
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  check(Number.isInteger(waterRow) && waterRow >= -R(),
    `level 1 has a water lane (row ${waterRow})`);

  // Hop into open water with nothing under you.
  clearHazards();
  const s = FJ.state();
  s.player.x = 0; s.player.y = waterRow - 1;
  s.player.dying = null;
  const lostBefore = FJ.state().lost;
  FJ.requestHop({ x: 0, y: 120 });     // toward the camera, into the stream
  step(FJ.CFG.hopTime + 0.1);
  check(FJ.state().player.dying === "water", "hopping into open water drowns you");
  check(FJ.state().lost === lostBefore + 1, "and it counts against you");
  step(1.4);
  check(!FJ.state().player.dying, "you come back after a moment");
}

{
  freshLevel(0);
  clearHazards();
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  const s = FJ.state();

  // Put a log under the player and check it carries them.
  s.hazards.push({ kind: "log", x: 0, y: waterRow, len: 3, vx: 1.5, sinking: 0, tint: 0 });
  s.player.x = 0; s.player.y = waterRow;
  s.player.state = "idle"; s.player.dying = null;
  step(0.5);
  const p = FJ.state().player;
  check(!p.dying, "standing on a log keeps you dry");
  check(Math.abs(p.x - 0.75) < 0.02, `and carries you downstream (x=${p.x.toFixed(3)})`);

  // Hopping off a log snaps you back onto the grid.
  FJ.requestHop({ x: 0, y: -120 });
  step(FJ.CFG.hopTime + 0.06);
  const q = FJ.state().player;
  check(Number.isInteger(q.x) && Number.isInteger(q.y),
    `hopping off a drifting log lands you on a cell centre (${q.x}, ${q.y})`);
}

// --- 6. a log that reaches the end takes you with it --------------------
{
  freshLevel(0);
  clearHazards();
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  const s = FJ.state();

  // A log mid-board with the player aboard. Its leading edge reaches the far
  // end at t = 4 / 1.5 ≈ 2.7s, and that is when it goes under.
  s.hazards.push({ kind: "log", x: 0, y: waterRow, len: 3, vx: 1.5, sinking: 0, tint: 0 });
  s.player.x = 0; s.player.y = waterRow;
  s.player.state = "idle"; s.player.dying = null;
  step(1.0);
  check(!FJ.state().player.dying, "still riding while the log is on the board");
  step(2.5);
  check(FJ.state().player.dying === "water",
    "riding a log to the end of the level drowns you when it goes under");
}

{
  freshLevel(0);
  clearHazards();
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  const s = FJ.state();

  // "Unless there's another log underneath you." Everything in a lane moves at
  // the same speed, so a trailing log can never catch up — the only way to be
  // saved is to be standing where two logs OVERLAP, on the back of one and the
  // front of the next. Short log spans [-1.5, 1.5], long one spans [-6, -1],
  // and the frog stands at -1.4, which is on both.
  const shortLog = { kind: "log", x: 0, y: waterRow, len: 3, vx: 1.5, sinking: 0, tint: 0 };
  s.hazards.push(shortLog);
  s.hazards.push({ kind: "log", x: -3.5, y: waterRow, len: 5, vx: 1.5, sinking: 0, tint: 0 });
  s.player.x = -1.4; s.player.y = waterRow;
  s.player.state = "idle"; s.player.dying = null;

  step(3.2);      // the short log has gone under by now
  check(FJ.state().hazards.indexOf(shortLog) === -1,
    "the leading log has gone under");
  check(!FJ.state().player.dying,
    "and the log underneath saves you");
  step(2.2);      // now the long one reaches the end too
  check(FJ.state().player.dying === "water",
    "until that one runs out as well");
}

// --- 7. carts ------------------------------------------------------------
{
  freshLevel(2);                       // The King's Road
  const roadRows = [];
  FJ.state().lanes.forEach((l, i) => { if (l.type === "road") roadRows.push(i - R()); });
  check(roadRows.length === 2, `the road level is two cells wide (rows ${roadRows.join(", ")})`);

  clearHazards();
  const s = FJ.state();
  s.player.x = 0; s.player.y = roadRows[0];
  s.player.state = "idle"; s.player.dying = null;
  step(0.05);
  check(!FJ.state().player.dying, "standing on an empty road is fine");

  s.hazards.push({ kind: "car", x: -3, y: roadRows[0], len: 1.6, vx: 6, sinking: 0, tint: 0 });
  step(0.6);
  check(FJ.state().player.dying === "car", "a cart runs you down");
}

// --- 8. traffic spawns and clears ---------------------------------------
{
  freshLevel(3);                       // Toll Crossing: two streams + a road
  const s = FJ.state();
  const kinds = new Set(s.hazards.map(h => h.kind));
  check(s.hazards.length > 0, `the level opens with traffic already running (${s.hazards.length})`);
  check(kinds.has("log") && kinds.has("car"), "both logs and carts are present");

  let peak = 0, bad = 0;
  for (let i = 0; i < 60 * 60; i++) {
    step(1 / 60);
    const hz = FJ.state().hazards;
    peak = Math.max(peak, hz.length);
    for (const z of hz) if (!finite(z.x) || Math.abs(z.x) > R() + 40) bad++;
  }
  check(bad === 0, "nothing escapes to infinity over a minute of traffic");
  check(peak < 60, `hazard count stays bounded (peak ${peak})`);
}

// --- 9. tongue: reach, curve, and hits ----------------------------------
{
  freshLevel(0);
  clearHazards();
  const s = FJ.state();
  s.player.x = 0; s.player.y = -R() + 1; s.player.face = { x: 0, y: 1 };
  s.player.dying = null;
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;

  let bad = 0, over = 0, maxLen = 0;
  for (let i = 0; i < 240; i++) {
    step(DT);
    const t = FJ.state().player.tongue;
    maxLen = Math.max(maxLen, t.len);
    for (const n of t.nodes) {
      if (!finite(n.x) || !finite(n.y)) bad++;
      const d = Math.hypot(n.x - s.player.x, n.y - s.player.y) - 0.42;
      over = Math.max(over, d - FJ.CFG.tongueMax);
    }
  }
  check(bad === 0, "no NaN anywhere in the sampled curve");
  check(over < 1e-6, `no part of the curve out-reaches tongueMax (worst ${over.toFixed(6)})`);
  check(Math.abs(maxLen - FJ.CFG.tongueMax) < 1e-6,
    `tongue reaches its full ${FJ.CFG.tongueMax} cells and stops there`);
  FJ.input.holding = false;
  step(1);
}

{
  function shoot(sx, sy) {
    freshLevel(0);
    clearHazards();
    const s = FJ.state();
    s.player.x = 0; s.player.y = 0; s.player.face = { x: 0, y: 1 };
    s.player.dying = null;
    s.lanes.forEach(l => { if (l.type !== "grass") { l.type = "grass"; } });
    FJ.input.holding = true;
    FJ.input.consumed = false;
    FJ.input.steer.x = sx; FJ.input.steer.y = sy;
    // Sample near full stretch. Any later and auto-retract has already begun
    // pulling the curve straight again.
    step(0.4);
    const t = FJ.state().player.tongue;
    return { tip: { x: t.tip.x, y: t.tip.y }, nodes: t.nodes.map(n => ({ x: n.x, y: n.y })) };
  }
  const straight = shoot(0, 0);
  const steered = shoot(-0.7071, 0.7071);
  const drift = Math.hypot(steered.tip.x - straight.tip.x, steered.tip.y - straight.tip.y);
  check(finite(drift) && drift > 0.5,
    `steering carries the tip well off the straight path (${drift.toFixed(2)} cells)`);

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
  FJ.input.holding = false;
  step(1);
}

// --- 9b. the tongue reaches only as far behind as it is allowed ---------
{
  // Drive the steering all the way round the compass, holding each direction
  // long enough for the tip to settle there, and watch every sampled point of
  // the curve. Nothing may end up behind the frog's facing.
  freshLevel(0);
  clearHazards();
  const s = FJ.state();
  s.lanes.forEach(l => { l.type = "grass"; });
  FJ.CFG.wrapEdges = 0;

  const facings = [{ x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }];
  const behind = FJ.CFG.tongueBehind;
  let worstBehind = 0, reachedBack = 0, widest = 0;

  for (const face of facings) {
    s.player.x = 0; s.player.y = 0;
    s.player.state = "idle"; s.player.dying = null; s.player.safeT = 1e6;
    s.player.face = { x: face.x, y: face.y };
    FJ.input.downAt = performanceNow();
    FJ.input.holding = true;
    FJ.input.consumed = false;

    for (let a = 0; a < 360; a += 15) {
      const r = (a * Math.PI) / 180;
      FJ.input.steer.x = Math.cos(r);
      FJ.input.steer.y = Math.sin(r);
      for (let i = 0; i < 30; i++) {
        step(DT);
        const p = FJ.state().player, t = p.tongue;
        if (t.state === "idle") continue;
        for (const n of t.nodes) {
          // Forward component relative to the frog. Negative means behind it.
          const fwd = (n.x - p.x) * p.face.x + (n.y - p.y) * p.face.y;
          worstBehind = Math.min(worstBehind, fwd);
        }
        const vx = t.tip.x - p.x, vy = t.tip.y - p.y;
        const fwd = vx * p.face.x + vy * p.face.y;
        reachedBack = Math.min(reachedBack, fwd);
        const side = Math.abs(vx * -p.face.y + vy * p.face.x);
        widest = Math.max(widest, side);
      }
    }
    FJ.input.holding = false;
    step(1.2);
  }

  check(worstBehind >= -behind - 1e-9,
    `nothing reaches past the ${behind}-cell limit behind the frog ` +
    `(worst ${worstBehind.toFixed(4)})`);
  check(widest > 1.5, `and it still sweeps wide sideways (${widest.toFixed(2)} cells)`);
}

// --- 9c. and the limit is a real line, not a trivially-true one ---------
{
  // At the default steer rate the tip cannot physically get behind the frog
  // at all: the heading resets to the facing on every shot and auto-retract
  // collapses the leash before a half-turn completes. So drive the steering
  // hard enough to actually reach the line, and check the clamp holds it.
  function deepestBehind(rate, behind) {
    freshLevel(0);
    clearHazards();
    const s = FJ.state();
    s.lanes.forEach(l => { l.type = "grass"; });
    const wasRate = FJ.CFG.steerRate, wasBehind = FJ.CFG.tongueBehind;
    FJ.CFG.steerRate = rate;
    FJ.CFG.tongueBehind = behind;

    s.player.x = 0; s.player.y = 0; s.player.face = { x: 0, y: 1 };
    s.player.state = "idle"; s.player.dying = null; s.player.safeT = 1e6;
    FJ.input.downAt = performanceNow();
    FJ.input.holding = true;
    FJ.input.consumed = false;
    FJ.input.steer.x = 0; FJ.input.steer.y = -1;      // straight back

    let worst = 0;
    for (let i = 0; i < 600; i++) {
      step(DT);
      const p = FJ.state().player, t = p.tongue;
      if (t.state === "idle") { FJ.input.consumed = false; continue; }
      for (const n of t.nodes) {
        worst = Math.min(worst, (n.x - p.x) * p.face.x + (n.y - p.y) * p.face.y);
      }
    }
    FJ.input.holding = false;
    step(1.2);
    FJ.CFG.steerRate = wasRate;
    FJ.CFG.tongueBehind = wasBehind;
    return worst;
  }

  const at1 = deepestBehind(12, 1);
  check(Math.abs(at1 + 1) < 1e-6,
    `with reach set to 1 the tongue stops dead on the line (${at1.toFixed(6)})`);

  const at0 = deepestBehind(12, 0);
  check(at0 > -1e-9, `with reach set to 0 it never gets behind at all (${at0.toFixed(6)})`);

  const at2 = deepestBehind(12, 2);
  check(at2 < at1 - 0.2,
    `and raising the setting really does buy more room (${at2.toFixed(2)} vs ${at1.toFixed(2)})`);

  const atDefault = deepestBehind(FJ.CFG.steerRate, 1);
  check(atDefault > -0.05,
    `NOTE: at the default steer rate of ${FJ.CFG.steerRate} the tip barely gets ` +
    `behind at all (${atDefault.toFixed(3)}) — the setting is a cap, not a promise`);
}

// --- 9d. a tongue at full stretch comes back on its own -----------------
{
  freshLevel(0);
  clearHazards();
  const s = FJ.state();
  s.player.x = 0; s.player.y = -R() + 1; s.player.dying = null;
  s.player.face = { x: 0, y: 1 };
  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;        // and never let go
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;

  let sawFull = false;
  for (let i = 0; i < 240; i++) {
    step(DT);
    const t = FJ.state().player.tongue;
    if (t.len >= FJ.CFG.tongueMax - 1e-6) sawFull = true;
    if (sawFull && t.state === "retract") break;
  }
  check(sawFull, "the tongue reaches full stretch while held");
  check(FJ.state().player.tongue.state === "retract",
    "and turns for home by itself without the button being released");

  // Steering must still work on the way back.
  const before = { x: FJ.state().player.tongue.tip.x, y: FJ.state().player.tongue.tip.y };
  FJ.input.steer.x = -1; FJ.input.steer.y = 0;
  step(0.12);
  const after = FJ.state().player.tongue.tip;
  check(FJ.state().player.tongue.state === "retract" &&
        Math.abs(after.x - before.x) > 0.05,
    "and you can still steer it while it reels in");
  FJ.input.holding = false;
  step(1.2);
}

// --- 9e. knights fall the way they were hit -----------------------------
{
  // Strike a rival from due west twenty times and check every knight lands
  // eastward-ish — the direction of the blow, plus scatter, never against it.
  let samples = [], spread = 0;
  for (let n = 0; n < 20; n++) {
    FJ.loadLevel(0);
    clearHazards();
    const s = FJ.state();
    const foe = loneRival(2, -R() + 1);
    foe.hopTimer = 1e6; foe.restTimer = 1e6;
    s.player.x = 0; s.player.y = -R() + 1;
    s.player.face = { x: 1, y: 0 };          // pointing east, at the rival
    s.player.dying = null; s.player.safeT = 1e6;
    s.debris.length = 0;

    FJ.input.downAt = performanceNow();
    FJ.input.holding = true;
    FJ.input.consumed = false;
    FJ.input.steer.x = 0; FJ.input.steer.y = 0;
    step(0.7);
    FJ.input.holding = false;

    const d = FJ.state().debris[0];
    if (d) {
      const ang = Math.atan2(d.vy, d.vx);
      samples.push(ang);
      spread = Math.max(spread, Math.abs(ang));
    }
    step(0.6);
  }
  check(samples.length >= 18, `the strike lands nearly every time (${samples.length}/20)`);
  check(samples.every(a => Math.abs(a) < Math.PI / 2),
    "every unhorsed knight is thrown away from the blow, never back into it");
  check(spread > 0.02, `and the direction varies rather than being identical (${spread.toFixed(3)} rad)`);
}

// --- 9f. helmets drop, and are worth collecting -------------------------
{
  FJ.loadLevel(0);
  clearHazards();
  const s = FJ.state();
  // Dry ground throughout: a helm thrown from here can otherwise reach the
  // stream and sink, which is correct behaviour but makes this a coin flip.
  // Sinking gets its own test below.
  s.lanes.forEach(l => { l.type = "grass"; });
  const foe = loneRival(0, -R() + 3);
  foe.hopTimer = 1e6; foe.restTimer = 1e6;
  s.player.x = 0; s.player.y = -R() + 1;
  s.player.face = { x: 0, y: 1 };
  s.player.dying = null; s.player.safeT = 1e6;

  const scoreBefore = FJ.state().score;
  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;
  step(0.7);
  FJ.input.holding = false;

  check(FJ.state().score === scoreBefore + FJ.CFG.pointsUnhorse,
    `unhorsing scores ${FJ.CFG.pointsUnhorse}`);
  check(FJ.state().helmets.length === 1, "the knight's helm comes off and stays on the field");

  step(1.2);                       // let it land
  const helm = FJ.state().helmets[0];
  check(helm && helm.landed, "the helm settles on the ground");

  // Walk the player onto it.
  const mid = FJ.state().score;
  FJ.state().player.x = helm.x;
  FJ.state().player.y = helm.y;
  step(1 / 60);
  check(FJ.state().helmets.length === 0, "hopping onto a helm collects it");
  check(FJ.state().score === mid + FJ.CFG.pointsHelmet,
    `and collecting scores ${FJ.CFG.pointsHelmet}`);
}

// --- 9g. a helm dropped in the stream is lost ---------------------------
{
  FJ.loadLevel(0);
  clearHazards();
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  const s = FJ.state();
  benchRivals();
  s.player.x = 0; s.player.y = -R() + 1; s.player.dying = null;
  s.helmets.push({
    x: 3, y: waterRow, z: 0, vx: 0, vy: 0, vz: 0,
    rot: 0, spin: 0, armor: "#b0353a", trim: "#e5cfa0", life: 0, landed: true
  });
  step(1 / 60);
  check(FJ.state().helmets.length === 0, "a helm that lands in open water sinks");
}

// --- 10. movement is locked while extending, freed on release -----------
{
  freshLevel(0);
  clearHazards();
  const s = FJ.state();
  s.player.x = 0; s.player.y = -R() + 1; s.player.dying = null;
  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  step(0.25);
  const before = { x: FJ.state().player.x, y: FJ.state().player.y };
  FJ.requestHop({ x: 120, y: 0 });
  step(0.1);
  const during = FJ.state().player;
  check(during.x === before.x && during.y === before.y && during.state === "idle",
    "the frog cannot hop while the tongue is going out");

  FJ.input.holding = false;
  step(1 / 60);
  check(FJ.state().player.tongue.state === "retract", "releasing starts the retraction");
  const lenBefore = FJ.state().player.tongue.len;
  FJ.requestHop({ x: 120, y: 0 });
  step(1 / 60);
  check(FJ.state().player.state === "hop",
    "the frog can hop the instant it releases, mid-retraction");
  const t = FJ.state().player.tongue;
  check(t.state === "retract" && t.len > 0 && t.len < lenBefore,
    `the tongue carries on reeling in during that hop (${lenBefore.toFixed(2)} -> ${t.len.toFixed(2)})`);
  step(1.2);
}

// --- 11. rivals hunt, and their tongues are lethal ----------------------
{
  FJ.loadLevel(0);
  clearHazards();
  const s = FJ.state();
  // One rival, parked a few cells from a stationary player.
  const foe = loneRival(4, -R() + 1);
  s.player.x = 0; s.player.y = -R() + 1;
  s.player.safeT = 0;
  s.player.dying = null;
  FJ.input.holding = false;
  FJ.input.consumed = true;

  const startGap = Math.abs(foe.x - s.player.x);
  step(1.6);
  const gap = Math.abs(FJ.state().enemies[0].x - FJ.state().player.x);
  check(gap < startGap, `a rival closes the distance (${startGap} -> ${gap.toFixed(2)})`);

  step(8);
  check(FJ.state().lost > 0 || FJ.state().player.dying,
    "and eventually knocks you off your toad");
}

// --- 12. your tongue unhorses a rival ------------------------------------
{
  FJ.loadLevel(0);
  clearHazards();
  const s = FJ.state();
  const foe = loneRival(0, -R() + 3);   // two cells toward the camera
  foe.hopTimer = 1e6; foe.restTimer = 1e6;   // hold still, do not fight back
  s.player.x = 0; s.player.y = -R() + 1;
  s.player.face = { x: 0, y: 1 };
  s.player.dying = null;

  const koBefore = FJ.state().ko;
  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;
  step(0.8);
  check(FJ.state().ko === koBefore + 1, "your tongue unhorses a rival");
  check(FJ.state().debris.length > 0, "and throws the knight off");
  FJ.input.holding = false;
  step(1);
}

// --- 13. every level loads and is survivable to stand on ----------------
{
  for (let i = 0; i < FJ.LEVELS.length; i++) {
    FJ.loadLevel(i);
    benchRivals();
    const s = FJ.state();
    check(s.lanes.length === FJ.CFG.arena,
      `"${s.level.name}" has one lane per row`);
    check(s.lanes[Math.round(s.player.y) + R()].type === "grass",
      `"${s.level.name}" starts you on dry ground`);
    step(2);
    check(!FJ.state().player.dying,
      `"${s.level.name}" does not kill you for standing still`);
  }
}

console.log("");
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
