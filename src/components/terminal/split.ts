/**
 * Split view: every window placed in one tree of rows and columns, like tmux or
 * Windows Terminal. The tree only says where each window goes. The windows
 * themselves stay flat siblings in the DOM and are positioned from `layout()`,
 * so re-arranging never remounts an xterm (which would end its shell).
 */

/** `row`: children side by side, left to right. `col`: stacked, top to bottom. */
export type Dir = 'row' | 'col';

export type Node =
  | { readonly k: 'leaf'; readonly id: number }
  | { readonly k: 'split'; readonly dir: Dir; readonly kids: readonly Node[]; readonly sizes: readonly number[] };

export type Preset = 'grid' | 'columns' | 'rows' | 'main';
export type Side = 'left' | 'right' | 'up' | 'down';

/** Fractions of the window area, 0 to 1. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A draggable boundary between kids `i` and `i + 1` of the split at `path`. */
export interface Divider {
  readonly key: string;
  readonly path: readonly number[];
  readonly i: number;
  readonly dir: Dir;
  /** The split's own rect, to turn a pointer position into a fraction of it. */
  readonly span: Rect;
  /** Where the boundary sits, as a fraction of the whole area along the split's axis. */
  readonly at: number;
}

/** Smallest share a pane may be dragged down to. */
const MIN = 0.08;
export const PRESETS: readonly Preset[] = ['grid', 'columns', 'rows', 'main'];

const leaf = (id: number): Node => ({ k: 'leaf', id });

function split(dir: Dir, kids: readonly Node[], sizes?: readonly number[]): Node {
  if (kids.length === 1) return kids[0] as Node;
  return { k: 'split', dir, kids, sizes: sizes ?? kids.map(() => 1 / kids.length) };
}

function normal(sizes: readonly number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return sizes.map((s) => s / sum);
}

export function ids(n: Node | null): number[] {
  if (!n) return [];
  return n.k === 'leaf' ? [n.id] : n.kids.flatMap(ids);
}

export function preset(list: readonly number[], kind: Preset): Node | null {
  if (list.length === 0) return null;
  const leaves = list.map(leaf);
  if (kind === 'columns') return split('row', leaves);
  if (kind === 'rows') return split('col', leaves);
  if (kind === 'main') {
    const [first, ...rest] = leaves;
    if (!first) return null;
    return rest.length ? split('row', [first, split('col', rest)], [0.6, 0.4]) : first;
  }
  // Grid: as square as the count allows, extra windows in the last row.
  const cols = Math.ceil(Math.sqrt(list.length));
  const rows: Node[] = [];
  for (let i = 0; i < leaves.length; i += cols) rows.push(split('row', leaves.slice(i, i + cols)));
  return split('col', rows);
}

/** Puts `id` next to `target`, splitting the target's space in two along `dir`. */
export function insert(n: Node | null, target: number, id: number, dir: Dir): Node {
  if (!n) return leaf(id);
  const go = (node: Node): Node | null => {
    if (node.k === 'leaf') return node.id === target ? split(dir, [node, leaf(id)]) : null;
    for (let i = 0; i < node.kids.length; i++) {
      const kid = node.kids[i] as Node;
      // Same direction as this split: become a sibling instead of nesting.
      if (kid.k === 'leaf' && kid.id === target && node.dir === dir) {
        const half = (node.sizes[i] ?? 0) / 2;
        const kids = [...node.kids.slice(0, i + 1), leaf(id), ...node.kids.slice(i + 1)];
        const sizes = [...node.sizes.slice(0, i), half, half, ...node.sizes.slice(i + 1)];
        return { ...node, kids, sizes };
      }
      const done = go(kid);
      if (done) return { ...node, kids: node.kids.map((k, j) => (j === i ? done : k)) };
    }
    return null;
  };
  return go(n) ?? split(dir, [n, leaf(id)]);
}

