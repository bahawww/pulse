import { type JSX, type ReactNode, memo, useContext, useMemo, useState } from 'react';
import { CheckIcon, CopyIcon } from '../icons';
import { copyText } from './clip';
import { highlight } from './highlight';
import { RunContext, RunnableBar, findRunnables } from './Runnable';

/** Fence languages a person would run in a shell. */
const SHELL = new Set(['', 'text', 'sh', 'bash', 'shell', 'zsh', 'console', 'shellscript']);

/**
 * A small Markdown renderer for agent replies. It builds React elements and
 * never HTML strings, so text from the model cannot inject markup: an
 * `<img onerror>` in a reply shows as those characters. Links open only for
 * http(s) and mailto.
 *
 * Covers what agents write: fenced code, headings, lists (nested by indent),
 * quotes, tables, rules, paragraphs; inline code, bold, italic, strike,
 * links and bare URLs. Parsed again on every change, which is cheap at chat
 * sizes, and an unclosed fence while streaming renders as code so far.
 */

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'rule' }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; start: number; items: string[][] }
  | { kind: 'table'; head: string[]; align: ('left' | 'center' | 'right' | null)[]; rows: string[][] }
  | { kind: 'para'; lines: string[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(mark)) body.push(lines[i++]!);
      i += 1;
      out.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const q: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) q.push(lines[i++]!.replace(QUOTE, ''));
      out.push({ kind: 'quote', lines: q });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push({ kind: 'table', head, align, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      const indent = bullet[1]!.length;
      const ordered = /\d/.test(bullet[2]!);
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const b = BULLET.exec(l);
        if (b && b[1]!.length <= indent + 1 && /\d/.test(b[2]!) === ordered) {
          items.push([b[3]!]);
          i += 1;
          continue;
        }
        // Indented lines (a nested list, a continuation) belong to the last item.
        if (items.length && l.trim() && (/^\s/.test(l) || (!BULLET.exec(l) && !FENCE.test(l) && !HEADING.test(l)))) {
          items[items.length - 1]!.push(l.slice(Math.min(indent + 2, l.length - l.trimStart().length)));
          i += 1;
          continue;
        }
        if (!l.trim() && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && items.length) {
          items[items.length - 1]!.push('');
          i += 1;
          continue;
        }
        break;
      }
      out.push({ kind: 'list', ordered, start: ordered ? parseInt(bullet[2]!, 10) || 1 : 1, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !HEADING.test(lines[i]!) && !QUOTE.test(lines[i]!) && !(para.length && BULLET.test(lines[i]!))) {
      para.push(lines[i++]!);
    }
    out.push({ kind: 'para', lines: para });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])|\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]])/g;

function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE.source, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    if (m[2] !== undefined) out.push(<code key={k}>{m[2].replace(/^ (.*) $/, '$1')}</code>);
    else if (m[3] !== undefined) out.push(<strong key={k}>{inline(m[3], k)}</strong>);
    else if (m[4] !== undefined) out.push(<strong key={k}>{inline(m[4], k)}</strong>);
    else if (m[5] !== undefined) out.push(<del key={k}>{inline(m[5], k)}</del>);
    else if (m[6] !== undefined) out.push(<em key={k}>{inline(m[6], k)}</em>);
    else if (m[7] !== undefined) out.push(<em key={k}>{inline(m[7], k)}</em>);
    else if (m[8] !== undefined) {
      const href = safeHref(m[9]!);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {inline(m[8], k)}
          </a>
        ) : (
          <span key={k}>{inline(m[8], k)}</span>
        ),
      );
    } else if (m[10] !== undefined) {
      out.push(
        <a key={k} href={m[10]} target="_blank" rel="noopener noreferrer nofollow">
          {m[10]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Paragraph lines: a hard break where the source had one ("  " or "\"), else a space. */
function lines(ls: readonly string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  ls.forEach((l, i) => {
    const hard = /( {2,}|\\)$/.test(l);
    out.push(...inline(l.replace(/( {2,}|\\)$/, ''), `${key}.${i}`));
    if (i < ls.length - 1) out.push(hard ? <br key={`${key}.br${i}`} /> : ' ');
  });
  return out;
}

export function CodeBlock({ code, lang }: { readonly code: string; readonly lang: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  // Phones start wrapped: sideways scrolling inside a scrolling chat is hard to use.
  const [wrap, setWrap] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  const nodes = useMemo(() => highlight(code, lang), [code, lang]);
  const targets = useContext(RunContext);
  const runnables = useMemo(() => (targets && SHELL.has(lang.toLowerCase()) ? findRunnables(code, targets) : []), [code, lang, targets]);
  const copy = () => {
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className={`md-code${wrap ? ' is-wrap' : ''}`}>
      <div className="md-code-head">
        <span>{lang || 'text'}</span>
        <span className="md-code-tools">
          <button type="button" className="md-copy" onClick={() => setWrap(!wrap)} aria-pressed={wrap} aria-label="Wrap long lines">
            <span>Wrap</span>
          </button>
          <button type="button" className="md-copy" onClick={copy} aria-label="Copy code">
            {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </span>
      </div>
      <pre>
        <code>{nodes}</code>
      </pre>
      {runnables.length > 0 && <RunnableBar items={runnables} />}
    </div>
  );
}

function render(blocks: readonly Block[], key: string): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.kind) {
      case 'code':
        return <CodeBlock key={k} code={b.text} lang={b.lang} />;
      case 'heading': {
        const H = `h${Math.min(6, b.level + 2)}` as 'h3';
        return <H key={k}>{inline(b.text, k)}</H>;
      }
      case 'rule':
        return <hr key={k} />;
      case 'quote':
        return <blockquote key={k}>{render(parseBlocks(b.lines.join('\n')), k)}</blockquote>;
      case 'list': {
        const items = b.items.map((item, j) => {
          const sub = parseBlocks(item.join('\n'));
          // A one-paragraph item renders bare, without a <p> margin.
          const only = sub.length === 1 && sub[0]!.kind === 'para' ? lines(sub[0]!.lines, `${k}.${j}`) : render(sub, `${k}.${j}`);
          return <li key={j}>{only}</li>;
        });
        return b.ordered ? (
          <ol key={k} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case 'table':
        return (
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                      {inline(c, `${k}.h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {b.head.map((_, j) => (
                      <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                        {inline(r[j] ?? '', `${k}.${ri}.${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'para':
        return <p key={k}>{lines(b.lines, k)}</p>;
      default:
        return null;
    }
  });
}

export const Markdown = memo(function Markdown({ text }: { readonly text: string }): JSX.Element {
  return <div className="md">{render(parseBlocks(text), 'b')}</div>;
});
