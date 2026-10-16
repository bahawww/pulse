import { roleAtLeast, type Role } from '../shared/contract';

/**
 * Dashboard views. Each one is a sidebar entry and a URL hash (#trends), so a
 * view can be bookmarked, linked to, and reached with the back button. A view
 * shows only its own panels, which keeps the page short.
 *
 * `key` is the letter that jumps to the view after pressing G (G then O for
 * the overview). Letters must stay unique.
 */
const ALL_VIEW_GROUPS = [
  { title: 'Overview', items: [{ id: 'overview', label: 'Overview', key: 'o' }] },
  { title: 'Services', items: [{ id: 'applications', label: 'Applications', key: 'a' }] },
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

/** Views that need more than the viewer role. The server enforces the same. */
const VIEW_ROLE: Partial<Readonly<Record<ViewId, Role>>> = { files: 'admin', users: 'admin' };

function groupsFor(role: Role): readonly { readonly title: string; readonly items: readonly View[] }[] {
  return ALL_VIEW_GROUPS.map((group) => ({
    title: group.title,
    items: group.items.filter((item) => !HIDDEN_VIEWS.has(item.id) && roleAtLeast(role, VIEW_ROLE[item.id] ?? 'viewer')),
  })).filter((group) => group.items.length > 0);
}

// Live bindings: setViewRole swaps them before the app renders, and every
// importer sees the new lists.
export let VIEW_GROUPS = groupsFor('viewer');

interface View {
  readonly id: ViewId;
  readonly label: string;
  readonly key: string;
}

export let VIEWS: readonly View[] = VIEW_GROUPS.flatMap((group) => [...group.items]);

let currentRole: Role = 'viewer';

/** Narrows the views to what this login may open. Call before rendering the app. */
export function setViewRole(role: Role): void {
  if (role === currentRole) return;
  currentRole = role;
  VIEW_GROUPS = groupsFor(role);
  VIEWS = VIEW_GROUPS.flatMap((group) => [...group.items]);
}

const DEFAULT_VIEW: ViewId = 'overview';

/** "G O" style label for a view's shortcut. */
export function shortcutLabel(view: { readonly key: string }): string {
  return `G ${view.key.toUpperCase()}`;
}

/** Unknown or empty hash falls back to the overview. */
export function viewFromHash(hash: string): ViewId {
  const id = hash.replace(/^#/, '');
  const match = VIEWS.find((v) => v.id === id);
  return match ? match.id : DEFAULT_VIEW;
}
