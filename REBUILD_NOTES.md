# REBUILD_NOTES.md — sokoban-solver-01-run-20261121

Known weaknesses of the current entry and concrete ideas for a rebuild
round, per the ITERATE RULE. Current state: practice **1,000,000**,
10/10 freshly drawn random sets also 1,000,000, ~0.25 s wall, max ~850
expansions on any room seen so far (cap 120,000; independent review
measured 849). The scored set is
drawn from the same generator, so the main risk is a harder-than-usual
draw, not the practice set.

## Known weaknesses

1. **Fixed room order.** Rooms are solved in scan order. If a room's
   door were unreachable from the current player position, the whole
   level fails instead of trying another order. (The generator's
   construction makes this unlikely, but it is unguarded.)
2. **Thin deadlock pruning.** Only dead squares + frozen 2×2 blocks.
   No wall-line freeze (box against a wall segment with no goal,
   blocked both sides) and no 2-box deadlock-pair tables. On a draw
   with longer room optima (20–25 pushes instead of the practice
   12–17), A\* expansions could grow steeply; the BFS fallback covers
   correctness but is slower.
3. **Whole-level fallback is small-only.** When `roomsOf` returns null
   (not a set of rooms), whole-level search runs only for ≤5 boxes;
   a bigger non-room level yields an empty solution.
4. **Heuristic plateaus.** The Hungarian heuristic gives 0 to a box
   already on a goal even when that box must move again, and symmetric
   assignments tie often; A\* can expand large equal-f plateaus.
   Tie-breaking (larger g first) is the only mitigation.
5. **Global pool is shared in instance order.** The 1,500,000-expansion
   pool is consumed room by room; one pathological room could starve
   later rooms/instances. In practice usage is ~300 expansions per
   set, so this is a tail-risk only.
6. **No move-count tie-break.** Among push-optimal solutions the first
   found is kept; moves are not minimised. (Scoring counts pushes
   only, so this costs nothing — listed so a rebuild doesn't "fix" it
   at the expense of pushes.)

## Concrete rebuild ideas (in priority order)

1. **Room-order retry.** Before solving a room, BFS-walk (boxes as
   obstacles) from the current player position to the room's door; if
   unreachable, try the remaining rooms in a different order (≤4 rooms,
   ≤24 permutations, reachability only — no re-solving). Cheap, kills
   weakness 1.
2. **Wall-line freeze pruning.** Static per-push check: a box on a
   non-goal square against a wall, with the wall segment holding no
   goal and the box blocked on both sides along it, is dead. Small
   code, strictly safe, cuts the worst rooms.
3. **Adaptive budgets.** Size each room's A\* cap from a quick
   difficulty signal (e.g. initial heuristic value / room floor size)
   instead of a flat 120,000, and reserve pool for unsolved rooms
   instead of spending it in instance order. Protects weakness 5.
4. **2-box deadlock-pair table.** Precompute per room the pairs of
   squares from which two boxes can never both reach goals
   (Festival-style). Only if profiling on harder drawn sets shows
   A\* expanding heavily — it is the most bug-prone addition.
5. **Secondary heuristic for plateaus.** Add a cheap tie-break term
   (e.g. sum over boxes of min push distance, or boxes-off-goal count
   as a *tie-break only*, never added to the admissible h) to shrink
   equal-f plateaus. Must be verified to keep A\* optimal.
6. **Harder-set stress test.** Draw 20+ sets, find the max expansions
   per room, and only then decide whether ideas 2–5 are needed. Do
   not add pruning on speculation — every prune is a correctness risk
   and must be validated against the generator's BFS on the same sets.

## What NOT to change

- Keep budgets work-based (expansions), never clock-based.
- Keep the BFS fallback: it is the generator's own guarantee (every
  kept room solves within 250,000 states), so it is the proof-backed
  escape hatch at any depth the generator accepts.
- Keep per-room decomposition: whole-level search is the product of
  room state spaces, per-room is the sum.
