/**
 * Finds the "look at me" signals in a shell's output stream: a bell (BEL that
 * is not the end of an escape string), OSC 777 `notify;title;body` (the
 * `printf '\e]777;notify;…\a'` the terminal's "Notify when done" types) and
 * OSC 9 `text` (iTerm2-style, sent by agents and build tools).
 *
 * Output arrives in arbitrary chunks, so the scanner keeps its state between
 * calls. Most chunks hold neither a BEL nor an OSC start and are skipped
 * without a per-character loop.
 */

export interface Notice {
  readonly kind: 'bell' | 'notify';
  readonly title: string;
  readonly body: string;
}

type State = 'text' | 'esc' | 'osc' | 'osc-esc' | 'str' | 'str-esc';

/** Longest OSC payload kept; longer ones are window titles or clipboard data, never a notice. */
const MAX_OSC = 1024;

/** Control characters out, length capped: the text goes into a system notification. */
export function clean(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function fromOsc(data: string): Notice | null {
  if (data.startsWith('777;notify;')) {
    const rest = data.slice('777;notify;'.length);
    const cut = rest.indexOf(';');
    const title = cut < 0 ? rest : rest.slice(0, cut);
    const body = cut < 0 ? '' : rest.slice(cut + 1);
    return { kind: 'notify', title: clean(title, 80), body: clean(body, 200) };
  }
  // OSC 9;4;… is a progress bar and 9;1…9;12 are ConEmu commands, not notices.
  if (data.startsWith('9;') && !/^9;\d+(;|$)/.test(data)) {
    return { kind: 'notify', title: '', body: clean(data.slice(2), 200) };
  }
  return null;
}

export function createScanner(): (chunk: string) => Notice[] {
  let state: State = 'text';
  let osc = '';

  return (chunk) => {
    if (state === 'text' && !chunk.includes('\x07') && !chunk.includes('\x1b]') && !chunk.endsWith('\x1b')) return [];
    const out: Notice[] = [];
    const endOsc = () => {
      const n = osc.length <= MAX_OSC ? fromOsc(osc) : null;
      if (n) out.push(n);
      osc = '';
      state = 'text';
    };
    for (let i = 0; i < chunk.length; i += 1) {
      const c = chunk[i];
      switch (state) {
        case 'text':
          if (c === '\x1b') state = 'esc';
          else if (c === '\x07') out.push({ kind: 'bell', title: '', body: '' });
          break;
        case 'esc':
          if (c === ']') {
            state = 'osc';
            osc = '';
          } else if (c === 'P' || c === 'X' || c === '^' || c === '_') state = 'str';
          else state = c === '\x1b' ? 'esc' : 'text';
          break;
        case 'osc':
          if (c === '\x07') endOsc();
          else if (c === '\x1b') state = 'osc-esc';
          else if (osc.length <= MAX_OSC) osc += c;
          break;
        case 'osc-esc':
          if (c === '\\') endOsc();
          else {
            // A stray ESC aborts the string; it starts a new sequence.
            osc = '';
            state = c === ']' ? 'osc' : 'text';
          }
          break;
        case 'str':
          if (c === '\x1b') state = 'str-esc';
          else if (c === '\x07') state = 'text';
          break;
        case 'str-esc':
          state = c === '\\' ? 'text' : 'str';
          break;
      }
    }
    return out;
  };
}
