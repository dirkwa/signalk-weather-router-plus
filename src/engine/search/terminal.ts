/**
 * Terminal choice: the candidate whose simulated final leg (straight, or a beat to windward) arrives earliest, and that final leg.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import { norm360, twaFromHeading } from '../../geo/angles';
import { DEG, M_PER_DEG, NM_M } from '../../geo/units';
import type { CurrentSource, WindSource } from '../environment';
import { simulateLegTime, tackChargeS, type LegSimResult, type ModePolicy, type SimOptions } from '../legsim';
import type { PolarDiagram } from '../../vessel/polar';
import type { VesselParams } from '../../vessel/vessel';
import { cellOf, LandMask, type CellMask } from '../../geo/landmask';
import { waterFieldOver } from '../mesh/waters';
import { forecastNote, tryNote } from './context';
import { RouteError, TERMINAL_EVAL, ViasNotCrossedError, type Candidate, type SearchContext } from './types';
import type { SkeletonGuide } from './zones';

export interface Terminal {
  bestC: Candidate;
  stageOfBest: number;
  /** The tack point of a final beat, when any. */
  tackCand: Candidate | null;
  /** The end of the final leg (null when the leg ends at bestC, inside the arrival circle). */
  finalCand: Candidate | null;
  /** The final approach along the water path (waterApproach), after bestC, ending at the end; tackCand and finalCand are then null. */
  approach?: Candidate[];
}

/**
 * The last part of an open stretch that ends where the leg joins a chart mesh (`args.endApproach` 'water'), when no
 * clear straight final leg reaches that point: the shortest path over water to it on the search's own raster (the
 * coastline land as the search sees it, the meshes' water among it), from the front's candidate with the least cost
 * so far plus the path's length at cruise speed (the bin cost's measure, search/stages.ts, with the water path in
 * place of the straight remaining distance). The path is walked down the distance field cell by cell, cut to the
 * fewest straight moves the search's own land test lets through, and each move timed under the search's rules. Null
 * when the water does not reach the front, or a move cannot be made: the caller fails as it would have.
 */