export function remove(n: Node | null, id: number): Node | null {
  if (!n) return null;
  if (n.k === 'leaf') return n.id === id ? null : n;
  const kids: Node[] = [];
  const sizes: number[] = [];
  // A closed pane's space goes to the pane before it (or after, for the first), as in tmux.
  let freed = 0;
  n.kids.forEach((k, i) => {
    const next = remove(k, id);
    if (next) {
      kids.push(next);
      sizes.push((n.sizes[i] ?? 0) + freed);
      freed = 0;
    } else if (sizes.length > 0) sizes[sizes.length - 1] = (sizes[sizes.length - 1] ?? 0) + (n.sizes[i] ?? 0);
    else freed = n.sizes[i] ?? 0;
  });
  if (kids.length === 0) return null;
  // A child split in the same direction folds into this one.
  const flatKids: Node[] = [];
  const flatSizes: number[] = [];
  kids.forEach((k, i) => {
    if (k.k === 'split' && k.dir === n.dir) {
      k.kids.forEach((kk, j) => {
        flatKids.push(kk);
        flatSizes.push((sizes[i] ?? 0) * (k.sizes[j] ?? 0));
      });
    } else {
      flatKids.push(k);
      flatSizes.push(sizes[i] ?? 0);
    }
  });
  return split(n.dir, flatKids, normal(flatSizes));
}

/** Makes the tree hold exactly `list`: drops windows that are gone, adds new ones beside the last. */
export function sync(n: Node | null, list: readonly number[], aspect: number): Node | null {
  const want = new Set(list);
  let out = n;
  for (const id of ids(n)) if (!want.has(id)) out = remove(out, id);
  const have = new Set(ids(out));
  for (const id of list) {
    if (have.has(id)) continue;
    const anchor = ids(out).at(-1);
    out = anchor === undefined ? leaf(id) : insert(out, anchor, id, autoDir(out, anchor, aspect));
    have.add(id);
  }
  return out;
}

/** Side by side when the pane is wide, stacked when it is tall. Terminal text wants width. */
export function autoDir(n: Node | null, id: number, aspect: number): Dir {
  const r = n ? layout(n).panes.get(id) : undefined;
  if (!r) return 'row';
  return r.w * aspect >= r.h * 1.4 ? 'row' : 'col';
}

export function layout(n: Node | null): { panes: Map<number, Rect>; dividers: Divider[] } {
  const panes = new Map<number, Rect>();
  const dividers: Divider[] = [];
  const walk = (node: Node, r: Rect, path: number[]) => {
    if (node.k === 'leaf') {
      panes.set(node.id, r);
      return;
    }
    let off = 0;
    node.kids.forEach((kid, i) => {
      const s = node.sizes[i] ?? 0;
      const kr = node.dir === 'row' ? { x: r.x + off * r.w, y: r.y, w: s * r.w, h: r.h } : { x: r.x, y: r.y + off * r.h, w: r.w, h: s * r.h };
      walk(kid, kr, [...path, i]);
      off += s;
      if (i < node.kids.length - 1) {
        dividers.push({
          key: `${path.join('.')}:${i}`,
          path,
          i,
          dir: node.dir,
          span: r,
          at: node.dir === 'row' ? r.x + off * r.w : r.y + off * r.h,
        });
      }
    });
  };
  if (n) walk(n, { x: 0, y: 0, w: 1, h: 1 }, []);
  return { panes, dividers };
}

function at(n: Node, path: readonly number[]): Node | undefined {
  let cur: Node | undefined = n;
  for (const i of path) cur = cur?.k === 'split' ? cur.kids[i] : undefined;
  return cur;
}

function replaceAt(n: Node, path: readonly number[], next: Node): Node {
  if (path.length === 0) return next;
  if (n.k === 'leaf') return n;
  const [i, ...rest] = path;
  return { ...n, kids: n.kids.map((k, j) => (j === i ? replaceAt(k, rest, next) : k)) };
}

/** Moves the boundary after kid `i` of the split at `path` to `p`, a fraction of that split (0 to 1). */
export function resizeAt(n: Node, path: readonly number[], i: number, p: number): Node {
  const node = at(n, path);
  if (!node || node.k !== 'split') return n;
  const before = node.sizes.slice(0, i).reduce((a, b) => a + b, 0);
  const pair = (node.sizes[i] ?? 0) + (node.sizes[i + 1] ?? 0);
  const left = Math.min(pair - MIN, Math.max(MIN, p - before));
  if (pair < MIN * 2) return n;
  const sizes = node.sizes.map((s, j) => (j === i ? left : j === i + 1 ? pair - left : s));
  return replaceAt(n, path, { ...node, sizes });
}

