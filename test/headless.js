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

// Levels by name, so inserting one at the front cannot silently repoint a test
// at different ground.
const levelNamed = (name) => {
  const i = FJ.LEVELS.findIndex(l => l.name === name);
  if (i < 0) { fail(`no level called "${name}"`); return 0; }
  return i;
};
const PLAIN = levelNamed("The Tiltyard");
const MILLRACE = levelNamed("Millrace");
const ROAD = levelNamed("The King's Road");
const WHEEL = levelNamed("The Waterwheel");
const TOLL = levelNamed("Toll Crossing");

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
  freshLevel(MILLRACE);
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
  freshLevel(MILLRACE);
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
  freshLevel(MILLRACE);
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
  freshLevel(MILLRACE);                       // Millrace: one water row
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
  freshLevel(MILLRACE);
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
  freshLevel(MILLRACE);
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
  freshLevel(MILLRACE);
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
  freshLevel(ROAD);                    // The King's Road
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
  freshLevel(TOLL);                    // Toll Crossing: two streams + a road
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

// --- 8b. a looping river is a circle, and never runs dry ----------------
{
  freshLevel(WHEEL);
  const s = FJ.state();
  const rivers = s.lanes.filter(l => l.loop);
  const SPAN = FJ.CFG.arena;
  const loopGap = (a, b) => Math.abs((a - b) - Math.round((a - b) / SPAN) * SPAN);

  check(rivers.length === 2, `The Waterwheel has two looping rivers (${rivers.length})`);
  check(rivers[0].dir === -rivers[1].dir, "and they run opposite ways");
  check(s.lanes.filter(l => l.type !== "grass").length === 2,
    "with nothing but grass either side of them");

  const countOn = (row) => FJ.state().hazards.filter(z => z.y === row).length;
  const rows = rivers.map(l => l.y);

  // Two logs per river, now and for the next two minutes. A circle has no far
  // edge to be removed at and no near edge to be spawned from, so the cast is
  // fixed by construction — this is the check that it really is.
  let low = [Infinity, Infinity], high = [0, 0];
  let sank = 0, strayed = 0, gapDrift = 0;
  const firstGap = loopGap(...FJ.state().hazards.filter(z => z.y === rows[0]).map(z => z.x));
  for (let i = 0; i < 120 * 60; i++) {
    step(1 / 60);
    for (const z of FJ.state().hazards) {
      if (z.sinking > 0) sank++;
      // Every position stays on the circle: no drifting off to infinity, and
      // no waiting about off-board either.
      if (Math.abs(z.x) > SPAN / 2 + 1e-9) strayed++;
    }
    rows.forEach((row, k) => {
      const n = countOn(row);
      low[k] = Math.min(low[k], n);
      high[k] = Math.max(high[k], n);
    });
    const pair = FJ.state().hazards.filter(z => z.y === rows[0]).map(z => z.x);
    if (pair.length === 2) gapDrift = Math.max(gapDrift, Math.abs(loopGap(...pair) - firstGap));
  }
  check(low[0] === 2 && high[0] === 2 && low[1] === 2 && high[1] === 2,
    `each river carries exactly two logs throughout (${low}..${high})`);
  check(sank === 0, "no log ever goes under — a looping river has no far edge");
  check(strayed === 0, "and none of them leaves the circle");
  check(gapDrift < 1e-6,
    `their spacing never drifts over two minutes (${gapDrift.toExponential(1)} cells)`);

  const dirs = FJ.state().hazards.map(z => Math.sign(z.vx));
  check(dirs.includes(1) && dirs.includes(-1), "logs run both ways at once");
  check(Math.abs(firstGap - SPAN / 2) < 1e-9,
    `the two sit exactly half a lap apart (${firstGap} of ${SPAN})`);
}

