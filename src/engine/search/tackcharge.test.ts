/**
 * The tack penalty is one rule (legsim.ts tackChargeS) wherever a move is timed after another: the stage sweep, the
 * terminal hop, a leg's first move after the leg before, the refined router's layout, the smoother's shortcuts.
 * Before 2026-11-01 only the stage sweep charged it: a route whose one tack was its final hop arrived at the same
 * time with a penalty of 0 and of 1,800 s.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../../geo/landmask';
import { haversineBearing, projectAlongBearing } from '../../geo/geodesy';
import { ConstantWind, NoCurrent, type WindSource } from '../environment';
import { ExperimentalPropagator } from '../experimental/propagator';
import { simulateLegTime, tackBetween, tackChargeS, type LegArrival } from '../legsim';
import { routeMultiLeg } from '../multileg';
import { OceanPropagator } from '../propagator';
import { arrivalInto, routeArrival, type Route, type Waypoint } from '../route';
import { shortcutSmoother } from '../smoother';
import { PolarDiagram } from '../../vessel/polar';
import { makeVessel } from '../../vessel/vessel';

const POLAR = PolarDiagram.parse(
  `twa/tws,4,6,8,10,12,14,16,20,25
0,0,0,0,0,0,0,0,0,0
30,1.5,2.5,3.3,4.0,4.3,4.5,4.6,4.7,4.7
45,2.5,3.6,4.5,5.1,5.5,5.7,5.8,5.9,5.9
60,3.0,4.2,5.1,5.7,6.1,6.3,6.4,6.5,6.5
90,3.2,4.5,5.5,6.1,6.5,6.7,6.8,6.9,6.9
120,3.0,4.3,5.3,6.0,6.4,6.7,6.9,7.1,7.2
150,2.4,3.6,4.6,5.4,6.0,6.4,6.7,7.0,7.3
180,2.0,3.0,4.0,4.8,5.5,6.0,6.4,6.8,7.1`,
  ','
);
const BBOX = { west: -1, south: -1, east: 2, north: 2 };
const OPEN = LandMask.fromPolygons([], BBOX, 0.01);
const T0 = new Date('2026-01-01T00:00:00Z');
const KN = 0.514444;
/** Wind from `dir` at 12 kn, valid two days. */
const wind = (dir: number): WindSource & { validRange: [Date, Date] } =>
  Object.assign(new ConstantWind(12 * KN, dir), { validRange: [T0, new Date(T0.getTime() + 48 * 3600e3)] as [Date, Date] });
const VESSEL = makeVessel({ motorSpeedMs: 1 });
const SIM = { modePolicy: 'sail_max' as const, sailThreshMs: 1, simStepM: 200 };

/** Tacks in a route: consecutive sailed legs with the wind on the other side of the boat. */
function countTacks(r: Route): number {
  let n = 0;
  const w = r.waypoints;
  for (let i = 2; i < w.length; i++) {
    const a = w[i - 1];
    const b = w[i];
    if (a.mode === 'sailing' && b.mode === 'sailing' && a.windDirDeg !== undefined && tackBetween(a.cogDeg, b.cogDeg, a.windDirDeg)) n++;
  }
  return n;
}
const shape = (r: Route): number[][] => r.waypoints.map(w => [w.lon, w.lat]);

test('tackChargeS: the penalty only when both moves sail and the wind changes sides; nothing before the first move', () => {
  const opts = { tackPenaltyS: 600 };
  const sailing: LegArrival = { cogDeg: 45, mode: 'sailing' };
  assert.equal(tackChargeS(sailing, 0, 315, true, opts), 600, 'starboard to port, wind from north');
  assert.equal(tackChargeS(sailing, 0, 60, true, opts), 0, 'same side');
  assert.equal(tackChargeS(sailing, 0, 315, false, opts), 0, 'the hop motors');
  assert.equal(tackChargeS({ cogDeg: 45, mode: 'motoring' }, 0, 315, true, opts), 0, 'the boat arrived motoring');
  assert.equal(tackChargeS(null, 0, 315, true, opts), 0, 'nothing came before');
  assert.equal(tackChargeS(undefined, 0, 315, true, opts), 0);
  assert.equal(tackChargeS(sailing, NaN, 315, true, opts), 0, 'no wind direction');
  assert.equal(tackChargeS(sailing, 0, 315, true, { tackPenaltyS: 0 }), 0, 'no penalty set');
  assert.equal(tackChargeS(sailing, 0, 315, true, {}), 30, 'the default penalty');
  assert.equal(tackChargeS(sailing, 0, 180, true, opts), 0, 'dead downwind is on neither side');
});

