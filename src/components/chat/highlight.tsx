import type { ReactNode } from 'react';

/**
 * A small syntax highlighter for the code in agent replies. No dependency, no
 * HTML strings: it splits the text into React nodes, so nothing the model
 * writes can become markup. One combined regex per language (comments and
 * strings first, so a keyword inside either stays plain). An unclosed string or
 * comment, as in a reply still streaming, is coloured to the end.
 *
 * Classes: tok-k keyword, tok-s string, tok-c comment, tok-n number,
 * tok-f function, tok-p property or key, tok-v variable (chat.css).
 */

type Rule = readonly [cls: string, re: RegExp];

/** Longest text coloured; past it the block stays plain (a log pasted as "code"). */
const MAX_CHARS = 40_000;

const words = (list: string): RegExp => new RegExp(`\\b(?:${list.trim().split(/\s+/).join('|')})\\b`);

const C_COMMENT: Rule = ['c', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/];
const HASH_COMMENT: Rule = ['c', /(?<=^|\s)#[^\n]*/];
const DQ: Rule = ['s', /"(?:[^"\\\n]|\\.)*"?/];
const SQ: Rule = ['s', /'(?:[^'\\\n]|\\.)*'?/];
const BT: Rule = ['s', /`(?:[^`\\]|\\.)*`?/];
const NUM: Rule = ['n', /\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/];
const FN: Rule = ['f', /\b[A-Za-z_$][\w$]*(?=\()/];

interface Lang {
  readonly rules: readonly Rule[];
  readonly flags?: string;
}

const JS_KW = `const let var function return if else for while do switch case break continue new class extends import from export default
  async await try catch finally throw typeof instanceof in of void delete yield static get set interface type enum implements public
  private protected readonly as satisfies declare namespace abstract this super true false null undefined`;

const CLIKE_KW = `abstract as async await break case catch chan class const continue crate default defer do else enum extends extern false final finally
  fn for func go goto if impl implements import in interface let loop match mod move mut namespace new nil null override package private
  protected pub public ref return select self static struct super switch this throw throws trait true try type typedef union unsafe use
  val var virtual void volatile where while with yield int long short char float double bool boolean string byte uint u8 u16 u32 u64 i8
  i16 i32 i64 usize isize`;

const PY_KW = `and as assert async await break class continue def del elif else except finally for from global if import in is lambda
  nonlocal not or pass raise return try while with yield True False None self cls`;

const SH_KW = `if then else elif fi for while until do done case esac function in select time return exit break continue local export readonly
  declare unset source alias sudo`;

const SQL_KW = `select from where and or not insert into values update set delete create alter drop table index view join left right inner outer
  full cross on group by order having limit offset as distinct union all null is in like between exists case when then else end
  primary key foreign references default unique constraint begin commit rollback with returning count sum avg min max asc desc`;

const LANGS: Readonly<Record<string, Lang>> = {
  js: { rules: [C_COMMENT, BT, DQ, SQ, NUM, ['k', words(JS_KW)], FN] },
  json: { rules: [['p', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/], DQ, NUM, ['k', words('true false null')]] },
  py: {
    rules: [
      HASH_COMMENT,
      ['s', /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/],
      DQ,
      SQ,
      NUM,
      ['f', /@[A-Za-z_][\w.]*/],
      ['k', words(PY_KW)],
      FN,
    ],
  },
  sh: {
    rules: [
      HASH_COMMENT,
      DQ,
      SQ,
      ['v', /\$(?:\{[^}\n]*\}?|\([^)\n]*\)?|[A-Za-z_]\w*|[0-9@#?*$!-])/],
      ['p', /(?<=\s)--?[A-Za-z][\w-]*/],
      NUM,
      ['k', words(SH_KW)],
    ],
  },
  yaml: {
    rules: [
      HASH_COMMENT,
      ['p', /^[ \t-]*[\w./-]+(?=[ \t]*:(?:\s|$))/m],
      DQ,
      SQ,
      NUM,
      ['k', words('true false null yes no on off')],
    ],
  },
  css: {
    rules: [
      ['c', /\/\*[\s\S]*?(?:\*\/|$)/],
      DQ,
      SQ,
      ['k', /@[\w-]+/],
      ['n', /#[\da-fA-F]{3,8}\b|-?\b\d[\d.]*(?:px|em|rem|%|vh|vw|vmin|vmax|ch|s|ms|deg|fr)?/],
      ['p', /[\w-]+(?=\s*:)/],
    ],
  },
  html: { rules: [['c', /<!--[\s\S]*?(?:-->|$)/], DQ, SQ, ['k', /<\/?[A-Za-z][\w:.-]*|\/?>/], ['p', /[\w:-]+(?==)/]] },
  sql: { rules: [['c', /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/], SQ, DQ, NUM, ['k', words(SQL_KW)], FN], flags: 'i' },
  clike: { rules: [C_COMMENT, BT, DQ, SQ, NUM, ['k', words(CLIKE_KW)], FN] },
  ini: {
    rules: [
      ['c', /(?<=^|\s)[#;][^\n]*/m],
      ['k', /^[ \t]*\[[^\]\n]+\]/m],
      ['p', /^[ \t]*[\w.-]+(?=[ \t]*=)/m],
      DQ,
      SQ,
      NUM,
      ['k', words('true false')],
    ],
  },
  docker: {
    rules: [
      HASH_COMMENT,
      DQ,
      SQ,
      ['k', /^[ \t]*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/m],
      ['v', /\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*)/],
    ],
  },
};

const ALIAS: Readonly<Record<string, keyof typeof LANGS | 'diff'>> = {
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  javascript: 'js',
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  py: 'py',
  python: 'py',
  sh: 'sh',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  console: 'sh',
  shellscript: 'sh',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  sql: 'sql',
  psql: 'sql',
  mysql: 'sql',
  go: 'clike',
  golang: 'clike',
  rust: 'clike',
  rs: 'clike',
  c: 'clike',
  h: 'clike',
  cpp: 'clike',
  cc: 'clike',
  'c++': 'clike',
  java: 'clike',
  kotlin: 'clike',
  kt: 'clike',
  swift: 'clike',
  php: 'clike',
  cs: 'clike',
  csharp: 'clike',
  scala: 'clike',
  dart: 'clike',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  env: 'ini',
  properties: 'ini',
  dockerfile: 'docker',
  docker: 'docker',
  diff: 'diff',
  patch: 'diff',
};

interface Compiled {
  readonly re: RegExp;
  readonly classes: readonly string[];
}

const compiled = new Map<string, Compiled>();

function compile(key: string, lang: Lang): Compiled {
  const hit = compiled.get(key);
  if (hit) return hit;
  const flags = `g${lang.flags ?? ''}${lang.rules.some(([, r]) => r.multiline) ? 'm' : ''}`;
  const c: Compiled = {
    re: new RegExp(lang.rules.map(([, r]) => `(${r.source})`).join('|'), flags),
    classes: lang.rules.map(([cls]) => cls),
  };
  compiled.set(key, c);
  return c;
}

function diffLines(code: string): ReactNode[] {
  return code.split('\n').map((line, i, all) => {
    const cls = line.startsWith('+++') || line.startsWith('---') ? 'tok-k' : line.startsWith('@@') ? 'tok-f' : line.startsWith('+') ? 'tok-add' : line.startsWith('-') ? 'tok-del' : '';
    const text = i < all.length - 1 ? `${line}\n` : line;
    return cls ? (
      <span key={i} className={cls}>
        {text}
      </span>
    ) : (
      text
    );
  });
}

/** The language a fence names, as one of ours, or null when it is not known. */
export function languageOf(lang: string): string | null {
  return ALIAS[lang.toLowerCase()] ?? null;
}

/** `code` as plain strings and coloured spans; the text itself is unchanged. */
export function highlight(code: string, lang: string): ReactNode[] {
  const id = languageOf(lang);
  if (!id || code.length > MAX_CHARS) return [code];
  if (id === 'diff') return diffLines(code);
  const def = LANGS[id];
  if (!def) return [code];
  const { re, classes } = compile(id, def);
  const out: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) out.push(code.slice(last, m.index));
    let g = 1;
    while (g < m.length && m[g] === undefined) g += 1;
    out.push(
      <span key={m.index} className={`tok-${classes[g - 1] ?? 'k'}`}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