// --- 8c. the river carries you round rather than drowning you -----------
{
  freshLevel(WHEEL);
  const s = FJ.state();
  const river = s.lanes.find(l => l.loop && l.dir > 0);
  const SPAN = FJ.CFG.arena;

  // Start aboard a log that is already almost at the edge, so the very first
  // thing that happens is the crossing.
  clearHazards();
  const log = { kind: "log", x: R() - 0.5, y: river.y, len: 3,
                vx: river.dir * river.speed, loop: true, sinking: 0, tint: 0.5 };
  s.hazards.push(log);
  s.players[0].x = log.x; s.players[0].y = river.y;
  s.players[0].state = "idle"; s.players[0].dying = null;
  s.players[0].safeT = 1e6;
  const livesBefore = FJ.state().lives;

  // A whole lap and a bit. If the seam let go of either the log or its
  // passenger, one of them ends up over open water and this drowns.
  let laps = 0, last = FJ.state().player.x, drowned = null, off = 0;
  for (let i = 0; i < 60 * 30; i++) {
    step(1 / 60);
    const p = FJ.state().player;
    if (p.dying) { drowned = p.dying; break; }
    if (p.x < last - SPAN / 2) laps++;      // came back round the seam
    last = p.x;
    if (!FJ.supportUnder(p)) off++;         // never once off its log
    if (Math.abs(p.x) > SPAN / 2 + 1e-9) off++;
  }
  check(drowned === null, `riding a looping river does not drown you (${drowned})`);
  check(laps >= 3, `it carries you round and round (${laps} laps in 30s)`);
  check(off === 0, "and you are never once off the log or off the circle");
  check(FJ.state().lives === livesBefore, "so it costs no lives");

  // The log is where the rider is, all the way across the seam.
  check(Math.abs(FJ.state().player.x - FJ.state().hazards[0].x) < 1e-6,
    "rider and log stay locked together across the seam");
}

// --- 8d. only looping lanes loop — an ordinary stream still drowns you ---
{
  freshLevel(MILLRACE);
  const s = FJ.state();
  const lane = s.lanes.find(l => l.type === "water");
  check(!lane.loop, "Millrace's stream is not a loop");
  clearHazards();
  s.hazards.push({ kind: "log", x: R() - 1.5, y: lane.y, len: 3,
                   vx: lane.dir * lane.speed, loop: false, sinking: 0, tint: 0.5 });
  s.players[0].x = R() - 1.5; s.players[0].y = lane.y;
  s.players[0].state = "idle"; s.players[0].dying = null;
  s.players[0].safeT = 1e6;

  let drowned = false;
  for (let i = 0; i < 60 * 8 && !drowned; i++) {
    step(1 / 60);
    if (FJ.state().player.dying === "water") drowned = true;
  }
  check(drowned, "riding an ordinary log to the end still drowns you");
}

