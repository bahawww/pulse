/** Each service keeps one categorical colour for its whole life on the page. */
export const SERVICE_COLOR: Readonly<Record<string, string>> = {
  hermes: 'var(--s-mem)',
  '9router': 'var(--s-disk)',
  opencode: 'var(--s-tx)',
  novnc: 'var(--s-cpu)',
  coolify: 'var(--s-rx)',
};

/** Colour for a service id; unknown ids fall back to the neutral text colour. */
export function serviceColor(id: string): string {
  return SERVICE_COLOR[id] ?? 'var(--text-2)';
}
