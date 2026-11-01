/**
 * Cross-track polish (docs/drafts/routing-thought-experiment.md, Idea 3,
 * done gradient-free): the search and the tack layout give a polyline
 * whose waypoints sit on the search's grid; this moves each interior
 * waypoint sideways where that lowers the route's true arrival time plus
 * the cost the search chose its legs on (the comfort cost, the surcharge
 * for time over a limit set to avoid), so it never moves the route back
 * into water the search paid to stay out of.
 *
 * Why not the draft's adjoint: that needs a differentiable forward
 * model, and the leg simulator is not one (sub-steps, mode switches,
 * polar table lookups, forecast interpolation kinks); a finite-difference
 * gradient over hundreds of headings would cost hundreds of full-route
 * simulations per step. Trying a few offsets per waypoint and keeping the
 * best costs about one re-timing of the route per offset.
 *
 * Per pass, for each interior waypoint that is not a user via: offsets of
 * POLISH_OFFSETS_M to either side, perpendicular to the straight line
 * between its neighbours, capped at a third of the shorter adjacent leg;
 * a move is kept when the whole route re-timed from there costs at least
 * POLISH_MIN_GAIN_S less (arrival plus the legs' cost) and both adjacent
 * legs are clear of land and sailable. Passes repeat until one moves
 * nothing, at most POLISH_MAX_PASSES.
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import type { LandTest } from '../../geo/landmask';
import type { Waypoint } from '../route';

export const POLISH_OFFSETS_M = [2000, 1000, 500, 250];
export const POLISH_MAX_PASSES = 5;
/** A move has to gain at least this to be kept (seconds). */
export const POLISH_MIN_GAIN_S = 1;

export interface PolishResult {
  passes: number;
  moved: number;
  /** Arrival time gained, seconds. */
  gainedS: number;
}

/**
 * `timeLeg(a, b, prev)` sets b's time (and mode) from a's and returns the leg's
 * cost beyond its time (seconds: the comfort cost and the surcharge for
 * time over a limit set to avoid; 0 without either), or null when the leg
 * cannot be sailed. `prev` is the waypoint before a (null at the first), so
 * the leg's tack penalty against the course into a is charged as it is
 * everywhere else. The waypoints are moved and re-timed in place.
 */
export function crossTrackPolish(
  wps: Waypoint[],
  land: LandTest,
  timeLeg: (a: Waypoint, b: Waypoint, prev: Waypoint | null) => number | null
): PolishResult {
  const n = wps.length;
  const res: PolishResult = { passes: 0, moved: 0, gainedS: 0 };
  if (n < 3) return res;
  // The route re-timed from waypoint k on: its arrival (ms) and its cost, the arrival plus the legs' cost from there.
  const costFrom = (list: Waypoint[], k: number): { arrival: number; cost: number } => {
    let penaltyS = 0;
    for (let i = k; i < list.length; i++) {
      const p = timeLeg(list[i - 1], list[i], i >= 2 ? list[i - 2] : null);
      if (p === null) return { arrival: Infinity, cost: Infinity };
      penaltyS += p;
    }
    const arrival = list[list.length - 1].time.getTime();
    return { arrival, cost: arrival + penaltyS * 1000 };
  };
  for (let pass = 0; pass < POLISH_MAX_PASSES; pass++) {
    res.passes++;
    let movedThisPass = 0;
    for (let k = 1; k < n - 1; k++) {
      const p = wps[k];
      if (p.role === 'via') continue;
      const a = wps[k - 1];
      const c = wps[k + 1];
      const cap = Math.min(haversineDistanceM(a.lon, a.lat, p.lon, p.lat), haversineDistanceM(p.lon, p.lat, c.lon, c.lat)) / 3;
      const brg = haversineBearing(a.lon, a.lat, c.lon, c.lat);
      // As it stands (the same positions re-timed: the same times, and the legs' cost).
      const current = costFrom(wps, k);
      let best: { list: Waypoint[]; arrival: number; cost: number } | null = null;
      for (const off of POLISH_OFFSETS_M) {
        if (off > cap) continue;
        for (const side of [90, -90]) {
          const [lon, lat] = projectAlongBearing(p.lon, p.lat, brg + side, off);
          if (land.legCrossesLandExact(a.lon, a.lat, lon, lat) || land.legCrossesLandExact(lon, lat, c.lon, c.lat)) continue;
          // Trial copy from this waypoint on (times and modes change downstream).
          const trial = wps.map((w, i) => (i >= k ? { ...w } : w));
          trial[k].lon = lon;
          trial[k].lat = lat;
          const t = costFrom(trial, k);
          if (t.cost < (best ? best.cost : current.cost - POLISH_MIN_GAIN_S * 1000)) best = { list: trial, ...t };
        }
      }
      if (best) {
        res.gainedS += (current.arrival - best.arrival) / 1000;
        for (let i = k; i < n; i++) wps[i] = best.list[i];
        movedThisPass++;
      }
    }
    res.moved += movedThisPass;
    if (!movedThisPass) break;
  }
  return res;
}
