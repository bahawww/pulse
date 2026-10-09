/**
 * Dashboard views. Each one is a sidebar entry and a URL hash (#trends), so a
 * view can be bookmarked, linked to, and reached with the back button. A view
 * shows only its own panels, which keeps the page short.
 *
 * `key` is the letter that jumps to the view after pressing G (G then O for
 * the overview). Letters must stay unique.
 */
export const VIEW_GROUPS = [
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
  { title: 'Operations', items: [{ id: 'logs-and-control', label: 'Logs and control', key: 'l' }] },
] as const;

export type ViewId = (typeof VIEW_GROUPS)[number]['items'][number]['id'];

interface View {
  readonly id: ViewId;
  readonly label: string;
  readonly key: string;
}

export const VIEWS: readonly View[] = VIEW_GROUPS.flatMap((group) => [...group.items]);

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