// --- 9. tongue: reach, curve, and hits ----------------------------------
{
  freshLevel(MILLRACE);
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
    freshLevel(MILLRACE);
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
  freshLevel(MILLRACE);
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
    freshLevel(MILLRACE);
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
  freshLevel(MILLRACE);
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
    FJ.loadLevel(MILLRACE);
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
  FJ.loadLevel(MILLRACE);
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
  FJ.loadLevel(MILLRACE);
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
  freshLevel(MILLRACE);
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
  FJ.loadLevel(MILLRACE);
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
  FJ.loadLevel(MILLRACE);
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

// --- 14. tongues that meet in mid-air both back off ---------------------
{
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  const foe = loneRival(3, 0);
  foe.hopTimer = 1e6; foe.restTimer = 1e6;   // it will not pick its own moment
  foe.face = { x: -1, y: 0 };
  // ...but it must genuinely hold its tongue out, or it jabs for minExtend and
  // is already reeling in before the two can possibly meet.
  foe.attacking = true; foe.holdTimer = 2;
  s.player.x = 0; s.player.y = 0;
  s.player.face = { x: 1, y: 0 };            // squared up, facing each other
  s.player.dying = null; s.player.safeT = 1e6;

  // Fire both at once, straight down the line between them.
  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;
  FJ.startTongue(foe);

  let bothRetracting = false;
  for (let i = 0; i < 120; i++) {
    step(DT);
    const pt = FJ.state().player.tongue, ft = FJ.state().enemies[0].tongue;
    if (pt.state === "retract" && ft.state === "retract") { bothRetracting = true; break; }
    if (FJ.state().player.dying || FJ.state().enemies[0].dead) break;
  }
  check(bothRetracting, "two tongues meeting head-on both turn back");
  check(!FJ.state().player.dying && !FJ.state().enemies[0].dead,
    "and neither knight is unhorsed by the exchange");
  FJ.input.holding = false;
  step(1.2);
}

// --- 15. rivals go for the spoils too -----------------------------------
{
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  const foe = loneRival(0, 0);
  foe.restTimer = 1e6;                       // no attacking, just walking
  s.player.x = -R(); s.player.y = R();       // far away, out of the picture
  s.player.dying = null; s.player.safeT = 1e6;

  s.helmets.push({
    x: 3, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rot: 0, spin: 0,
    armor: "#b0353a", trim: "#e5cfa0", life: 0, landed: true
  });

  const startGap = 3;
  step(1.5);
  const gap = Math.abs(FJ.state().enemies[0].x - 3);
  check(gap < startGap, `a rival walks toward a fallen helm (${startGap} -> ${gap.toFixed(2)})`);

  step(4);
  check(FJ.state().helmets.length === 0, "and takes it off the field");
  check(FJ.state().score === 0, "the player scores nothing for one they lost");
}

// --- 16. lives, and the end of the round --------------------------------
{
  FJ.loadLevel(MILLRACE);
  clearHazards();
  benchRivals();
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  const lives0 = FJ.state().lives;
  check(lives0 === Math.round(FJ.CFG.lives), `a round starts with ${FJ.CFG.lives} lives`);

  function drown() {
    const s = FJ.state();
    s.player.x = 0; s.player.y = waterRow;
    s.player.state = "idle";
    step(2.2);                                // die, then respawn or end
  }

  drown();
  check(FJ.state().lives === lives0 - 1, "drowning costs a life");
  check(!FJ.state().over, "with lives left, the round carries on");

  for (let i = 0; i < lives0; i++) drown();
  check(FJ.state().lives <= 0, "the lives run out");
  check(FJ.state().over === true, "and the round ends");

  // A finished round must go quiet: nothing may move after the last life.
  const at = { x: FJ.state().player.x, y: FJ.state().player.y, score: FJ.state().score };
  FJ.requestHop({ x: 120, y: 0 });
  step(1);
  check(FJ.state().player.x === at.x && FJ.state().score === at.score,
    "and stops simulating once it is over");

  FJ.loadLevel(MILLRACE);
  check(FJ.state().lives === lives0 && !FJ.state().over,
    "starting another round puts the knights back");
}

// --- 17. a clash makes a mark you can see -------------------------------
{
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  const foe = loneRival(3, 0);
  foe.hopTimer = 1e6; foe.restTimer = 1e6;
  foe.face = { x: -1, y: 0 };
  foe.attacking = true; foe.holdTimer = 2;
  s.player.x = 0; s.player.y = 0;
  s.player.face = { x: 1, y: 0 };
  s.player.dying = null; s.player.safeT = 1e6;
  s.sparks.length = 0;

  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;
  FJ.startTongue(foe);
  step(0.5);

  const spark = FJ.state().sparks.find(k => k.kind === "clash") ||
                (FJ.state().sparks.length === 0 ? null : FJ.state().sparks[0]);
  check(spark !== null && spark !== undefined, "a clash throws off a burst");
  if (spark) {
    // ...and it happens between them, not at either mouth.
    check(spark.x > 0.6 && spark.x < 2.4,
      `the burst sits between the two knights (x=${spark.x.toFixed(2)})`);
  }
  FJ.input.holding = false;
  step(1.2);
}

// --- 18. combo: one extend through two knights ---------------------------
{
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  benchRivals();
  // Two rivals side by side, both within a single sweep.
  const a = s.enemies[0], b = s.enemies[1];
  for (const foe of [a, b]) {
    foe.dead = false; foe.rider = true; foe.state = "idle";
    foe.hopTimer = 1e6; foe.restTimer = 1e6;
  }
  a.x = -1; a.y = -2;
  b.x = 1; b.y = -2;
  s.player.x = 0; s.player.y = 0;
  s.player.face = { x: 0, y: -1 };            // facing them
  s.player.dying = null; s.player.safeT = 1e6;

  const before = FJ.state().score;
  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = -1; FJ.input.steer.y = -0.2;   // sweep across both
  step(0.22);
  FJ.input.steer.x = 1; FJ.input.steer.y = -0.2;    // and back the other way
  step(0.5);

  const felled = [a, b].filter(f => FJ.state().enemies.indexOf(f) >= 0 && f.dead).length;
  const gained = FJ.state().score - before;
  if (felled === 2) {
    check(gained === FJ.CFG.pointsUnhorse * 3,
      `two in one extend pays 1x then 2x (${gained} = ${FJ.CFG.pointsUnhorse} + ${FJ.CFG.pointsUnhorse * 2})`);
  } else {
    check(gained === FJ.CFG.pointsUnhorse * felled,
      `a single hit pays flat (${felled} felled for ${gained})`);
  }

  // The counter must not carry across shots.
  FJ.input.holding = false;
  step(1.2);
  check(FJ.state().player.tongue.hits === 0, "the combo counter resets between shots");
}

{
  // The multiplier itself, checked directly so it does not depend on landing
  // two sweeping hits in a physics sim.
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  benchRivals();
  s.player.dying = null; s.player.safeT = 1e6;
  s.player.x = 0; s.player.y = 0; s.player.face = { x: 0, y: -1 };

  let expected = 0;
  for (let n = 1; n <= 3; n++) {
    const foe = s.enemies[(n - 1) % s.enemies.length];
    foe.dead = false; foe.rider = true; foe.state = "idle";
    foe.hopTimer = 1e6; foe.restTimer = 1e6;
    foe.x = 0; foe.y = -1.5;                 // right on the tongue's path

    if (n === 1) {
      FJ.input.downAt = performanceNow();
      FJ.input.holding = true;
      FJ.input.consumed = false;
      FJ.input.steer.x = 0; FJ.input.steer.y = 0;
    }
    const at = FJ.state().score;
    for (let i = 0; i < 60 && !foe.dead; i++) step(DT);
    expected += FJ.CFG.pointsUnhorse * n;
    check(FJ.state().score - at === FJ.CFG.pointsUnhorse * n,
      `knight ${n} of the same extend scores x${n} (${FJ.state().score - at})`);
  }
  check(FJ.state().score === expected, `three in one extend totals ${expected}`);
  FJ.input.holding = false;
  step(1.2);
}

// --- 19. helms cannot leave the field ------------------------------------
{
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  benchRivals();
  s.player.x = 0; s.player.y = 0; s.player.dying = null; s.player.safeT = 1e6;

  // Fling helms hard off every corner and edge.
  const escapes = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (const [ex, ey] of escapes) {
    s.helmets.push({
      x: ex * (R() - 0.2), y: ey * (R() - 0.2), z: 30,
      vx: ex * 14, vy: ey * 14, vz: 240,
      rot: 0, spin: 0, armor: "#b0353a", trim: "#e5cfa0", life: 0, landed: false
    });
  }

  const scoreBefore = FJ.state().score;
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    step(DT);
    for (const h of FJ.state().helmets) {
      worst = Math.max(worst, Math.abs(h.x) - R(), Math.abs(h.y) - R());
    }
  }
  check(worst <= 1e-9, `no helm ever leaves the board (worst overshoot ${worst.toFixed(6)})`);

  // Every one is still accounted for: on the field, or claimed by the player
  // as it bounced past. None may simply vanish over the edge.
  const claimed = (FJ.state().score - scoreBefore) / FJ.CFG.pointsHelmet;
  check(FJ.state().helmets.length + claimed === 8,
    `all 8 are accounted for (${FJ.state().helmets.length} lying about, ${claimed} claimed)`);
}

