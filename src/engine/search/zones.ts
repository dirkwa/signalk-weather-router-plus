/**
 * Narrow passages (step limits, extra stages, narrow-bin zones) and the skeleton guide the proposal and pruning consult.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { haversineBearing, haversineDistanceM, perpendicularOffsetM, projectAlongBearing } from '../../geo/geodesy';
import { unwrapLonNear } from '../../geo/angles';
import { M_PER_DEG } from '../../geo/units';
import { MIN_STEP_M, STEP_PER_WIDTH } from '../corridor';
import type { SkeletonData } from './skeleton';
import { NARROW_BINS, type SearchContext } from './types';

export interface SkeletonGuide extends SkeletonData {
  nSk: number;
  /** Largest step allowed from each skeleton point (≤ candStepM). */
  stepAt: Float64Array;
  zones: { a: number; b: number; west: number; east: number; south: number; north: number }[];
  extraStages: number;
  /** Stages planned (K plus what the narrow passages cost). */
  kEff: number;
  /** Hard stage ceiling. */
  maxStages: number;
  nearestSkeleton(pLon: number, pLat: number, from?: number, to?: number): number;
  /** Step for a parent at a position (candStepM without a skeleton). */
  stepFor(pLon: number, pLat: number): { step: number; idx: number };
  /**
   * Where a parent at (pLon, pLat), nearest skeleton point `idx`, aims the
   * centre of its heading sweep. In narrow water (the step there limited by
   * the width, stepAt): the skeleton point one step ahead. Elsewhere: one
   * step along the skeleton's own direction from the parent itself, so a
   * branch off the line keeps its offset instead of being pulled back.
   */
  targetForParent(idx: number, stepM: number, pLon?: number, pLat?: number): [number, number];
  /** Narrow-zone bin key for a candidate, or null outside every zone. */
  zoneKey(c: { lon: number; lat: number; viaCount: number }): string | null;
  /**
   * How far a candidate heading for its `viaCount`th goal still has to go, along the water: to its nearest skeleton
   * point (within the stretch before that goal), along the skeleton to the goal's point, and from there to the goal.
   * The straight distance without a skeleton. The stall detector's measure of progress (stages.ts): a branch against
   * a wall a few km from the goal has the whole detour ahead of it, and the detour counts as progress.
   */
  remainingM(lon: number, lat: number, viaCount: number): number;
}