function waterApproach(ctx: SearchContext, stages: Candidate[][]): { bestC: Candidate; stageOfBest: number; approach: Candidate[] } | null {
  const { landMask, eLon, eLat, cruise, vessel, polar, wind, current, simOpts, progress } = ctx;
  let stageOfBest = stages.length - 1;
  while (stageOfBest > 0 && stages[stageOfBest].length === 0) stageOfBest--;
  const front = stages[stageOfBest].filter(c => c.viaCount === ctx.nVias);
  if (!front.length) return null;
  // The coastline raster (a view of it with the meshes' water as land, pipeline.ts); a search on other land (a mesh
  // stretch's, mesh/legrun.ts) has no raster to walk.
  if (!(landMask instanceof LandMask)) return null;
  const r = landMask.resolutionDeg;
  // The raster's grid, for cellOf (which reads no cells).
  const grid: CellMask = { nx: landMask.nx, ny: landMask.ny, resolutionDeg: r, bbox: landMask.bbox, cells: new Uint8Array(0) };
  const endCell = cellOf(grid, eLon, eLat);
  if (endCell < 0) return null;
  const frontCells = front.map(c => cellOf(grid, c.lon, c.lat));
  // The field over a window of the raster round the front and the end, not the whole raster (4 bytes a cell: the
  // search's world can be 25 M cells; PR #91 review): the window is the box of their cells padded by `padM` on each
  // side, first one stage step. The answer is exact when the best candidate's distance by water is at most the pad:
  // any path leaving the window runs at least the pad out and back, so none outside is shorter. Otherwise the pad
  // doubles and the field is walked again, up to the whole raster.
  const walk = (padM: number): { w: Window; field: Float32Array; bestC: Candidate | null; bestM: number } | null => {
    const w = windowOf(grid, [endCell, ...frontCells.filter(c => c >= 0)], padM);
    const field = waterFieldOver(
      w.grid,
      c => {
        const [lon, lat] = w.centre(c);
        return !landMask.isLand(lon, lat);
      },
      w.local(endCell)
    );
    if (!field) return null;
    let bestC: Candidate | null = null;
    let bestCost = Infinity;
    let bestM = Infinity;
    front.forEach((c, k) => {
      const cell = frontCells[k];
      const d = cell >= 0 ? field[w.local(cell)] : Infinity;
      if (!Number.isFinite(d)) return;
      const cost = c.costS + d / cruise;
      if (cost < bestCost) {
        bestCost = cost;
        bestM = d;
        bestC = c;
      }
    });
    return { w, field, bestC, bestM };
  };
  let padM = ctx.budget.candStepM;
  let got = walk(padM);
  while (got && !(got.bestC && got.bestM <= padM) && !got.w.whole) {
    padM *= 2;
    got = walk(padM);
  }
  if (!got || !got.bestC) return null;
  const { w, field } = got;
  const bestC: Candidate = got.bestC;
  const { nx, ny } = w.grid;
  const free = (c: number): boolean => {
    const [lon, lat] = w.centre(c);
    return !landMask.isLand(lon, lat);
  };
  // Down the field to the end: the neighbour nearest it by water at each step (the field's own moves).
  const cells: number[] = [];
  const endLocal = w.local(endCell);
  let cur = w.local(cellOf(grid, bestC.lon, bestC.lat));
  while (cur !== endLocal) {
    const i = cur % nx;
    const j = Math.floor(cur / nx);
    let next = -1;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) continue;
        const n = jj * nx + ii;
        // The field's own moves only: water, and a diagonal where both cells beside it are water (waterFieldOver), so
        // the walk never slips between two land cells touching at a corner (PR #91 review).
        // The end's own cell is the field's source, passable whatever it is.
        if ((n !== endLocal && !free(n)) || (di !== 0 && dj !== 0 && (!free(j * nx + ii) || !free(jj * nx + i)))) continue;
        if (next < 0 || field[n] < field[next]) next = n;
      }
    if (next < 0 || !(field[next] < field[cur])) return null;
    cur = next;
    if (cur !== endLocal) cells.push(cur);
  }
  const path: [number, number][] = [[bestC.lon, bestC.lat], ...cells.map(c => w.centre(c)), [eLon, eLat]];
  // The fewest straight moves: from each point, the farthest one ahead whose move is clear.
  const pts: [number, number][] = [path[0]];
  let k = 0;
  const crosses = (a: [number, number], b: [number, number]): boolean =>
    landMask.legsCrossLandBulk(Float64Array.of(a[0]), Float64Array.of(a[1]), Float64Array.of(b[0]), Float64Array.of(b[1]))[0] !== 0;
  while (k < path.length - 1) {
    // One cell on, unless that move crosses land too: then the water path is no way (the search fails as it would have).
    if (crosses(path[k], path[k + 1])) return null;
    let far = k + 1;
    for (let q = path.length - 1; q > k + 1; q--) {
      const hit = landMask.legsCrossLandBulk(
        Float64Array.of(path[k][0]),
        Float64Array.of(path[k][1]),
        Float64Array.of(path[q][0]),
        Float64Array.of(path[q][1])
      );
      if (!hit[0]) {
        far = q;
        break;
      }
    }
    pts.push(path[far]);
    k = far;
  }
  const approach: Candidate[] = [];
  let from = bestC;
  let lengthM = 0;
  for (let q = 1; q < pts.length; q++) {
    const [lon, lat] = pts[q];
    const sim = simulateLegTime(from.lon, from.lat, new Date(from.timeMs), lon, lat, vessel, polar, wind, current, simOpts);
    if (!Number.isFinite(sim.seconds) || sim.seconds <= 0) return null;
    lengthM += haversineDistanceM(from.lon, from.lat, lon, lat);
    from = hopCandidate(from, lon, lat, sim, hopCharge(ctx, from, lon, lat, sim));
    approach.push(from);
  }
  progress(
    stages.length - 1,
    stages.length - 1,
    `final approach along the water path to where the leg joins the charts: {distance:${Math.round(lengthM)}} in ${approach.length} move(s), no clear straight final leg`
  );
  return { bestC, stageOfBest, approach };
}

/** A window of a raster's cells: its own grid, and the mapping of a cell of the whole raster to the window and back. */
interface Window {
  grid: CellMask;
  /** The window is the whole raster. */
  whole: boolean;
  /** The window's cell index of a raster cell (which must lie in the window). */
  local(c: number): number;
  /** Centre of a window cell, degrees. */
  centre(c: number): [number, number];
}