// --- 20. one toad to a cell ----------------------------------------------
{
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  const foe = loneRival(1, 0);
  foe.hopTimer = 1e6; foe.restTimer = 1e6;      // stand perfectly still
  s.player.x = 0; s.player.y = 0;
  s.player.dying = null; s.player.safeT = 1e6;

  FJ.requestHop({ x: 120, y: 0 });              // straight at the rival
  step(FJ.CFG.hopTime + 0.06);
  const p = FJ.state().player;
  check(p.x === 0 && p.y === 0, `you cannot hop onto an occupied square (x=${p.x})`);
  check(p.face.x === 1 && p.face.y === 0,
    "but you do turn to face them, so a neighbour can still be lined up");

  // The square frees up the moment they are gone.
  foe.dead = true; foe.rider = false; foe.respawnIn = 1e6;
  FJ.requestHop({ x: 120, y: 0 });
  step(FJ.CFG.hopTime + 0.06);
  check(FJ.state().player.x === 1, "and the square opens up once it is vacated");
}

{
  // Two mounts aimed at the SAME empty square from opposite sides. Whoever
  // launches first must claim it; the other has to bounce.
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  const foe = loneRival(2, 0);
  foe.hopTimer = 1e6; foe.restTimer = 1e6;
  s.player.x = 0; s.player.y = 0;
  s.player.dying = null; s.player.safeT = 1e6;

  FJ.requestHop({ x: 120, y: 0 });              // player -> (1,0)
  step(DT);
  FJ.startHopFor(foe, { x: -1, y: 0 });         // rival -> (1,0) too
  step(FJ.CFG.hopTime + 0.08);

  const px = FJ.state().player.x, fx = FJ.state().enemies[0].x;
  check(px !== fx, `they do not land on the same square (player ${px}, rival ${fx})`);
  check(px === 1 && fx === 2, "the one already in the air keeps the square");
}

{
  // And the invariant has to survive real play: rivals hunting, dying and
  // respawning for a while, with the player standing in the middle of it.
  // Set the crowd BEFORE loading, so the level actually spawns five rivals and
  // places everyone legally. Teleporting the player in afterwards would create
  // the very overlap this is looking for.
  FJ.CFG.enemyCount = 5;
  FJ.loadLevel(PLAIN);
  check(FJ.state().enemies.filter(Boolean).length === 5, "five rivals take the field");

  let clash = null;
  for (let i = 0; i < 60 * 45 && !clash; i++) {
    step(1 / 60);
    const st = FJ.state();
    const seen = new Map();
    for (const m of [st.player].concat(st.enemies)) {
      if (!m || m.dead || m.dying) continue;
      if (m.state === "hop") continue;           // mid-air is between squares
      const key = `${Math.round(m.x)},${Math.round(m.y)}`;
      if (seen.has(key)) { clash = key; break; }
      seen.set(key, m);
    }
  }
  check(clash === null,
    clash ? `two mounts shared cell ${clash}` : "45 seconds of play, never two on one square");
  FJ.CFG.enemyCount = 3;
}