export function buildGuide(ctx: SearchContext, sk: SkeletonData): SkeletonGuide {
  const { skeleton, skeletonCum, widths } = sk;
  const { progress, eLon, eLat, goals } = ctx;
  const { deltaD, candStepM } = ctx.budget;
  // ---- Narrow passages: step limits, extra stages, narrow-bin zones ------
  const nSk = skeleton ? skeleton.length : 0;
  /** Largest step allowed from each skeleton point (≤ candStepM). */
  const stepAt = new Float64Array(nSk).fill(candStepM);
  const zones: { a: number; b: number; west: number; east: number; south: number; north: number }[] = [];
  let extraStages = 0;
  if (skeleton && skeletonCum && widths) {
    const cum = skeletonCum;
    const maxStep = new Float64Array(nSk);
    for (let i = 0; i < nSk; i++) {
      const w = widths[i];
      maxStep[i] = Number.isFinite(w) ? Math.max(MIN_STEP_M, STEP_PER_WIDTH * w) : Infinity;
    }
    for (let i = 0; i < nSk; i++) {
      let lim = candStepM;
      for (let j = i; j < nSk && cum[j] - cum[i] <= candStepM; j++) {
        const l = Math.max(cum[j] - cum[i], maxStep[j]);
        if (l < lim) lim = l;
      }
      stepAt[i] = Math.max(MIN_STEP_M, lim);
    }
    for (let i = 1; i < nSk; i++) {
      const seg = cum[i] - cum[i - 1];
      if (stepAt[i - 1] < candStepM) extraStages += seg / stepAt[i - 1] - seg / candStepM;
    }
    // Zones narrower than a subsector bin.
    let i = 0;
    while (i < nSk) {
      if (!(widths[i] < deltaD)) {
        i++;
        continue;
      }
      let j = i;
      let maxW = 0;
      while (j + 1 < nSk && widths[j + 1] < deltaD) j++;
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      const ref = skeleton[i].lon;
      for (let q = i; q <= j; q++) {
        maxW = Math.max(maxW, widths[q]);
        let x = skeleton[q].lon;
        x = unwrapLonNear(x, ref);
        west = Math.min(west, x);
        east = Math.max(east, x);
        south = Math.min(south, skeleton[q].lat);
        north = Math.max(north, skeleton[q].lat);
      }
      const padM = maxW + 2000;
      const padLat = padM / M_PER_DEG;
      const padLon = padLat / Math.max(0.05, Math.cos((((south + north) / 2) * Math.PI) / 180));
      zones.push({ a: i, b: j, west: west - padLon, east: east + padLon, south: south - padLat, north: north + padLat });
      i = j + 1;
    }
  }
  const kEff = ctx.K + (extraStages > 0 ? Math.ceil(extraStages) + 2 : 0);
  const maxStages = kEff + Math.ceil(ctx.K / 2);
  if (extraStages > 0) {
    let minStep = Infinity;
    for (let i = 0; i < nSk; i++) minStep = Math.min(minStep, stepAt[i]);
    progress(
      0,
      kEff,
      `narrow passages: stages shortened down to {distance:${minStep.toFixed(0)}} there; ${kEff} stages planned (${zones.length} narrow stretch${zones.length === 1 ? '' : 'es'} binned across the passage)`
    );
  }

  const nearestSkeleton = (pLon: number, pLat: number, from = 0, to = nSk - 1): number => {
    let bestI = from;
    let bestD = Infinity;
    for (let i = from; i <= to; i++) {
      const d = haversineDistanceM(pLon, pLat, skeleton![i].lon, skeleton![i].lat);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return bestI;
  };
  /** Step for a parent at a position (candStepM without a skeleton). */
  const stepFor = (pLon: number, pLat: number): { step: number; idx: number } => {
    if (!skeleton || !skeletonCum || nSk < 2) return { step: candStepM, idx: -1 };
    const idx = nearestSkeleton(pLon, pLat);
    return { step: stepAt[idx], idx };
  };
  const targetForParent = (idx: number, stepM: number, pLon?: number, pLat?: number): [number, number] => {
    if (!skeleton || !skeletonCum || nSk < 2 || idx < 0) return [eLon, eLat];
    const targetCum = skeletonCum[idx] + stepM;
    if (targetCum >= skeletonCum[skeletonCum.length - 1]) return [eLon, eLat];
    let ti = -1;
    for (let i = idx + 1; i < nSk; i++) {
      if (skeletonCum[i] >= targetCum) {
        ti = i;
        break;
      }
    }
    if (ti < 0) return [eLon, eLat];
    // Open and coastal water: aim parallel to the skeleton from the parent
    // itself. Aiming at the skeleton point pulled every branch back to the
    // line, so a detour of hundreds of km could never form: Tonga →
    // Auckland, the front never got more than 170 km off the direct line
    // while a route 479 km west was 15 h faster. Until 2026-10-30 only
    // water wider than the width probe (Infinity) counted as open, so a
    // coast within 30 km on one side, or a skeleton without widths, pinned
    // the front to the line one step's lateral reach wide (measured on
    // brain: 6 of 40 bins occupied at every stage); now only water narrow
    // enough to shorten the step keeps the skeleton aim, which is what
    // finds channels.
    if (pLon !== undefined && pLat !== undefined && !(stepAt[idx] < candStepM)) {
      const b = haversineBearing(skeleton[idx].lon, skeleton[idx].lat, skeleton[ti].lon, skeleton[ti].lat);
      return projectAlongBearing(pLon, pLat, b, stepM);
    }
    return [skeleton[ti].lon, skeleton[ti].lat];
  };
  // The skeleton point each goal lies at (the vias and the end are on the skeleton: the corridor's chain, or the coarse
  // A*'s), so the way to a goal along the water is the skeleton up to that point. Found in route order: each via at or
  // after the goal before it, and the end at the skeleton's last point, which it is by construction. A point the route
  // visits twice (a round trip, start and end the same place, routed as one search through its waypoints' circles) has
  // two skeleton points; the nearest over the whole skeleton took the first, so the way home read as nothing left all
  // the way home (PR #91 review, 2026-11-01).
  const goalIdx: number[] = [];
  if (skeleton && skeletonCum && nSk >= 2)
    for (let gi = 0; gi < goals.length; gi++)
      goalIdx.push(gi === goals.length - 1 ? nSk - 1 : nearestSkeleton(goals[gi].lon, goals[gi].lat, gi > 0 ? goalIdx[gi - 1] : 0));
  const remainingM = (lon: number, lat: number, viaCount: number): number => {
    const gk = Math.min(viaCount, goals.length - 1);
    const g = goals[gk];
    if (!skeleton || !skeletonCum || nSk < 2) return haversineDistanceM(lon, lat, g.lon, g.lat);
    const gi = goalIdx[gk];
    // The candidate's stretch: from the goal before (the start for the first) to this goal, so a branch is never
    // read as near a later part of the skeleton it has not reached (the far side of a crossing).
    const from = gk > 0 ? goalIdx[gk - 1] : 0;
    const idx = nearestSkeleton(lon, lat, Math.min(from, gi), Math.max(from, gi));
    const along = Math.max(0, skeletonCum[gi] - skeletonCum[idx]);
    return (
      haversineDistanceM(lon, lat, skeleton[idx].lon, skeleton[idx].lat) +
      along +
      haversineDistanceM(skeleton[gi].lon, skeleton[gi].lat, g.lon, g.lat)
    );
  };
  /** Narrow-zone bin key for a candidate, or null outside every zone. */
  const zoneKey = (c: { lon: number; lat: number; viaCount: number }): string | null => {
    if (!zones.length || !skeleton || !widths) return null;
    for (let zi = 0; zi < zones.length; zi++) {
      const z = zones[zi];
      if (c.lat < z.south || c.lat > z.north) continue;
      let x = c.lon;
      const mid = (z.west + z.east) / 2;
      x = unwrapLonNear(x, mid);
      if (x < z.west || x > z.east) continue;
      const i = nearestSkeleton(c.lon, c.lat, z.a, z.b);
      const i2 = i < nSk - 1 ? i + 1 : i - 1;
      const off = perpendicularOffsetM(
        skeleton[Math.min(i, i2)].lon,
        skeleton[Math.min(i, i2)].lat,
        skeleton[Math.max(i, i2)].lon,
        skeleton[Math.max(i, i2)].lat,
        c.lon,
        c.lat
      );
      const w = Math.max(200, Number.isFinite(widths[i]) ? widths[i] : deltaD);
      const binW = w / NARROW_BINS;
      let bin = Math.floor(off / binW);
      if (bin < -NARROW_BINS) bin = -NARROW_BINS;
      if (bin > NARROW_BINS - 1) bin = NARROW_BINS - 1;
      return `${c.viaCount}:z${zi}:${bin}`;
    }
    return null;
  };
  return {
    skeleton,
    skeletonCum,
    widths,
    nSk,
    stepAt,
    zones,
    extraStages,
    kEff,
    maxStages,
    nearestSkeleton,
    stepFor,
    targetForParent,
    zoneKey,
    remainingM,
  };
}
