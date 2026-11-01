# Plan: the stall rule measures progress along the water, not through land

Status: **proposed** 2026-11-01, not started. From the PR #91 review
(`src/engine/search/zones.ts:155`, 2026-11-01), which blamed the aiming
rule; the measurement below shows the failure is the stall rule's.

## Measured (the Mac, 2026-11-01, scratch scripts `aimtest.ts` and `aimfail.ts` against the repo's modules)

A synthetic coast: an east–west wall of land 1.1 km thick across a 0.6° box,
one gap in it at lon 0.40; a leg from (0.10, 0.10) to (0.10, 0.30) straight
through the wall where there is no gap. The coarse skeleton runs 33 km
east along the wall, through the gap and 33 km back. Ten cases (gap 1, 1.5,
2, 3, 5 km; 12 and 30 stages), today's code against the code before the aim
change of 2026-10-30 (4ad41b7~1):

- nine cases agree: route found, same times, both trees;
- gap 1 km, 12 stages: today's code fails "boxed in: for 10 stages no
  candidate came closer than 13.6 km to the destination"; the old code
  arrives in 8.18 h.

The stage trace of the failing case: both trees reach the gap and get
through it by stage 9–10. At stage 2 a branch pressed against the wall sits
13.6 km from the destination, on the wrong side of the wall. Every later
stage, the detour east along the wall and back, counts as no progress
against that mark; at the end of the planned stages (`kEff` 12) the stall
rule (`STALL_STAGES` 3) stops the search with the front 16.7 km out and
closing. The old code's early mark was 16.3 km, and its front came to
14.4 km one stage before the rule would have fired: it survived by 2 km.
With 30 stages both arrive.

So the mechanism is: the rule judges progress by straight-line distance to
the goal, and a barrier between the front and the goal puts the early mark
where no water path can improve on it until the detour is done.

Reachability: the scenario runs the search without a corridor from the
water grid (the per-route skeleton): the corridor fallback and the
coastline parts of a chart-mesh leg. With a corridor the budget is sized to
the skeleton the same way, so the same rule applies there.

## The rule today (`src/engine/search/stages.ts`, the stall detector)

Per stage, `goalRemaining` = the least straight-line distance from a
retained candidate of the deepest via count to its goal; `bestEver` is the
least seen so far; a stage gains when it comes under `bestEver` by more
than a twentieth of the stage step; after the planned stages, three stages
without gain is "boxed in". The counts of the last try decide whether the
refusal names a cause.

## The change

Progress is measured along the water the search follows: the skeleton.

1. `SkeletonGuide` gains `remainingM(lon, lat, viaCount)`: the distance
   still to go to the goal along the skeleton, from the nearest skeleton
   point to the candidate (the guide already has `nearestSkeleton` and
   `skeletonCum`) plus the candidate's own distance to that point. Without
   a skeleton (open water, or the skeleton unavailable) it is the straight
   distance, as now.
2. The stall detector uses `remainingM` for `goalRemaining` and `bestEver`.
   A branch against the wall has most of the skeleton still ahead of it;
   the detour along the wall shortens that at every stage; the rule fires
   only when the front stops advancing along the water.
3. The terminal's "came within X of the point" wording keeps the straight
   distance (that is what it says).
4. Nothing else changes: the bins, the sweep, the ladder, the budget.

Vias: `nearestSkeleton` is searched between the via's skeleton indices
when the goal is a via, as `zoneKey` already does, so a branch does not
count progress towards the next via from the wrong side of a crossing.

## Tests

- The failing case above as a test: gap 1 km, 12 stages, the route is
  found; and the old passing cases unchanged.
- A front truly stuck (a closed bay) is still refused as boxed in, with the
  same message: the existing dead-end and boxed-in tests.
- Golden routes: the rule only decides when to stop; a route that finished
  before the rule fired is unchanged. Any golden that moves is a route the
  old rule cut short, to be looked at one by one.

## Measured before and after

The ten synthetic cases; the Placentia Bay leg and the Halifax leg through
the plugin on brain (no change expected); the eastern Mediterranean and
Caribbean replays from the stall rule's own history (`stages.ts` names jobs
3bde5200 and c14934c9), if their requests are still on brain.