// --- 21. the helm comes off however you go -------------------------------
{
  // Drowned.
  freshLevel(MILLRACE);
  clearHazards();
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  const s = FJ.state();
  s.helmets.length = 0;
  s.player.x = 0; s.player.y = waterRow; s.player.state = "idle";
  step(0.1);
  check(FJ.state().player.dying === "water", "drowning, as set up");
  check(FJ.state().helmets.length === 1, "a drowned knight's helm comes off too");
  step(2.2);
}

{
  // Run down.
  freshLevel(ROAD);
  clearHazards();
  const roadRow = FJ.state().lanes.findIndex(l => l.type === "road") - R();
  const s = FJ.state();
  s.helmets.length = 0;
  s.player.x = 0; s.player.y = roadRow;
  s.player.state = "idle"; s.player.dying = null;
  s.hazards.push({ kind: "car", x: -3, y: roadRow, len: 1.6, vx: 6, sinking: 0, tint: 0 });
  step(0.6);
  check(FJ.state().player.dying === "car", "run down, as set up");
  check(FJ.state().helmets.length === 1, "and a flattened knight's helm comes off");
  step(2.2);
}

{
  // A rival taken by the traffic leaves one behind as well.
  freshLevel(ROAD);
  clearHazards();
  const roadRow = FJ.state().lanes.findIndex(l => l.type === "road") - R();
  const s = FJ.state();
  s.helmets.length = 0;
  const foe = loneRival(0, roadRow);
  foe.hopTimer = 1e6; foe.restTimer = 1e6;
  s.player.x = -R(); s.player.y = R(); s.player.dying = null; s.player.safeT = 1e6;
  // Right on top of it. Rivals now watch the road and jump clear of anything
  // they can see coming, so this has to be an ambush to land at all.
  s.hazards.push({ kind: "car", x: 0, y: roadRow, len: 1.6, vx: 6, sinking: 0, tint: 0 });
  step(0.05);
  check(FJ.state().enemies[0].dead, "the rival is run down, as set up");
  check(FJ.state().helmets.length === 1, "and drops a helm for you to go and fetch");
}

// --- 22. two knights on one couch ---------------------------------------
{
  FJ.join();
  FJ.loadLevel(PLAIN);
  const s = FJ.state();
  check(s.players.length === 2, "player two joins the party");
  check(s.players[0] !== s.players[1] &&
        (s.players[0].x !== s.players[1].x || s.players[0].y !== s.players[1].y),
    "and they start on separate squares");
  check(s.players[1].seat === 1, "with their own seat, and so their own controls");
  check(s.players[0].armor !== s.players[1].armor, "and their own colours");
}

// Aim one knight's tongue squarely at the other and see what each mode does.
function duel(versusMode) {
  FJ.join();
  FJ.setVersus(versusMode);
  FJ.loadLevel(PLAIN);
  clearHazards();
  benchRivals();
  const s = FJ.state();
  const [a, b] = s.players;
  a.x = 0; a.y = 0; a.face = { x: 0, y: 1 };
  b.x = 0; b.y = 2;
  a.dying = null; b.dying = null;
  a.safeT = 0; b.safeT = 0;
  a.score = 0; b.score = 0;

  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;
  step(0.8);
  const out = { hit: !!FJ.state().players[1].dying, score: FJ.state().players[0].score };
  FJ.input.holding = false;
  step(1.2);
  return out;
}

{
  const coop = duel(false);
  check(!coop.hit, "in co-op your tongue passes straight through your partner");
  check(coop.score === 0, "and there is nothing to be gained by trying");

  const vs = duel(true);
  check(vs.hit, "in versus it knocks them clean off");
  check(vs.score === FJ.CFG.pointsUnhorse,
    `and scores you ${FJ.CFG.pointsUnhorse} for it (${vs.score})`);
}

