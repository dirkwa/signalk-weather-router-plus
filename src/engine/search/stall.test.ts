/**
 * The stall detector measures progress along the water (docs/plans/stall-progress-along-water.md, 2026-11-01).
 * Measured straight through land, a branch pressed against a wall a few km short of the destination set the mark,
 * the detour round the wall counted as no progress, and the rule stopped a search whose front was through the gap
 * and closing: the case below failed "boxed in" with 12 stages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../../geo/landmask';
import type { ShapePolygon } from '../../geo/shapefile';
import { OceanPropagator } from '../propagator';
import { makeVessel } from '../../vessel/vessel';
import { haversineDistanceM } from '../../geo/geodesy';
import { cumulativeM } from './skeleton';
import type { SearchContext } from './types';
import { buildGuide } from './zones';

function rect(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number): ShapePolygon {
  const c = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return {
    recordNumber,
    minLon: lon0,
    minLat: lat0,
    maxLon: lon1,
    maxLat: lat1,
    rings: [{ coords: Float64Array.from(c), minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1 }],
  };
}
const BOX = { west: 0, south: 0, east: 0.6, north: 0.6 };
const T0 = new Date('2026-01-01T00:00:00Z');
const DEG_PER_M = 1 / 111_195;

/** An east–west wall of land 1.1 km thick across the box at lat 0.20, with one gap of `gapM` at lon 0.40. */
function wall(gapM: number): LandMask {
  const g = gapM * DEG_PER_M;
  return LandMask.fromPolygons([rect(1, 0, 0.2, 0.4, 0.21), rect(2, 0.4 + g, 0.2, 0.6, 0.21)], BOX, 0.001);
}

test('a detour along a wall to a gap 33 km away is progress along the water: the route is found with few stages', () => {
  // Start and destination 22 km apart, the wall between them; the skeleton runs east along the wall, through the
  // 1 km gap and back west: 74 km. With 12 stages the straight-line rule stopped the search at the planned stages'
  // end, 16.7 km out with the front through the gap (measured 2026-11-01).
  for (const [gapM, stages] of [
    [1000, 12],
    [1000, 30],
    [2000, 12],
    [5000, 12],
  ] as const) {
    const lines: string[] = [];
    const r = new OceanPropagator(wall(gapM), { stages, subsectors: 20, headings: 30 }).computeRoute({
      start: [0.1, 0.1],
      end: [0.1, 0.3],
      departureTime: T0,
      vessel: makeVessel({ motorSpeedMs: 3 }),
      modePolicy: 'motor',
      onProgress: (_s, _t, m) => lines.push(m),
    });
    const g = gapM * DEG_PER_M;
    assert.ok(
      r.waypoints.some(w => w.lon > 0.4 - 0.002 && w.lon < 0.4 + g + 0.002 && w.lat > 0.19 && w.lat < 0.22),
      `gap ${gapM} m, ${stages} stages: a waypoint in the gap`
    );
    const last = r.waypoints[r.waypoints.length - 1];
    assert.ok(Math.abs(last.lon - 0.1) < 1e-6 && Math.abs(last.lat - 0.3) < 1e-6, 'arrives');
    assert.ok(!lines.some(m => /boxed in/.test(m)), `gap ${gapM} m, ${stages} stages: not boxed in`);
  }
});

test('a round trip in one search: the way home is measured along the skeleton home, not to the start the route left', () => {
  // Start A, a waypoint's circle at B 111 km east, end A: the skeleton goes out and back, so A is its first point and
  // its last. The goal lookup took the first, and every branch on the way home read about 2 km left (measured
  // 2026-11-01, PR #91 review): no progress, so a homeward half needing more than the planned stages was refused as
  // boxed in while closing on home.
  const A = { lon: 0, lat: 0 };
  const B = { lon: 1, lat: 0 };
  const out: { lon: number; lat: number }[] = [];
  for (let i = 0; i <= 10; i++) out.push({ lon: i / 10, lat: 0 });
  const skeleton = [...out, ...out.slice(0, -1).reverse()];
  const guide = buildGuide(
    {
      progress: () => {},
      eLon: A.lon,
      eLat: A.lat,
      goals: [
        { ...B, radiusM: 500 },
        { ...A, radiusM: 0 },
      ],
      K: 20,
      budget: { deltaD: 5000, candStepM: 11000 },
    } as unknown as SearchContext,
    { skeleton, skeletonCum: cumulativeM(skeleton), widths: null }
  );
  // Out: the whole way to B from A, nothing left at B.
  assert.ok(Math.abs(guide.remainingM(A.lon, A.lat, 0) - haversineDistanceM(A.lon, A.lat, B.lon, B.lat)) < 1, 'at A, heading for B');
  assert.ok(guide.remainingM(B.lon, B.lat, 0) < 1, 'at B, heading for B');
  // Home: the whole way back from B, falling the whole way, nothing left at A.
  assert.ok(Math.abs(guide.remainingM(B.lon, B.lat, 1) - haversineDistanceM(A.lon, A.lat, B.lon, B.lat)) < 1, 'at B, heading home');
  let last = Infinity;
  for (const lon of [0.9, 0.7, 0.5, 0.3, 0.1]) {
    const left = guide.remainingM(lon, 0.02, 1);
    assert.ok(left < last - 20_000, `homeward at lon ${lon}: ${(left / 1000).toFixed(1)} km left, less than at the point before`);
    last = left;
  }
  assert.ok(guide.remainingM(A.lon, A.lat, 1) < 1, 'home');
});

test('a front that cannot get on is still refused as boxed in, and the words say how close it came', () => {
  // The same wall with no gap: nothing gets through; the refusal names the stall.
  const land = LandMask.fromPolygons([rect(1, 0, 0.2, 0.6, 0.21)], BOX, 0.001);
  assert.throws(
    () =>
      new OceanPropagator(land, { stages: 12, subsectors: 20, headings: 30 }).computeRoute({
        start: [0.1, 0.1],
        end: [0.1, 0.3],
        departureTime: T0,
        vessel: makeVessel({ motorSpeedMs: 3 }),
        modePolicy: 'motor',
      }),
    (e: Error) => /boxed in|could not make progress|stopped by land/.test(e.message)
  );
});