/** The window of `grid` round the given cells, padded by `padM` metres each way (east-west at the box's widest latitude), clipped to the raster. */
function windowOf(grid: CellMask, cells: number[], padM: number): Window {
  const { nx, ny, resolutionDeg: r } = grid;
  let i0 = Infinity;
  let i1 = -Infinity;
  let j0 = Infinity;
  let j1 = -Infinity;
  for (const c of cells) {
    const i = c % nx;
    const j = (c - i) / nx;
    i0 = Math.min(i0, i);
    i1 = Math.max(i1, i);
    j0 = Math.min(j0, j);
    j1 = Math.max(j1, j);
  }
  const padJ = Math.ceil(padM / (r * M_PER_DEG));
  const latEdge = Math.max(Math.abs(grid.bbox.south + j0 * r), Math.abs(grid.bbox.south + (j1 + 1) * r));
  const padI = Math.ceil(padM / (r * M_PER_DEG * Math.max(0.05, Math.cos(latEdge * DEG))));
  const ia = Math.max(0, i0 - padI);
  const ib = Math.min(nx - 1, i1 + padI);
  const ja = Math.max(0, j0 - padJ);
  const jb = Math.min(ny - 1, j1 + padJ);
  const wnx = ib - ia + 1;
  const wny = jb - ja + 1;
  const west = grid.bbox.west + ia * r;
  const south = grid.bbox.south + ja * r;
  return {
    grid: {
      nx: wnx,
      ny: wny,
      resolutionDeg: r,
      bbox: { west, south, east: west + wnx * r, north: south + wny * r },
      cells: new Uint8Array(0),
    },
    whole: ia === 0 && ja === 0 && ib === nx - 1 && jb === ny - 1,
    local: c => {
      const i = c % nx;
      return ((c - i) / nx - ja) * wnx + (i - ia);
    },
    centre: c => {
      const i = c % wnx;
      return [west + (i + 0.5) * r, south + ((c - i) / wnx + 0.5) * r];
    },
  };
}

/**
 * The tack penalty a straight hop from `from` to (lon, lat) owes (legsim.ts tackChargeS): the wind where the hop
 * starts, `from`'s course and mode against the hop's. The same rule as the stage sweep (propose.ts), so a final hop,
 * a beat's legs and the water approach pay for a tack as every other move does.
 */
function hopCharge(ctx: SearchContext, from: Candidate, lon: number, lat: number, sim: LegSimResult): number {
  const [, wd] = ctx.wind.at(from.lon, from.lat, new Date(from.timeMs));
  return tackChargeS(from, wd, haversineBearing(from.lon, from.lat, lon, lat), sim.dominantMode === 'sailing', ctx.simOpts);
}

/** The candidate at the end of a simulated straight hop from `from` to (lon, lat), `chargeS` of tack penalty added (time, cost and sailing seconds). */
function hopCandidate(from: Candidate, lon: number, lat: number, sim: LegSimResult, chargeS: number): Candidate {
  const d = haversineDistanceM(from.lon, from.lat, lon, lat);
  const secs = sim.seconds + chargeS;
  return {
    lon,
    lat,
    timeMs: from.timeMs + secs * 1000,
    elapsedS: from.elapsedS + secs,
    costS: from.costS + secs + sim.penaltySeconds,
    parentIdx: -1,
    sogMs: d / secs,
    cogDeg: haversineBearing(from.lon, from.lat, lon, lat),
    mode: sim.dominantMode === 'sailing' ? 'sailing' : 'motoring',
    sailingS: sim.sailingSeconds + chargeS,
    motoringS: sim.motoringSeconds,
    viaCount: from.viaCount,
    viaIdxs: [],
  };
}

/**
 * The final hop to windward as a beat: when the straight bearing from `from`
 * to the goal lies inside the polar's no-go angle for the wind there, two
 * close-hauled legs (TWA = the polar's tightest sailable angle plus a small
 * margin) on either tack, meeting at the tack point the laylines give, in
 * whichever order is faster and clear of land. Null when the straight hop
 * can be sailed (or motored, in motor mode), or no beat is possible.
 */