test('standard search: the final hop pays for its tack; the route arrives later by one penalty per tack', () => {
  // Dead upwind from the east, 111 km: eleven stage moves on one tack, then a final hop on the other (the beat's one
  // tack is the final hop; the route is otherwise the same with and without the penalty).
  const run = (tackPenaltyS: number): Route =>
    new OceanPropagator(OPEN, { stages: 12, subsectors: 20, headings: 30 }).computeRoute({
      start: [0, 0.5],
      end: [1, 0.5],
      departureTime: T0,
      vessel: VESSEL,
      polar: POLAR,
      wind: wind(90),
      ...SIM,
      tackPenaltyS,
    });
  const free = run(0);
  const dear = run(1800);
  assert.deepEqual(shape(dear), shape(free), 'the same route');
  const tacks = countTacks(dear);
  assert.ok(tacks >= 1, `tacks ${tacks}`);
  assert.ok(
    Math.abs(dear.totalTimeS - free.totalTimeS - 1800 * tacks) < 1,
    `${dear.totalTimeS} − ${free.totalTimeS} s for ${tacks} tack(s)`
  );
  assert.ok(Math.abs(dear.sailingTimeS + dear.motoringTimeS - dear.totalTimeS) < 1, 'the penalty is sailing time');
});

test("a leg's first move is charged against how the boat arrived (the leg before's last move), not treated as a start", () => {
  // South-east with the wind from the east: the moves sail at about 150° (port). A boat arriving sailing at 60°
  // (starboard) tacks on its first move; one arriving motoring, or on 150°, does not.
  const run = (arriving: LegArrival | null): Route =>
    new OceanPropagator(OPEN, { stages: 6, subsectors: 20, headings: 30 }).computeRoute({
      start: [0, 0.5],
      end: [0.3, 0],
      departureTime: T0,
      vessel: VESSEL,
      polar: POLAR,
      wind: wind(90),
      ...SIM,
      tackPenaltyS: 900,
      arriving,
    });
  const fresh = run(null);
  const other = run({ cogDeg: 60, mode: 'sailing' });
  const same = run({ cogDeg: 150, mode: 'sailing' });
  const motored = run({ cogDeg: 60, mode: 'motoring' });
  assert.ok(fresh.waypoints[1].mode === 'sailing');
  assert.deepEqual(shape(other), shape(fresh));
  assert.ok(Math.abs(other.totalTimeS - fresh.totalTimeS - 900) < 1, `${other.totalTimeS} vs ${fresh.totalTimeS}`);
  assert.equal(same.totalTimeS, fresh.totalTimeS);
  assert.equal(motored.totalTimeS, fresh.totalTimeS);
});