{
  // Rivals chase whoever is nearest, not always seat one.
  FJ.join();
  FJ.setVersus(false);
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  const foe = loneRival(4, 0);
  foe.restTimer = 1e6;                       // walk, do not shoot
  s.players[0].x = -4; s.players[0].y = 0; s.players[0].safeT = 1e6;
  s.players[1].x = 2; s.players[1].y = 0; s.players[1].safeT = 1e6;
  s.players[0].dying = null; s.players[1].dying = null;

  const gapBefore = Math.abs(foe.x - s.players[1].x);
  step(1.6);
  const gapAfter = Math.abs(FJ.state().enemies[0].x - FJ.state().players[1].x);
  check(gapAfter < gapBefore,
    `a rival goes for the nearer knight (${gapBefore} -> ${gapAfter.toFixed(2)})`);
}

{
  // Lives and the end of a two-player round.
  FJ.join();
  FJ.setVersus(false);
  FJ.loadLevel(MILLRACE);
  clearHazards();
  benchRivals();
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  const s = FJ.state();
  check(s.players[0].lives === s.players[1].lives,
    "each knight has their own stable of lives");

  // Drown seat one until the stable is empty. Capture the count first: reading
  // it in the loop condition while it decrements exits half way through.
  const stable = s.players[0].lives;
  for (let i = 0; i < stable; i++) {
    const p = FJ.state().players[0];
    p.x = 0; p.y = waterRow; p.state = "idle"; p.dying = null;
    step(2.2);
  }
  check(FJ.state().players[0].out, "one knight can be knocked out of the round");
  check(FJ.state().players[1].lives > 0, "without costing the other a thing");
  check(!FJ.state().over, "and in co-op the round continues while one still rides");

  const stable2 = FJ.state().players[1].lives;
  for (let i = 0; i < stable2; i++) {
    const p = FJ.state().players[1];
    p.x = 0; p.y = waterRow; p.state = "idle"; p.dying = null;
    step(2.2);
  }
  check(FJ.state().over, "it ends when the last knight is out");
}

{
  // In versus, the round ends the moment one of them is finished.
  FJ.join();
  FJ.setVersus(true);
  FJ.loadLevel(MILLRACE);
  clearHazards();
  benchRivals();
  const waterRow = FJ.state().lanes.findIndex(l => l.type === "water") - R();
  const vsStable = FJ.state().players[0].lives;
  for (let i = 0; i < vsStable; i++) {
    const p = FJ.state().players[0];
    p.x = 0; p.y = waterRow; p.state = "idle"; p.dying = null;
    step(2.2);
  }
  check(FJ.state().over, "in versus the round ends as soon as one is finished");
  check(!FJ.state().players[1].out, "leaving the other still mounted, as the winner");

  FJ.setVersus(false);
}

// --- 23. your own helm is gear, not treasure -----------------------------
{
  FJ.loadLevel(ROAD);
  clearHazards();
  benchRivals();
  const roadRow = FJ.state().lanes.findIndex(l => l.type === "road") - R();
  const s = FJ.state();
  s.helmets.length = 0;
  s.players[0].x = 0; s.players[0].y = roadRow;
  s.players[0].state = "idle"; s.players[0].dying = null;
  s.hazards.push({ kind: "car", x: -3, y: roadRow, len: 1.6, vx: 6, sinking: 0, tint: 0 });
  step(0.6);
  check(FJ.state().helmets.length === 1, "dying drops your helm, as before");
  check(FJ.state().helmets[0].owner === 0, "and it remembers whose head it came off");

  // Wait out the respawn, then go and stand on it.
  step(2.2);
  const helm = FJ.state().helmets[0];
  check(helm !== undefined, "the helm is still lying there after you come back");
  if (helm) {
    // Seed a score first: 0 before and 0 after would also pass if pickups were
    // broken outright, which is not what this is testing.
    FJ.state().players[0].score = 500;
    const before = FJ.state().players[0].score;
    FJ.state().players[0].x = helm.x;
    FJ.state().players[0].y = helm.y;
    FJ.state().players[0].dying = null;
    step(1 / 60);
    check(FJ.state().helmets.length === 0, "you pick your own helm back up");
    check(FJ.state().players[0].score === before,
      `but score nothing for it (${FJ.state().players[0].score} vs ${before})`);
  }
}

{
  // A rival's helm still pays, so the rule is about ownership and not about
  // helms in general.
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  benchRivals();
  s.helmets.length = 0;
  s.players[0].dying = null;
  s.helmets.push({
    x: s.players[0].x, y: s.players[0].y, z: 0, vx: 0, vy: 0, vz: 0,
    rot: 0, spin: 0, armor: "#b0353a", trim: "#e5cfa0",
    life: 0, landed: true, owner: null
  });
  const before = FJ.state().players[0].score;
  step(1 / 60);
  check(FJ.state().players[0].score === before + FJ.CFG.pointsHelmet,
    `a rival's helm still pays ${FJ.CFG.pointsHelmet}`);
}