/** Gives every pane in the split at `path` an equal share. */
export function equalize(n: Node, path: readonly number[]): Node {
  const node = at(n, path);
  if (!node || node.k !== 'split') return n;
  return replaceAt(n, path, { ...node, sizes: node.kids.map(() => 1 / node.kids.length) });
}

function pathOf(n: Node, id: number, path: number[] = []): number[] | null {
  if (n.k === 'leaf') return n.id === id ? path : null;
  for (let i = 0; i < n.kids.length; i++) {
    const p = pathOf(n.kids[i] as Node, id, [...path, i]);
    if (p) return p;
  }
  return null;
}

/**
 * Keyboard resize: moves the nearest divider beside window `id` toward `side`.
 * Right moves the divider on its right edge (or, at the far right, its left edge) rightwards.
 */
export function nudge(n: Node, id: number, side: Side, step = 0.04): Node {
  const p = pathOf(n, id);
  if (!p) return n;
  const dir: Dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const delta = side === 'right' || side === 'down' ? step : -step;
  // Walk up from the window to the first split along the right axis.
  for (let depth = p.length - 1; depth >= 0; depth--) {
    const splitPath = p.slice(0, depth);
    const node = at(n, splitPath);
    if (!node || node.k !== 'split' || node.dir !== dir) continue;
    const idx = p[depth] ?? 0;
    const i = idx < node.kids.length - 1 && (delta > 0 || idx === 0) ? idx : idx - 1;
    if (i < 0) continue;
    const boundary = node.sizes.slice(0, i + 1).reduce((a, b) => a + b, 0);
    return resizeAt(n, splitPath, i, boundary + delta);
  }
  return n;
}

/** The pane next to `from` toward `side`: overlapping on the other axis, nearest first. */
export function neighbor(panes: ReadonlyMap<number, Rect>, from: number, side: Side): number | null {
  const a = panes.get(from);
  if (!a) return null;
  const eps = 0.001;
  let best: number | null = null;
  let bestScore = Infinity;
  for (const [id, b] of panes) {
    if (id === from) continue;
    let gap: number;
    let overlap: number;
    if (side === 'left' || side === 'right') {
      gap = side === 'right' ? b.x - (a.x + a.w) : a.x - (b.x + b.w);
      overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    } else {
      gap = side === 'down' ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
      overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    }
    if (gap < -eps || overlap <= eps) continue;
    // Closest first; among equals, the one that lines up best.
    const score = gap * 10 - overlap;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Exchanges two windows' places. */
export function swap(n: Node, a: number, b: number): Node {
  if (n.k === 'leaf') return n.id === a ? leaf(b) : n.id === b ? leaf(a) : n;
  return { ...n, kids: n.kids.map((k) => swap(k, a, b)) };
}

/** A stored tree, checked node by node. Anything malformed gives null. */
export function parseTree(raw: unknown): Node | null {
  const go = (v: unknown, depth: number): Node | null => {
    if (depth > 12 || typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (o.k === 'leaf') return Number.isInteger(o.id) && (o.id as number) > 0 ? leaf(o.id as number) : null;
    if (o.k !== 'split' || (o.dir !== 'row' && o.dir !== 'col') || !Array.isArray(o.kids) || !Array.isArray(o.sizes)) return null;
    const kids = o.kids.map((k) => go(k, depth + 1));
    if (kids.length < 2 || kids.some((k) => k === null) || o.sizes.length !== kids.length) return null;
    const sizes = (o.sizes as unknown[]).map((s) => (typeof s === 'number' && s > 0 ? s : 0));
    if (sizes.some((s) => s === 0)) return null;
    return { k: 'split', dir: o.dir, kids: kids as Node[], sizes: normal(sizes) };
  };
  const t = go(raw, 0);
  const all = ids(t);
  return new Set(all).size === all.length ? t : null;
}
