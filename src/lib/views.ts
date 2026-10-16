import type { Permission } from '../shared/contract';

/**
 * Dashboard views. Each one is a sidebar entry and a URL hash (#trends), so a
 * view can be bookmarked, linked to, and reached with the back button. A view
 * shows only its own panels, which keeps the page short.
 *
 * `key` is the letter that jumps to the view after pressing G (G then O for
 * the overview). Letters must stay unique.
 */
const ALL_VIEW_GROUPS = [
  {
    title: 'Overview',
    items: [
      { id: 'overview', label: 'Overview', key: 'o' },
      { id: 'applications', label: 'Applications', key: 'a' },
    ],
  },
  {
    title: 'Monitoring',
    items: [
      { id: 'trends', label: 'Trends', key: 't' },
      { id: 'hardware', label: 'Hardware', key: 'h' },
      { id: 'workload', label: 'Workload', key: 'w' },
      { id: 'capacity', label: 'Capacity', key: 'c' },
    ],
  },
  { title: 'Access', items: [{ id: 'reach-and-spend', label: 'Reach and spend', key: 'r' }] },
  {
    title: 'Operations',
    items: [
      { id: 'logs-and-control', label: 'Logs and control', key: 'l' },
      { id: 'files', label: 'Files', key: 'f' },
      { id: 'users', label: 'Users', key: 'u' },
    ],
  },
] as const;

export type ViewId = (typeof ALL_VIEW_GROUPS)[number]['items'][number]['id'];

/**
 * Views kept in the code but switched off: left out of the sidebar, the
 * palette, the G shortcuts and the URL (their hash falls back to the
 * overview). Remove an id here to bring the view back.
 */
const HIDDEN_VIEWS: ReadonlySet<ViewId> = new Set<ViewId>(['reach-and-spend']);

/**
 * What opens each view. A view shows when the login holds any one of these.
 * The server enforces the same for the data behind them: logs, files, users, and
 * the telemetry (src/server/scope.ts cuts stats, the stream and history per view).
 */
const VIEW_NEEDS: Readonly<Record<ViewId, readonly Permission[]>> = {
  overview: ['view:overview'],
  applications: ['view:applications'],
  trends: ['view:trends'],
  hardware: ['view:hardware'],
  workload: ['view:workload'],
  capacity: ['view:capacity'],
  'reach-and-spend': ['view:overview'],
  // Logs on one side, service control on the other: either one opens the page.
  'logs-and-control': ['view:logs', 'services:control'],
  files: ['files:read'],
  users: ['users:manage'],
};

/**
 * The group whose scope bar also offers the terminal (an overlay, not a view),
 * and whose tab shows the dot while a shell runs hidden. Phones keep three tabs.
 */
export const TERMINAL_GROUP = 'Operations';

function groupsFor(perms: ReadonlySet<string>): readonly { readonly title: string; readonly items: readonly View[] }[] {
  return ALL_VIEW_GROUPS.map((group) => ({
    title: group.title,
    items: group.items.filter((item) => !HIDDEN_VIEWS.has(item.id) && VIEW_NEEDS[item.id].some((p) => perms.has(p))),
  })).filter((group) => group.items.length > 0);
}

// Live bindings: setViewAccess swaps them before the app renders, and every
// importer sees the new lists.
export let VIEW_GROUPS = groupsFor(new Set());

interface View {
  readonly id: ViewId;
  readonly label: string;
  readonly key: string;
}

export let VIEWS: readonly View[] = VIEW_GROUPS.flatMap((group) => [...group.items]);

let currentKey = '';

/** Narrows the views to what this login may open. Call before rendering the app. */
export function setViewAccess(permissions: readonly string[]): void {
  const key = [...permissions].sort().join(',');
  if (key === currentKey) return;
  currentKey = key;
  VIEW_GROUPS = groupsFor(new Set(permissions));
  VIEWS = VIEW_GROUPS.flatMap((group) => [...group.items]);
}

/** The first view this login may open; overview when it may open none (the app says so). */
function defaultView(): ViewId {
  return VIEWS[0]?.id ?? 'overview';
}

type ViewGroup = (typeof VIEW_GROUPS)[number];

/** The view last opened in each group, by group title (tab bar and rail share it). */
const lastSeen = new Map<string, ViewId>();

/** Remembers `id` as its group's place, so the group's tab or rail icon returns to it. */
export function noteView(id: ViewId): void {
  const group = VIEW_GROUPS.find((g) => g.items.some((i) => i.id === id));
  if (group) lastSeen.set(group.title, id);
}

/** Where a group's tab or rail icon leads: the view last opened in it, else its first. */
export function groupTarget(group: ViewGroup): ViewId {
  const seen = lastSeen.get(group.title);
  return seen && group.items.some((i) => i.id === seen) ? seen : (group.items[0]?.id ?? 'overview');
}

/** "G O" style label for a view's shortcut. */
export function shortcutLabel(view: { readonly key: string }): string {
  return `G ${view.key.toUpperCase()}`;
}

/** Unknown or empty hash falls back to the overview. */
export function viewFromHash(hash: string): ViewId {
  const id = hash.replace(/^#/, '');
  const match = VIEWS.find((v) => v.id === id);
  return match ? match.id : defaultView();
}
