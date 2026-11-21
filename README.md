[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/rfebiago/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/rfebiago/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
# sokoban-solver-01-run-20261121

A push-optimal Sokoban solver for the make.fun bounty
`sokoban-solver-01-run-20261121` (prize $100, deadline Mon 23 Nov 2026
10:00 WIB).

## How it works

Every level in this competition is a 1-wide hallway plus 1–4
independent rooms (3–4 boxes each), and the level's push-optimum P* is
the sum of its rooms' optima. So the solver never searches the whole
level:

1. **Decompose** (`roomsOf`): cut the hallway row's dead squares out of
   the floor; each remaining component holding boxes is a room.
2. **Solve each room** with a push-space **A\*** search:
   - a state is the sorted box squares plus the player's reachable
     region (named by its lowest square) — walking is a free
     flood-fill, only pushes are searched;
   - the heuristic is the **minimum assignment** of boxes to goals over
     precomputed push distances (reverse-pull BFS from each goal,
     ignoring other boxes — admissible, wall-aware, assignment-aware);
   - **dead squares** and **frozen 2×2 blocks** are pruned at
     generation time.
3. **Fallbacks** per room, in order: A\* → plain push BFS (the search
   the level generator itself guarantees each room with, ≤250,000
   states) → weighted A\* (f = g + 3h) → greedy best-first. A fallback
   may give a suboptimal but valid solution instead of nothing.
4. **Stitch**: each room's moves already include its internal walks
   (walk to each push square, then push); rooms are concatenated in
   scan order with the player walking on from where the last room left
   it. A level is answered even if a room fails (empty solution file —
   never a missing file).

All budgets are counted in **expansions, never wall-clock time**, with a
whole-run pool of 1,500,000 expansions, so two runs write identical
bytes. No clock reads, no randomness, no network, no dependencies —
Node 22, erasable-syntax TypeScript only.

## Local grading

```sh
KIT=~/workspace/makefun/sokoban-solver-01-run-20261121-kit/sokoban-solver-01-run-20261121-kit
node $KIT/cli/makefun.mjs grade-local --kit $KIT --bot . --driver process --worktree
```

Practice result: **1,000,000 / 1,000,000** (all 5 instances at exactly
P*: 13 / 16 / 29 / 47 / 60 pushes), ~0.25 s wall on this VM, max 60
expansions per practice room (cap 120,000). Also 1,000,000 on 10
freshly drawn random sets from the kit generator, and byte-identical
outputs across repeated runs.

## Files

- `main.ts` — the whole entry (single file).
- `LICENSE` — MIT (kit starter's licence).
- `REBUILD_NOTES.md` — known weaknesses + concrete rebuild ideas.
