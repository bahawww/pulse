/**
 * What was typed and not sent, kept per chat in this browser (localStorage), so
 * switching chats or reloading the page does not lose it. The 30 most recent
 * drafts are kept; an empty draft is removed.
 */

const KEY = 'vps_chat_drafts';
const MAX = 30;

interface Entry {
  readonly t: string;
  readonly at: number;
}

function read(): Record<string, Entry> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

const slot = (id: string | null): string => id ?? 'new';

export function loadDraft(id: string | null): string {
  const e = read()[slot(id)];
  return e && typeof e.t === 'string' ? e.t : '';
}

export function saveDraft(id: string | null, text: string): void {
  try {
    const all = read();
    if (text.trim() === '') delete all[slot(id)];
    else all[slot(id)] = { t: text, at: Date.now() };
    const keep = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    /* private mode or full: a draft is a convenience */
  }
}
