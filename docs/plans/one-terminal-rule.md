# Plan: one rule for the search's final leg

Status: **noted** 2026-11-01, not started. From the PR #91 review
(`src/engine/search/terminal.ts:171`): the water approach tries one
candidate and fails the leg if a move of its path cannot be made. Left
out of PR #91 on purpose: the search's end game is to be made consistent
once, deliberately, not patched comment by comment.

## What the end game does today (`src/engine/search/terminal.ts`)

Three rules decide the last part of a leg:

1. **The straight final leg** (`chooseTerminal`): the candidates whose
   straight hop is clear of land, nearest first, up to `TERMINAL_EVAL`
   simulated; the one with the least simulated cost (time plus comfort
   cost, the tack charge included) is taken. When none can be sailed, the
   failure note counts why each failed.
2. **The beat** (`beatToWindward`): when the straight hop lies in the
   polar's no-go angle, two close-hauled legs at each of `BEAT_MARGINS_DEG`,
   in either order, the cheapest that sails and clears land.
3. **The water approach** (`waterApproach`, legs that join a chart mesh with
   no clear straight final leg): one candidate, the least cost so far plus
   the water path's length at cruise speed, its path walked down the
   distance field and simulated move by move; null, and the leg fails, on
   the first move that cannot be made.

## Why the third is narrow, and why it is still a second rule

Every candidate's water path runs down the same distance field, so after
the first move or two the paths share the same cells at nearly the same
times: a limit set to block, or a current, that stops the channel stops
every candidate. A second candidate helps only when the chosen one's own
first moves are the blocked ones. Not measured on any case (2026-11-01):
the three harness legs never use the approach.

The straight final leg and the water approach answer the same question
(which candidate of the front ends the leg, and how) with different rules,
which is what the review keeps finding.

## The rule proposed

The water approach chooses as the straight final leg does: the front's
candidates ranked by the estimate (cost so far plus the water path at
cruise speed), the nearest `TERMINAL_EVAL` simulated along their paths, the
least simulated cost taken, and the leg failing only when all fail, with
the same failure note (why each failed, the conditions at the nearest).
One rule for both terminals; the beat stays what it is, a way of sailing
one hop.

## Measured first

A case where the approach's chosen candidate fails and another does not:
built on the bent-channel fixture of `waterapproach.test.ts` with a wind
field over a block limit at the chosen candidate's position and time only.
If the system cannot produce such a case, the change is not made.

Then before and after on brain: the Greenland → Block Island leg (the one
that joins the charts), and the three harness legs for no change.