/** A final leg shorter than this is no leg: the candidate is at the destination. */
export const MIN_FINAL_LEG_M = 1;

export function beatToWindward(
  ctx: SearchContext,
  from: Candidate,
  gLon: number,
  gLat: number,
  vessel: VesselParams,
  polar: PolarDiagram | null,
  wind: WindSource,
  current: CurrentSource,
  simOpts: SimOptions,
  modePolicy: ModePolicy
): { tack: Candidate; final: Candidate; d1: number; d2: number } | null {
  if (!polar || modePolicy === 'motor') return null;
  const [ws, wd] = wind.at(from.lon, from.lat, new Date(from.timeMs));
  if (!Number.isFinite(ws) || ws <= 0 || !Number.isFinite(wd)) return null;
  const D = haversineDistanceM(from.lon, from.lat, gLon, gLat);
  if (D < MIN_FINAL_LEG_M) return null;
  const theta = haversineBearing(from.lon, from.lat, gLon, gLat);
  const twa = twaFromHeading(theta, wd);
  const floor = polar.noGoFloor(ws);
  if (!(twa < floor)) return null; // the straight hop can be sailed
  // The tack angle: the polar's tightest sailable angle plus a margin. The
  // tightest beat (3°) is the shortest, but the wind at the start is not
  // the wind along a leg of tens of km: a shift of a few degrees towards
  // the heading puts the leg in the no-go angle and the beat fails (job
  // f993afa5, Gibraltar → Canaries: four candidates 27° off the wind, no
  // beat possible with 3°). Wider beats are tried too; the fastest that
  // sails on both legs wins.
  let best: { tack: Candidate; final: Candidate; d1: number; d2: number; total: number } | null = null;
  for (const margin of BEAT_MARGINS_DEG) {
    const beta = Math.min(89, floor + margin);
    const h1 = norm360(wd + beta);
    const h2 = norm360(wd - beta);
    const det = Math.sin((h1 - h2) * DEG);
    if (Math.abs(det) < 1e-9) continue;
    const d1 = (D * Math.sin((theta - h2) * DEG)) / det;
    const d2 = (D * Math.sin((h1 - theta) * DEG)) / det;
    if (!(d1 > 0 && d2 > 0)) continue;
    const orders: { hFirst: number; dFirst: number; hSecond: number; dSecond: number }[] = [
      { hFirst: h1, dFirst: d1, hSecond: h2, dSecond: d2 },
      { hFirst: h2, dFirst: d2, hSecond: h1, dSecond: d1 },
    ];
    for (const o of orders) {
      const [tLon, tLat] = projectAlongBearing(from.lon, from.lat, o.hFirst, o.dFirst);
      const cross = ctx.landMask.legsCrossLandBulk(
        Float64Array.of(from.lon, tLon),
        Float64Array.of(from.lat, tLat),
        Float64Array.of(tLon, gLon),
        Float64Array.of(tLat, gLat)
      );
      if (cross[0] || cross[1]) continue;
      const s1 = simulateLegTime(from.lon, from.lat, new Date(from.timeMs), tLon, tLat, vessel, polar, wind, current, simOpts);
      if (!Number.isFinite(s1.seconds) || s1.seconds <= 0) continue;
      // Each leg of the beat pays for its tack by the one rule (hopCharge): the first against the course the branch
      // arrived on (so the order that keeps the boat on its tack is cheaper), the second against the first.
      const tack = hopCandidate(from, tLon, tLat, s1, hopCharge(ctx, from, tLon, tLat, s1));
      const s2 = simulateLegTime(tLon, tLat, new Date(tack.timeMs), gLon, gLat, vessel, polar, wind, current, simOpts);
      if (!Number.isFinite(s2.seconds) || s2.seconds <= 0) continue;
      const final = hopCandidate(tack, gLon, gLat, s2, hopCharge(ctx, tack, gLon, gLat, s2));
      // Time, tack penalties and comfort cost: with a comfort weight the beat avoids the rougher tack.
      const total = final.costS - from.costS;
      if (!best || total < best.total) best = { tack, final, d1: o.dFirst, d2: o.dSecond, total };
    }
  }
  return best;
}

/** Margins (degrees) added to the polar's tightest sailable angle for the beat's two legs, tightest first. */
export const BEAT_MARGINS_DEG = [3, 8, 15, 25, 40];