{
  // And in two-player, your partner's helm is not your helm.
  FJ.join();
  FJ.loadLevel(PLAIN);
  clearHazards();
  benchRivals();
  const s = FJ.state();
  s.helmets.length = 0;
  s.players[0].dying = null;
  s.players[1].dying = null;
  s.helmets.push({
    x: s.players[0].x, y: s.players[0].y, z: 0, vx: 0, vy: 0, vz: 0,
    rot: 0, spin: 0, armor: "#d94f9a", trim: "#f0dca8",
    life: 0, landed: true, owner: 1                     // seat two's helm
  });
  const before = FJ.state().players[0].score;
  step(1 / 60);
  check(FJ.state().players[0].score === before + FJ.CFG.pointsHelmet,
    "seat one is paid for fetching seat two's helm");
}

// --- 24. rivals watch the traffic ----------------------------------------
{
  FJ.loadLevel(ROAD);
  clearHazards();
  const s = FJ.state();
  const roads = [];
  s.lanes.forEach((l, i) => { if (l.type === "road") roads.push(i - R()); });
  const foe = loneRival(0, roads[0] - 1);       // on the grass beside the road
  foe.restTimer = 1e6;
  foe.hopTimer = 0;
  s.players[0].x = 0; s.players[0].y = roads[1] + 1;   // straight across from it
  s.players[0].dying = null; s.players[0].safeT = 1e6;

  // A cart about to pass the square it would step onto.
  s.hazards.push({ kind: "car", x: -2.2, y: roads[0], len: 1.6, vx: 6, sinking: 0, tint: 0 });
  step(0.1);
  check(FJ.state().enemies[0].y === roads[0] - 1,
    "a rival will not step in front of a cart it can see coming");

  // Once it has gone by, the way is clear and it crosses.
  step(1.4);
  check(FJ.state().enemies[0].y > roads[0] - 1,
    "and goes once the road is clear");
}

{
  // Standing on a road with something bearing down, it bolts without waiting
  // for its usual hop timer.
  FJ.loadLevel(ROAD);
  clearHazards();
  const s = FJ.state();
  const roads = [];
  s.lanes.forEach((l, i) => { if (l.type === "road") roads.push(i - R()); });
  const foe = loneRival(0, roads[0]);
  foe.restTimer = 1e6;
  foe.hopTimer = 1e6;                            // deliberately not due a move
  s.players[0].x = 0; s.players[0].y = -R(); s.players[0].dying = null;
  s.players[0].safeT = 1e6;
  s.hazards.push({ kind: "car", x: -3.2, y: roads[0], len: 1.6, vx: 6, sinking: 0, tint: 0 });

  step(0.5);
  const after = FJ.state().enemies[0];
  check(!after.dead, "a rival caught on the road gets out of the way");
  check(after.y !== roads[0] || Math.abs(after.x) > 0.5,
    "leaving the square the cart was heading for");
}

// --- 25. rivals use the logs ---------------------------------------------
{
  FJ.loadLevel(MILLRACE);
  clearHazards();
  const s = FJ.state();
  const waterRow = s.lanes.findIndex(l => l.type === "water") - R();
  const foe = loneRival(0, waterRow - 1);        // north bank
  foe.restTimer = 1e6;
  s.players[0].x = 0; s.players[0].y = waterRow + 2;   // the far side
  s.players[0].dying = null; s.players[0].safeT = 1e6;

  // No log yet: it must not walk into the water, however much it wants to.
  step(1.2);
  check(FJ.state().enemies[0].y === waterRow - 1 && !FJ.state().enemies[0].dead,
    "with no log in sight a rival stays on the bank");

  // Send one along under it.
  s.hazards.push({ kind: "log", x: -4, y: waterRow, len: 3, vx: 1.5, sinking: 0, tint: 0 });
  let boarded = false;
  for (let i = 0; i < 60 * 8 && !boarded; i++) {
    step(1 / 60);
    const e = FJ.state().enemies[0];
    if (Math.round(e.y) === waterRow && !e.dead) boarded = true;
  }
  check(boarded, "and boards one when it comes past");
  check(!FJ.state().enemies[0].dead, "without drowning in the attempt");
}

{
  // A rival aboard a log that is about to go under gets off it.
  FJ.loadLevel(MILLRACE);
  clearHazards();
  const s = FJ.state();
  const waterRow = s.lanes.findIndex(l => l.type === "water") - R();
  const foe = loneRival(R() - 2, waterRow);
  foe.restTimer = 1e6;
  foe.hopTimer = 1e6;                            // again, not due a move
  s.players[0].x = 0; s.players[0].y = -R(); s.players[0].dying = null;
  s.players[0].safeT = 1e6;
  s.hazards.push({ kind: "log", x: R() - 2, y: waterRow, len: 3, vx: 1.5, sinking: 0, tint: 0 });

  step(1.6);
  const e = FJ.state().enemies[0];
  check(!e.dead, "a rival rides a log without drowning");
  check(Math.round(e.y) !== waterRow,
    "and steps off before it reaches the end of the level");
}

