# Plan: the width of a passage behind a thin barrier

Status: **built** 2026-11-01, the owner's choice B: the width is the water
the point sits in, with no look-around for a point on land; such a point
reads 0 and is a narrow stretch, which the corridor's existing refinement
and fine re-trace move into the water (`widthProfile` in
`src/engine/corridor.ts`; tests in `corridor.test.ts`: barrier 200 m, 1 km,
4 km, islet beside the line, a point on land). The no-corridor skeleton's
points are water by construction (`buildCoarseGrid`: passable where the
cell centre is water). From the PR #91 review
(`src/engine/search/skeleton.ts:130`, 2026-11-01).

## What the profile does (`src/engine/corridor.ts` widthProfile)

At each skeleton point, along the perpendicular to the skeleton, sampled on
the route raster out to 30 km each side: the longest run of water that
comes within 2.5 km of the point. That run need not contain the point. The
2.5 km window is what makes an islet on the line read as the passage round
it rather than as a wall. The profile feeds the step limits and extra
stages, the narrow-water bins, the skeleton aiming, the local refinement of
narrow stretches, the fine re-trace of narrow stretches, and (since
2026-10-30) legs without a corridor.

## Measured (the Mac, 2026-11-01, scratch scripts `widthtest.ts`, `widthtest2.ts`)

A 1 km channel along a straight mainland shore, a barrier of thickness t on
the other side, open sea beyond:

| barrier t | width read at the channel's centre |
|---|---|
| 200 m, 500 m, 1,000 m | 28–29 km (the sea beyond the barrier) |
| 2,000 m and more | 945 m (the channel) |
| a strait between thick shores | 945 m |
| an islet 220 m across on the line, open water round it | open water (the documented case) |

So a channel reads as open sea when the land between it and other water is
thinner than about 2 km (the 2.5 km window less half the channel).

Effect on a search: a 1 km channel with a right-angle bend behind a 200 m
barrier, 28 km, motor, the same skeleton given with true widths and with
the widths read: both arrive; with the read widths the fallback sweep fired
14 times instead of none and the route took 5.21 h against 5.12 h at 12
stages, identical at 30 stages. One synthetic case; nothing says what a long
channel with several bends costs.

## What is not known yet

Which rule tells an islet from a shore. Two candidates:

- **the run that contains the point, continued across land shorter than
  the run itself** (an islet is small next to the water it sits in; a
  barrier is not); a number-free comparison, but it mis-reads a wide
  lagoon behind a narrow barrier the other way (the barrier is short next
  to the lagoon);
- **connectivity**: the water beyond the land is the same water as the
  point's when the raster connects them within the probe's reach; an islet
  is surrounded, a barrier separates. Exact in meaning, costlier (a flood
  per point, or per stretch), and a barrier with an inlet within reach
  connects too.

Either is a design decision about what "the passage" means, so it is taken
from real coasts, not from the synthetic case.

## Measured on real coasts (brain, 2026-11-01, `~/pr91-review/widthreal.js`, GSHHG full resolution, the deployed profile)

Five corridors from the water grid, 401 skeleton points, the profile against
the water each point sits in (the run containing it on the same ray) and
against the candidate "nearest run" rule below:

| leg | points | median profile width | points under 8 km (profile / nearest run) | under 2 km | stretches where the profile reads ≥ 2× the water the point sits in |
|---|---|---|---|---|---|
| Wadden Sea, off Harlingen → Lauwersoog entrance | 100 | 7.8 km | 52 / 55 | 0 / 0 | one, at the Lauwersoog inlet (53.4444 N 6.0344 E): profile 28.2 km, the water 4.3 km, shore 111 m |
| Wadden Sea, Lauwersoog → the Ems | 93 | 8.3 km | 39 / 38 | 0 / 0 | none; 3 skeleton points on land (grid cell centres) |
| Maasmond jetties → sea | 8 | 32 km | 0 / 0 | 0 / 0 | none |
| Øresund, Helsingør → Dragør | 93 | 11.8 km | 37 / 37 | 0 / 0 | none |
| Halifax → Lunenburg | 107 | 31 km | 8 / 14 | 0 / 1 | two: the Halifax approach (44.4496 N 63.5751 W) 28.1 km against 2.0 km, shore 615 m; off Lunenburg (44.3312 N 64.1962 W) 27.6 km against 3.5 km, shore 665 m |

The misread shows at inlets and harbour approaches, where a headland or
island lies within the 2.5 km window with open water beyond; the stretches
are short (up to 0.9 km) and none of these routes changed for it (Halifax
routes the same under every build measured today). The Wadden channels
themselves read as what they are. Points on land (the Ems leg) are the case
the 2.5 km window was written for.

## The rule proposed: the nearest run

The width at a point is the width of the water run the point sits in, along
the same perpendicular, out to the same cap; when the point itself is land
(a skeleton point at a grid cell's centre on an islet or a bank), the
nearest water run within 2.5 km of it, measured the same way. Open water
when that run reaches the cap both ways.

- The barrier case reads the channel (945 m in the synthetic case, by
  construction); the strait reads its width; a skeleton point on an islet
  still reads the passage beside it, which is what the 2.5 km window was
  for.
- An islet beside the line narrows the reading to the lane the point is in.
  That is the truth for that lane (the boat passes one side), and it is the
  conservative direction: shorter steps and narrow bins there, never longer.
- On the five legs above it moves few points across the 8 km re-trace
  threshold (Halifax 8 → 14, the others within one) and one across 2 km.

Not chosen: continuing across land shorter than the water run (a thin
barrier is shorter than its channel, so it reads the barrier case wrong),
and connectivity (exact in meaning, a flood per stretch, and an inlet
within reach connects a barrier anyway).

Tests: the barrier (200 m, 1 km, 3 km), the strait, the islet on the line,
an islet beside the line; the existing corridor width tests kept.

Measured before and after: the five legs above and the Placentia Bay leg
(widths along the skeleton, re-trace and refinement counts, route, time),
the Halifax and Placentia legs through the plugin.

Status of this section: proposed 2026-11-01, awaiting the owner's go.

## Measured first (the plan as written before the survey)

For each of the following, the skeleton the plugin would use (the corridor
from the water grid) and the width profile along it, printed with the
shore distance and the true channel width read off the chart:

1. a lagoon channel behind a barrier island (the Wadden Sea behind
   Terschelling or Ameland; Bogue Sound or Pamlico Sound are mesh water
   on brain and would not take this path);
2. a strait with an islet in it (the Menai Strait, or the Sound of Mull);
3. a river mouth with a training wall;
4. the two legs already measured (Placentia Bay, Halifax → Lunenburg), to
   see what each candidate rule would change there.

Then the rule is chosen on what those show, written here, and built with
the islet and strait tests kept and a barrier test added.