export function chooseTerminal(ctx: SearchContext, guide: SkeletonGuide, stages: Candidate[][]): Terminal {
  const { args, wind, current, polar, vessel, modePolicy, simOpts, progress, checkCancel, eLon, eLat, snapToExact, nVias, limitNote } = ctx;
  const { kEff } = guide;
  // The front stalled near an end where the leg joins the charts (stages.ts kept the error): the water path, or that error.
  if (ctx.stallError) {
    const w = waterApproach(ctx, stages);
    if (!w) throw ctx.stallError;
    return { ...w, tackCand: null, finalCand: null };
  }
  const terminals = stages[stages.length - 1];
  if (terminals.length === 0) throw new RouteError('front went empty before reaching the destination; no path found');
  const score = (c: Candidate): [number, number] => [haversineDistanceM(c.lon, c.lat, eLon, eLat), c.costS];
  const pool = nVias > 0 ? terminals.filter(c => c.viaCount === nVias) : terminals;
  if (pool.length === 0) {
    const deepest = Math.max(0, ...terminals.map(c => c.viaCount));
    throw new ViasNotCrossedError(
      `finished ${stages.length - 1} stages without any branch crossing all ${nVias} via(s); deepest branch crossed ${deepest}. Widen the via radius, add stages, or move the via.`
    );
  }
  // Prefer terminals whose straight final leg is land-free.
  const poolHop = ctx.landMask.legsCrossLandBulk(
    Float64Array.from(pool.map(c => c.lon)),
    Float64Array.from(pool.map(c => c.lat)),
    new Float64Array(pool.length).fill(eLon),
    new Float64Array(pool.length).fill(eLat)
  );
  const clearPool = pool.filter((_c, i) => !poolHop[i]);
  const choose = clearPool.length ? clearPool : pool;
  // The nearest candidate (elapsed time as tie-break), kept as the fallback.
  let bestC = choose[0];
  for (const c of choose) {
    const [d, t] = score(c);
    const [bd, bt] = score(bestC);
    if (d < bd || (d === bd && t < bt)) bestC = c;
  }
  const nearest = bestC;
  // Where a candidate's final leg ends: the exact destination, or
  // (approximate intermediate waypoint) only as far as the arrival circle;
  // null when the candidate is already inside the circle.
  const hopEndFor = (c: Candidate): [number, number] | null => {
    const d = haversineDistanceM(c.lon, c.lat, eLon, eLat);
    if (snapToExact) return [eLon, eLat];
    const r = args.arrivalRadiusM!;
    if (d <= r) return null;
    return projectAlongBearing(c.lon, c.lat, haversineBearing(c.lon, c.lat, eLon, eLat), d - r + Math.min(1, 0.001 * r));
  };
  // The choice that matters: the candidate whose predicted arrival is
  // earliest once its final leg (straight, or a beat when the straight hop
  // is in the no-go angle) is simulated, not the nearest one. Candidates
  // advance a fixed distance per stage, so a slow branch crawling straight
  // at the goal is nearest when the search stops while faster branches
  // that tacked are further out but hours ahead (job e6e338f6, leg 5: the
  // nearest branch 3.5 km out at 9.85 h, four tacking branches 12–14 km
  // out at about 5 h). Nearest first, at most TERMINAL_EVAL simulated.
  // Why a candidate's final leg failed, for the error when none succeeds.
  type FailWhy = 'land' | 'limited' | 'no_go' | 'current' | 'no_speed';
  const fails = new Map<Candidate, FailWhy>();
  const planFor = (c: Candidate) => {
    const hopEnd = hopEndFor(c);
    // arrivalS: the real arrival (reported); costS: arrival plus comfort cost (compared).
    if (!hopEnd) return { hopEnd: null, beat: null, sim: null, chargeS: 0, arrivalS: c.elapsedS, costS: c.costS };
    if (!snapToExact) {
      const cross = ctx.landMask.legsCrossLandBulk(
        Float64Array.of(c.lon),
        Float64Array.of(c.lat),
        Float64Array.of(hopEnd[0]),
        Float64Array.of(hopEnd[1])
      );
      if (cross[0]) {
        fails.set(c, 'land');
        return null;
      }
    }
    const beat = beatToWindward(ctx, c, hopEnd[0], hopEnd[1], vessel, polar, wind, current, simOpts, modePolicy);
    if (beat) return { hopEnd, beat, sim: null, chargeS: 0, arrivalS: beat.final.elapsedS, costS: beat.final.costS };
    const sim = simulateLegTime(c.lon, c.lat, new Date(c.timeMs), hopEnd[0], hopEnd[1], vessel, polar, wind, current, simOpts);
    if (!Number.isFinite(sim.seconds) || sim.seconds <= 0) {
      fails.set(c, sim.reason ?? 'no_speed');
      return null;
    }
    // The straight hop's tack penalty, when it puts the wind on the other side of the boat from the branch's last
    // course: in the arrival and in the cost the branches are ranked on, so a branch is not chosen for a final tack
    // it does not pay for.
    const chargeS = hopCharge(ctx, c, hopEnd[0], hopEnd[1], sim);
    return {
      hopEnd,
      beat: null,
      sim,
      chargeS,
      arrivalS: c.elapsedS + sim.seconds + chargeS,
      costS: c.costS + sim.seconds + chargeS + sim.penaltySeconds,
    };
  };
  type FinalPlan = NonNullable<ReturnType<typeof planFor>>;
  const plans = new Map<Candidate, FinalPlan>();
  // The failures of every evaluated final leg, with the conditions at the
  // nearest candidate: what the user needs when no final leg can be sailed.
  const failNote = (): string => {
    if (fails.size === 0) return '';
    const n = (w: FailWhy): number => [...fails.values()].filter(v => v === w).length;
    const parts: string[] = [];
    if (n('limited')) parts.push(`${n('limited')} over the wind/wave limit`);
    if (n('no_go')) parts.push(`${n('no_go')} dead upwind with no beat possible (the polar's no-go angle)`);
    if (n('current')) parts.push(`${n('current')} stopped by a current stronger than the boat's speed`);
    if (n('no_speed')) parts.push(`${n('no_speed')} with no boat speed`);
    if (n('land')) parts.push(`${n('land')} crossing land`);
    const [ws, wd] = wind.at(nearest.lon, nearest.lat, new Date(nearest.timeMs));
    const [cu, cv] = current.at(nearest.lon, nearest.lat, new Date(nearest.timeMs));
    const brg = haversineBearing(nearest.lon, nearest.lat, eLon, eLat);
    const cond = `at the nearest (${(score(nearest)[0] / 1000).toFixed(1)} km out, ${new Date(nearest.timeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC): final leg bearing ${brg.toFixed(0)}°, wind ${ws.toFixed(1)} m/s from ${wd.toFixed(0)}°, current ${Math.hypot(cu, cv).toFixed(2)} m/s towards ${norm360((Math.atan2(cu, cv) * 180) / Math.PI).toFixed(0)}°`;
    return ` Of the ${fails.size} final legs tried: ${parts.join(', ')}; ${cond}.`;
  };
  if (clearPool.length) {
    const byDist = [...clearPool].sort((a, b) => score(a)[0] - score(b)[0]).slice(0, TERMINAL_EVAL);
    for (const c of byDist) {
      checkCancel();
      const plan = planFor(c);
      if (plan) plans.set(c, plan);
    }
    let earliest: Candidate | null = null;
    for (const [c, plan] of plans) {
      if (earliest === null) {
        earliest = c;
        continue;
      }
      const e = plans.get(earliest)!;
      if (plan.costS < e.costS || (plan.costS === e.costS && score(c)[0] < score(earliest)[0])) earliest = c;
    }
    if (earliest !== null) bestC = earliest;
    if (bestC !== nearest) {
      const np = plans.get(nearest);
      progress(
        Math.max(kEff, stages.length - 1),
        Math.max(kEff, stages.length - 1),
        `final choice: the branch ${args.comfortWeight && args.comfortWeight > 0 ? 'with the least time plus comfort cost, arriving' : 'arriving earliest'} (${(plans.get(bestC)!.arrivalS / 3600).toFixed(1)} h, from ${(score(bestC)[0] / 1000).toFixed(1)} km out) over the nearest (${(score(nearest)[0] / 1000).toFixed(1)} km out${np ? `, arriving ${(np.arrivalS / 3600).toFixed(1)} h` : ', no sailable final leg'})`
      );
    }
  }
  const stageOfBest = stages.findIndex(st => st.includes(bestC));
  const bestPlan = plans.get(bestC);

  // Final straight leg: to the exact destination, or (approximate
  // intermediate waypoint) only as far as the arrival circle.
  checkCancel();
  const bestDist = haversineDistanceM(bestC.lon, bestC.lat, eLon, eLat);
  const hopEnd: [number, number] | null = hopEndFor(bestC);
  let finalCand: Candidate | null = null;
  let tackCand: Candidate | null = null;
  if (hopEnd) {
    const [hLon, hLat] = hopEnd;
    const finalCross = ctx.landMask.legsCrossLandBulk(
      Float64Array.of(bestC.lon),
      Float64Array.of(bestC.lat),
      Float64Array.of(hLon),
      Float64Array.of(hLat)
    );
    if (finalCross[0] && args.endApproach === 'water') {
      const w = waterApproach(ctx, stages);
      if (w) return { ...w, tackCand: null, finalCand: null };
    }
    if (finalCross[0]) {
      throw new RouteError(
        `terminal hop from (${bestC.lat.toFixed(4)}, ${bestC.lon.toFixed(4)}) to the destination crosses land; the propagation got close but the straight final leg is blocked. Try a via point or a closer endpoint.`
      );
    }
    // To windward: the straight hop lies inside the polar's no-go angle, so
    // beat to it on two close-hauled legs meeting at a tack point (the
    // laylines), in whichever order is faster and clear of land. Only a hop
    // that cannot be sailed at all is beaten; everything else stays straight.
    const beat = bestPlan ? bestPlan.beat : beatToWindward(ctx, bestC, hLon, hLat, vessel, polar, wind, current, simOpts, modePolicy);
    if (beat) {
      tackCand = beat.tack;
      finalCand = beat.final;
      progress(
        Math.max(kEff, stages.length - 1),
        Math.max(kEff, stages.length - 1),
        `final approach is to windward: beating to the waypoint on two tacks, ${(beat.d1 / NM_M).toFixed(1)} nm then ${(beat.d2 / NM_M).toFixed(1)} nm`
      );
    } else {
      const simFinal =
        bestPlan && bestPlan.sim
          ? bestPlan.sim
          : simulateLegTime(bestC.lon, bestC.lat, new Date(bestC.timeMs), hLon, hLat, vessel, polar, wind, current, simOpts);
      if (!Number.isFinite(simFinal.seconds) || simFinal.seconds <= 0) {
        // From far away (more than two stage steps) the straight hop was
        // never going to work: the search ran its budget out boxed in.
        if (bestDist > 2 * guide.stepFor(bestC.lon, bestC.lat).step) {
          throw new RouteError(
            `the search ran out of stages ${(bestDist / 1000).toFixed(0)} km from the destination, boxed in; ${tryNote(ctx)}; the straight final leg from there is stuck under ${modePolicy}${limitNote}.${forecastNote(ctx)}`,
            'boxed_in'
          );
        }
        throw new RouteError(
          `terminal hop to the destination could not be simulated (stuck under ${modePolicy} given wind/current at the destination${limitNote}).${failNote()}${forecastNote(ctx)}`
        );
      }
      const legDistFinal = haversineDistanceM(bestC.lon, bestC.lat, hLon, hLat);
      if (legDistFinal > 0)
        finalCand = hopCandidate(
          bestC,
          hLon,
          hLat,
          simFinal,
          bestPlan && bestPlan.sim ? bestPlan.chargeS : hopCharge(ctx, bestC, hLon, hLat, simFinal)
        );
    }
  }
  if (!snapToExact) {
    const endAt = finalCand ?? bestC;
    progress(
      Math.max(kEff, stages.length - 1),
      Math.max(kEff, stages.length - 1),
      `leg ends inside the ${args.arrivalRadiusM!.toFixed(0)} m circle, ${haversineDistanceM(endAt.lon, endAt.lat, eLon, eLat).toFixed(0)} m from the waypoint${finalCand ? ' (straight hop from the last stage to the circle)' : ''}`
    );
  }
  return { bestC, stageOfBest, tackCand, finalCand };
}
