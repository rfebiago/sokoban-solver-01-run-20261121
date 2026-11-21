// sokoban-solver-01-run-20261121 — a push-optimal Sokoban solver.
//
// Strategy (see README.md): every level is a hallway plus independent
// rooms, and the level's push-optimum is the sum of its rooms' optima.
// So each room is solved on its own with a push-space A* search —
// states are (sorted box squares, player's reachable region), the
// heuristic is the minimum assignment of boxes to goals over
// precomputed push distances, and dead squares plus frozen 2x2 blocks
// are pruned. A plain push BFS (the search the level generator itself
// guarantees each room with) and a weighted A* stand by as fallbacks,
// so a room still yields a valid answer when the optimal search runs
// out of its deterministic work budget. Rooms are then stitched with
// hallway walks. All budgets are counted in expansions, never in wall
// clock time, so two runs write identical bytes.
//
// Node 22, erasable-syntax TypeScript only, no dependencies.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** [dx, dy, walk letter, push letter]. Fixed order everywhere: ties break the same way on every run. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];
const INF = 1_000_000_000;

/** Deterministic work budgets (expansions), never the clock. */
const ASTAR_EXPANSIONS = 120_000;
const BFS_EXPANSIONS = 250_000;
const WEIGHTED_EXPANSIONS = 100_000;
const GREEDY_EXPANSIONS = 100_000;
const MAX_STATES_PER_SEARCH = 500_000;
/** Whole-run expansion pool: it bounds total work (measured usage is ~0.13% of it, ~0.3 s per set), but it bounds
 * expansions, not wall time — a pathological draw burning the whole pool would still be slow, so the real safety
 * margin is how little of the pool realistic rooms use. */
let pool = 1_500_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text. Short rows and the outer frame count as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * For each goal, the minimum pushes to bring a lone box from any square
 * onto that goal, by breadth-first search over the reverse-pull graph:
 * a box on x could have been pushed there from y = x - d when y is open
 * and the player could stand on y - d. Squares no pull reaches are dead
 * (a box there can never reach a goal). Distances ignore other boxes,
 * so they never overestimate: they are a sound basis for the heuristic.
 */
function pushDistances(L: Level): { live: Uint8Array; dist: Int32Array[] } {
  const { w, wall, goals } = L;
  const size = wall.length;
  const live = new Uint8Array(size);
  const dist: Int32Array[] = [];
  for (const g of goals) {
    const dg = new Int32Array(size).fill(-1);
    dg[g] = 0;
    live[g] = 1;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi];
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const y = x - d;
        const behind = y - d;
        if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
        if (wall[y] || wall[behind] || dg[y] >= 0) continue;
        dg[y] = dg[x]! + 1;
        live[y] = 1;
        q.push(y);
      }
    }
    dist.push(dg);
  }
  return { live, dist };
}

