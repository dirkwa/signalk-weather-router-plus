# Plan: the width of a passage behind a thin barrier

Status: **proposed** 2026-11-01, not started; the rule is to be chosen from
real coasts measured first (below). From the PR #91 review
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

## Measure first (brain, GSHHG full resolution, the deployed profile)

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