test('routeMultiLeg hands each leg how the one before ended (its last course and mode)', async () => {
  const seen: (LegArrival | null)[] = [];
  const legs: Route[] = [];
  const r = await routeMultiLeg({
    stops: [
      { lon: 0, lat: 0.5 },
      { lon: 0.3, lat: 0.5 },
      { lon: 0.3, lat: 0.2 },
    ],
    departureTime: T0,
    runLeg: (plan, start, departure, arriving) => {
      seen.push(arriving);
      const leg = new OceanPropagator(OPEN, { stages: 4, subsectors: 20, headings: 30 }).computeRoute({
        start,
        end: plan.end,
        departureTime: departure,
        vessel: VESSEL,
        polar: POLAR,
        wind: wind(0),
        ...SIM,
        arriving,
      });
      legs.push(leg);
      return leg;
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], null, 'the route start');
  assert.deepEqual(seen[1], routeArrival(legs[0]));
  const n = legs[0].waypoints.length;
  assert.deepEqual(seen[1], arrivalInto(legs[0].waypoints[n - 2], legs[0].waypoints[n - 1]));
  assert.ok(r.waypoints.length > 2);
});

test('refined layout: every tack or gybe between sailed pieces costs the penalty once, the first piece from the start none', () => {
  // A fixed polyline dead into the wind, laid out as tacks (experimental/propagator.ts sailPolyline): under a constant
  // wind the layout's shape does not depend on the penalty, so the difference in arrival is the penalty times the
  // number of times the wind changes sides between sailed pieces.
  const lay = (tackPenaltyS: number, arriving: LegArrival | null = null): Route =>
    new ExperimentalPropagator(OPEN, { stages: 10 }).sailPolyline(
      [
        [0, 0],
        [0, 0.2],
      ],
      T0,
      {
        vessel: makeVessel({ motorSpeedMs: 3 }),
        polar: POLAR,
        wind: wind(0),
        current: new NoCurrent(),
        sim: { ...SIM, sailThreshMs: 2.5, tackPenaltyS },
        arriving,
        who: 'test',
        advice: 'none',
      }
    );
  const free = lay(0);
  const dear = lay(1200);
  assert.deepEqual(shape(dear), shape(free));
  const tacks = countTacks(dear);
  assert.ok(tacks >= 1, `tacks ${tacks}`);
  assert.ok(
    Math.abs(dear.totalTimeS - free.totalTimeS - 1200 * tacks) < 1,
    `${dear.totalTimeS} − ${free.totalTimeS} s for ${tacks} tack(s)`
  );
  // Arriving on the first piece's own tack changes nothing; arriving on the other tack costs one more.
  const first = dear.waypoints[1].cogDeg;
  const onTack = lay(1200, { cogDeg: first, mode: 'sailing' });
  const offTack = lay(1200, { cogDeg: 360 - first, mode: 'sailing' });
  assert.equal(onTack.totalTimeS, dear.totalTimeS);
  assert.ok(tackBetween(360 - first, first, 0), 'the mirrored course is the other tack');
  assert.ok(Math.abs(offTack.totalTimeS - dear.totalTimeS - 1200) < 1, `${offTack.totalTimeS} vs ${dear.totalTimeS}`);
});

test('smoother: a shortcut is timed with its own tack charge, and the leg after it with the one it now owes', () => {
  // Wind from the north. Legs: W0→W1 on 60° (starboard, 8 km), W1→W2 on 300° (port, 2 km: a tack at W1), W2→W3 on
  // 320° (port: no tack at W2), W3→W4 on 300° (port). An islet on the line W2→W4 keeps that shortcut out, so the
  // backward pass (anchored at W4, then at W2) takes W0→W2: about 46°, starboard, from the route's start (nothing to
  // tack against), and W2 is now arrived at on a starboard course, so the leg out of it owes the tack it did not.
  const P = 600;
  const sim = { ...SIM, tackPenaltyS: P };
  const w = wind(0);
  const pt = (from: [number, number], brg: number, m: number): [number, number] => projectAlongBearing(from[0], from[1], brg, m);
  const p0: [number, number] = [0.5, 0.2];
  const p1 = pt(p0, 60, 8000);
  const p2 = pt(p1, 300, 2000);
  const p3 = pt(p2, 320, 5000);
  const p4 = pt(p3, 300, 5000);
  const pts = [p0, p1, p2, p3, p4];
  // The islet: 220 m across at the midpoint of W2→W4 (about 600 m off W3's legs), on a 110 m raster.
  const mid: [number, number] = [(p2[0] + p4[0]) / 2, (p2[1] + p4[1]) / 2];
  const c = [
    mid[0] - 0.001,
    mid[1] - 0.001,
    mid[0] + 0.001,
    mid[1] - 0.001,
    mid[0] + 0.001,
    mid[1] + 0.001,
    mid[0] - 0.001,
    mid[1] + 0.001,
    mid[0] - 0.001,
    mid[1] - 0.001,
  ];
  const islet = {
    recordNumber: 1,
    minLon: mid[0] - 0.001,
    minLat: mid[1] - 0.001,
    maxLon: mid[0] + 0.001,
    maxLat: mid[1] + 0.001,
    rings: [
      { coords: Float64Array.from(c), minLon: mid[0] - 0.001, minLat: mid[1] - 0.001, maxLon: mid[0] + 0.001, maxLat: mid[1] + 0.001 },
    ],
  };
  const land = LandMask.fromPolygons([islet], { west: 0.3, south: 0.1, east: 0.8, north: 0.5 }, 0.001);
  // The route as the search would have timed it: each leg simulated from the one before, each tack charged.
  const wps: Waypoint[] = [{ lon: p0[0], lat: p0[1], time: T0, sogMs: 0, cogDeg: 0, mode: 'motoring' }];
  let before: LegArrival | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = wps[i - 1];
    assert.ok(!land.legCrossesLandExact(a.lon, a.lat, pts[i][0], pts[i][1]), `leg ${i} is clear of the islet`);
    const r = simulateLegTime(a.lon, a.lat, a.time, pts[i][0], pts[i][1], VESSEL, POLAR, w, new NoCurrent(), sim);
    assert.ok(Number.isFinite(r.seconds) && r.dominantMode === 'sailing', `leg ${i} sails`);
    const cog = haversineBearing(a.lon, a.lat, pts[i][0], pts[i][1]);
    const charge = tackChargeS(before, 0, cog, true, sim);
    wps.push({
      lon: pts[i][0],
      lat: pts[i][1],
      time: new Date(a.time.getTime() + (r.seconds + charge) * 1000),
      sogMs: 0,
      cogDeg: cog,
      mode: 'sailing',
    });
    before = { cogDeg: cog, mode: 'sailing' };
  }
  assert.ok(land.legCrossesLandExact(p2[0], p2[1], p4[0], p4[1]), 'the islet blocks W2→W4');
  const t2 = wps[2].time.getTime();
  const t3 = wps[3].time.getTime();
  const t4 = wps[4].time.getTime();
  const route: Route = {
    waypoints: wps,
    totalTimeS: (t4 - T0.getTime()) / 1000,
    totalDistanceM: 0,
    motoringTimeS: 0,
    sailingTimeS: 0,
    validated: true,
  };
  const dropped = shortcutSmoother(route, { land, vessel: VESSEL, polar: POLAR, wind: w, current: new NoCurrent(), sim, tolerance: 0.05 });
  assert.equal(dropped, 1);
  assert.deepEqual(
    route.waypoints.map(q => [q.lon, q.lat]),
    [p0, p2, p3, p4],
    'W1 went'
  );
  const [W0, W2, W3, W4] = route.waypoints;
  const cut = simulateLegTime(W0.lon, W0.lat, W0.time, W2.lon, W2.lat, VESSEL, POLAR, w, new NoCurrent(), sim);
  const t2New = W0.time.getTime() + cut.seconds * 1000;
  assert.ok(Math.abs(W2.time.getTime() - t2New) < 1000, 'the shortcut from the start owes no tack');
  assert.ok(t2New < t2, 'and is quicker than the two legs it replaced');
  // W3 and W4 move with W2, plus the tack the leg out of W2 now owes (starboard in, port out).
  const shift = t2New - t2 + P * 1000;
  assert.ok(Math.abs(W3.time.getTime() - (t3 + shift)) < 1000, `W3 ${W3.time.toISOString()}`);
  assert.ok(Math.abs(W4.time.getTime() - (t4 + shift)) < 1000, `W4 ${W4.time.toISOString()}`);
});