/** All orderings of n goal indices, for the assignment heuristic (n <= 5, so at most 120). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i]!, a[k]!];
      gen(k + 1);
      [a[k], a[i]] = [a[i]!, a[k]!];
    }
  };
  gen(0);
  return out;
}

/** Flood-fill the player's reachable region from `from` with `occupied` in the way; returns its lowest square. */
function regionLow(
  L: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = L;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(L: Level, occupied: Uint8Array, goalSet: Uint8Array, t: number): boolean {
  const { w, wall } = L;
  const size = wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a + w + 1 >= size) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d]))
      continue;
    if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) || (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d]))
      return true;
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u first on ties). */
function walkTo(L: Level, occupied: Uint8Array, from: number, to: number): string | null {
  const { w, wall } = L;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player's square after playing `moves` (case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

type SearchMode = 'astar' | 'bfs' | 'weighted' | 'greedy';

interface SearchResult {
  pushes: number;
  moves: string;
  expansions: number;
  states: number;
}

/**
 * Push-space search over one room (or a whole small level).
 * A state is the sorted box squares plus the player's reachable region
 * (named by its lowest square); only pushes are searched, walks are
 * rebuilt afterwards. `astar` is push-optimal with an admissible
 * Hungarian heuristic; `bfs` is the same search with h = 0; `weighted`
 * (f = g + 3h) and `greedy` (f = h) trade optimality for speed and are
 * only ever fallbacks. Returns null when the work budget runs out.
 */
function searchRoom(L: Level, mode: SearchMode, maxExpansions: number): SearchResult | null {
  const { w, wall, goals } = L;
  const size = wall.length;
  const n = L.boxes.length;
  if (n === 0 || n !== goals.length) return null;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const { live, dist } = pushDistances(L);
  if (L.boxes.some((b) => !live[b])) return null;
  const perms = permutations(n);
  const hOf = (boxes: number[]): number => {
    let best = INF;
    for (const perm of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d = dist[perm[i]!]![boxes[i]!]!;
        if (d < 0) {
          ok = false;
          break;
        }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    return best;
  };
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // State storage: boxes, the player's square after the push, parent, push direction, g, and key.
  const sBoxes: number[][] = [L.boxes.slice()];
  const sPlayer: number[] = [L.player];
  const sParent: number[] = [-1];
  const sDir: number[] = [-1];
  const sKey: number[] = [];
  // `seen` stamps the expansion's reachable region; `mark` stamps each
  // child's region for its key — two arrays, so a key flood-fill never
  // clobbers the reachability test of the state being expanded.
  for (const b of L.boxes) occupied[b] = 1;
  sKey.push(keyOf(L.boxes, regionLow(L, occupied, L.player, mark, ++stamp, stack)));
  for (const b of L.boxes) occupied[b] = 0;

  const best = new Map<number, number>([[sKey[0]!, 0]]);
  if (solved(L.boxes)) return { pushes: 0, moves: '', expansions: 0, states: 1 };

  // Binary heap on (f asc, g desc, sequence asc). Fully deterministic.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const fOf = (g: number, h: number): number =>
    mode === 'bfs' ? g : mode === 'greedy' ? h : mode === 'weighted' ? g + 3 * h : g + h;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([fOf(0, hOf(L.boxes)), 0, seq++, 0]);

  let expansions = 0;
  while (heap.length > 0) {
    if (expansions >= maxExpansions || pool <= 0) return null;
    const [, g, , s] = heapPop();
    if (best.get(sKey[s]!) !== g) continue; // a better path to this state was found since
    const boxes = sBoxes[s]!;
    if (solved(boxes)) {
      // Rebuild the moves: walk to each push square, then push.
      const path: number[] = [];
      for (let t = s; t > 0; t = sParent[t]!) path.push(t);
      path.reverse();
      let moves = '';
      let player = L.player;
      let cur = L.boxes.slice();
      for (const t of path) {
        const nextBoxes = sBoxes[t]!;
        const from = cur.find((b) => !nextBoxes.includes(b))!;
        const to = nextBoxes.find((b) => !cur.includes(b))!;
        const dir = sDir[t]!;
        const [dx, dy, , pushLetter] = DIRS[dir]!;
        const d = dy * w + dx;
        for (const b of cur) occupied[b] = 1;
        const walk = walkTo(L, occupied, player, from - d);
        for (const b of cur) occupied[b] = 0;
        if (walk === null) return null;
        moves += walk + pushLetter;
        player = from;
        cur = nextBoxes;
      }
      return { pushes: path.length, moves, expansions, states: sBoxes.length };
    }
    expansions++;
    pool--;
    const p = sPlayer[s]!;
    for (const b of boxes) occupied[b] = 1;
    regionLow(L, occupied, p, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size || b - d < 0 || b - d >= size) continue;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(L, occupied, goalSet, t);
        let key = -1;
        let next: number[] | null = null;
        let h = INF;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, bb) => a - bb);
          key = keyOf(next, regionLow(L, occupied, b, mark, ++stamp, stack));
          h = hOf(next);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h >= INF) continue;
        const g2 = g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= g2) continue;
        if (sBoxes.length >= MAX_STATES_PER_SEARCH) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g2);
        const idx = sBoxes.length;
        sBoxes.push(next!);
        sPlayer.push(b);
        sParent.push(s);
        sDir.push(k);
        sKey.push(key);
        heapPush([fOf(g2, h), g2, seq++, idx]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }

  return null;
}

/** Solve one room-shaped sub-level, optimal search first, fallbacks after. */
function solveRoom(L: Level): SearchResult | null {
  return (
    searchRoom(L, 'astar', Math.min(ASTAR_EXPANSIONS, pool)) ??
    searchRoom(L, 'bfs', Math.min(BFS_EXPANSIONS, pool)) ??
    searchRoom(L, 'weighted', Math.min(WEIGHTED_EXPANSIONS, pool)) ??
    searchRoom(L, 'greedy', Math.min(GREEDY_EXPANSIONS, pool))
  );
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * Split a level into rooms: cut the hallway row's dead squares out of
 * the floor (a box there reaches no goal), and each remaining component
 * holding boxes is a room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const { live } = pushDistances(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve a whole level room by room; null when any room gives up. */
function solveLevel(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);

  if (rooms === null) {
    // Not a set of rooms: whole-level search only for small levels.
    if (level.boxes.length > 5) return null;
    const r = solveRoom(level);
    return r === null ? null : { pushes: r.pushes, moves: r.moves };
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms)
      if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub);

    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    const solved = solveLevel(level);
    if (solved !== null) moves = solved.moves;
  } catch {
    moves = ''; // never let one bad instance take down the whole set
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