// --- 26. a dead knight takes his tongue with him -------------------------
{
  // Unhorse a rival while its own tongue is out. Nothing updates a dead
  // mount, so a tongue left extended here would hang across the field until
  // the rival respawned seconds later.
  FJ.loadLevel(PLAIN);
  clearHazards();
  const s = FJ.state();
  const foe = loneRival(0, -R() + 3);
  foe.hopTimer = 1e6; foe.restTimer = 1e6;
  // Pointing AWAY from the player, so its tongue cannot clash with the one
  // coming for it — a clash would make both retract and the hit would never
  // land, which is a different situation from the one being tested.
  foe.face = { x: 0, y: 1 };
  foe.attacking = true; foe.holdTimer = 5;
  FJ.startTongue(foe);

  s.players[0].x = 0; s.players[0].y = -R() + 1;
  s.players[0].face = { x: 0, y: 1 };
  s.players[0].dying = null; s.players[0].safeT = 1e6;

  step(0.12);
  check(FJ.state().enemies[0].tongue.state !== "idle",
    "the rival has its tongue out, as set up");

  FJ.input.downAt = performanceNow();
  FJ.input.holding = true;
  FJ.input.consumed = false;
  FJ.input.steer.x = 0; FJ.input.steer.y = 0;

  // Watch the exact frame it dies, and what its tongue was doing just before.
  let stateBeforeDeath = null;
  for (let i = 0; i < 200; i++) {
    const was = FJ.state().enemies[0].tongue.state;
    step(DT);
    if (FJ.state().enemies[0].dead) { stateBeforeDeath = was; break; }
  }
  check(FJ.state().enemies[0].dead, "and is then unhorsed, as set up");
  check(stateBeforeDeath && stateBeforeDeath !== "idle",
    `with its tongue still out at the moment of the blow (${stateBeforeDeath})`);

  const t = FJ.state().enemies[0].tongue;
  check(t.state === "idle" && t.len === 0,
    `an unhorsed knight's tongue goes with him (state ${t.state}, len ${t.len})`);

  // And it stays gone — nothing brings a dead mount's tongue back.
  step(1.5);
  const later = FJ.state().enemies[0].tongue;
  check(later.state === "idle" && later.len === 0, "and does not come back");
  FJ.input.holding = false;
  step(1.2);
}

// --- 27. rivals only unhorse each other when crossfire is switched on -----
// One rival shoots down its own row with a second rival stood in the way and
// the player beyond them both, so the shooter's own steering sweeps its tongue
// straight across its neighbour. The tongue definitely arrives; whether the
// neighbour goes down is the whole question.
function crossfireTrial(on) {
  FJ.loadLevel(PLAIN);
  clearHazards();
  FJ.CFG.enemyFriendlyFire = on ? 1 : 0;
  const s = FJ.state();
  benchRivals();
  const a = s.enemies[0], b = s.enemies[1];
  for (const e of [a, b]) {
    e.dead = false; e.rider = true; e.state = "idle"; e.dying = null;
    e.hopTimer = 1e6; e.restTimer = 1e6; e.attacking = false;
  }
  const row = -R() + 2;
  a.x = 0; a.y = row;
  b.x = 1; b.y = row;
  s.players[0].x = 5; s.players[0].y = row;
  s.players[0].dying = null; s.players[0].safeT = 1e6;

  a.face = { x: 1, y: 0 };
  a.attacking = true; a.holdTimer = 5;
  FJ.startTongue(a);

  let closest = Infinity;
  for (let i = 0; i < 240; i++) {
    step(DT);
    if (!b.dead) {
      for (let n = 5; n < a.tongue.nodes.length; n++) {
        const q = a.tongue.nodes[n];
        closest = Math.min(closest, Math.hypot(q.x - b.x, q.y - b.y));
      }
    }
    if (b.dead) break;
  }
  return { hit: b.dead, closest };
}
{
  const off = crossfireTrial(false);
  check(off.closest < FJ.CFG.hitRadius,
    `a rival's tongue does sweep over its neighbour (within ${off.closest.toFixed(2)} cells)`);
  check(!off.hit, "but with crossfire off it cannot unhorse another rival");

  const on = crossfireTrial(true);
  check(on.hit, "and with crossfire switched on it can");

  FJ.CFG.enemyFriendlyFire = 0;   // back to the default for anything after
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
