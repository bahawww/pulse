import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './panels';

export interface Command {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  /** Second line: the command a snippet runs, the host a connection opens. */
  readonly detail?: string;
  readonly keys?: string;
  readonly icon?: ReactNode;
  /** A command made from the typed text that should not push real matches down (run as shell command). */
  readonly last?: boolean;
  readonly run: () => void;
}

interface PaletteProps {
  readonly commands: readonly Command[];
  /** Extra commands made from the text typed (quick connect, run as command). */
  readonly fromQuery?: (query: string) => readonly Command[];
  readonly onClose: () => void;
}

/**
 * Subsequence match: every typed character in order. Consecutive runs and word
 * starts score higher, so "spr" finds "Split right" before "Snippets: Processes".
 */
function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of query) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    const wordStart = found === 0 || /[\s:/@._-]/.test(t[found - 1] ?? '');
    s += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(found - ti, 6) * 0.2;
    ti = found + 1;
  }
  return s;
}

/** Every workspace action, window, connection and snippet behind one search box (Ctrl+Shift+P). */
export function CommandPalette({ commands, fromQuery, onClose }: PaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const extra = q ? (fromQuery?.(query.trim()) ?? []) : [];
    const ranked = commands
      .map((c) => ({ c, s: score(`${c.group} ${c.title} ${c.detail ?? ''}`, q.replace(/\s+/g, '')) }))
      .filter((x) => x.s > 0);
    if (q) ranked.sort((a, b) => b.s - a.s);
    return [...extra.filter((c) => !c.last), ...ranked.map((x) => x.c), ...extra.filter((c) => c.last)].slice(0, 80);
  }, [commands, fromQuery, q, query]);
  const at = Math.min(cursor, Math.max(0, shown.length - 1));

  useEffect(() => {
    list.current?.querySelector('.is-at')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    // After the palette is gone, so focus lands where the command puts it.
    requestAnimationFrame(c.run);
  };

  let lastGroup = '';
  return (
    <div className="tw-cmd-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tw-cmd" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="tw-cmd-input-row">
          <Icon.command size={16} />
          <input
            ref={input}
            className="tw-cmd-input"
            placeholder="Type a command, a window, user@host to connect…"
            aria-label="Command"
            value={query}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => (c + 1) % Math.max(1, shown.length));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => (c - 1 + shown.length) % Math.max(1, shown.length));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(shown[at]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
              e.stopPropagation();
            }}
          />
        </div>
        <ul ref={list} className="tw-cmd-list" role="listbox" aria-label="Commands">
          {shown.map((c, i) => {
            const head = !q && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="none">
                {head && <div className="tw-cmd-group">{head}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === at}
                  className={`tw-cmd-item${i === at ? ' is-at' : ''}`}
                  onMouseMove={() => i !== at && setCursor(i)}
                  onClick={() => run(c)}
                >
                  <span className="tw-cmd-glyph">{c.icon ?? <Icon.command size={14} />}</span>
                  <span className="tw-cmd-text">
                    <span className="tw-cmd-title">
                      {q && <span className="tw-cmd-in">{c.group} · </span>}
                      {c.title}
                    </span>
                    {c.detail && <code className="tw-cmd-detail">{c.detail}</code>}
                  </span>
                  {c.keys && <kbd>{c.keys}</kbd>}
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="tw-snip-empty">Nothing matches “{query}”.</li>}
        </ul>
        <div className="tw-cmd-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> choose
          </span>
          <span>
            <kbd>Enter</kbd> run
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
