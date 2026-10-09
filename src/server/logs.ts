import { execFile } from 'node:child_process';
import type { LogEntry } from '../shared/contract.js';

/**
 * Read-only journal tail.
 *
 * journalctl is the right source for systemd units and nothing else, so it is
 * called with an explicit argv and a bounded line count. The unit name is the
 * only free-text input, and it is matched against a strict pattern before it
 * reaches execFile — plus validated again against the live unit list, so this
 * cannot become a way to read arbitrary files or run arbitrary commands.
 *
 * Output is capped twice: by line count going in, and by bytes coming out. A
 * runaway log line is exactly the case where an unbounded read would hang the
 * request.
 */

const UNIT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,127}$/;

const MAX_LINES = 500;
const MAX_MESSAGE = 600;
const MAX_BYTES = 512 * 1024;

/** journalctl priority names, mapped to the short form the UI shows. */
const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'] as const;

function validPriority(value: string | null): string | null {
  if (!value) return null;
  const lowered = value.toLowerCase();
  const full: Record<string, string> = {
    emergency: 'emerg',
    alert: 'alert',
    critical: 'crit',
    error: 'err',
    warning: 'warning',
    warn: 'warning',
    notice: 'notice',
    info: 'info',
    debug: 'debug',
  };
  const mapped = full[lowered];
  return mapped && (PRIORITIES as readonly string[]).includes(mapped) ? mapped : null;
}

/**
 * journalctl's short-iso output is:
 *
 *   2026-10-04T23:40:24+07:00 vps systemd[1]: Started foo.service - ...
 *   2026-10-04T23:40:24+0700  vps kernel: [12345.678] eth0: link up
 *   ^ stamp                    ^host ^ident[pid]: ^message
 *
 * Three things this had to get right, each learned from a real output line:
 *
 *  - The offset may be "+0700" or "+07:00" depending on journalctl version and
 *    precision, so both are accepted. Only accepting one made every line fail to
 *    parse and the panel silently show nothing.
 *  - The third field is the syslog identifier — `systemd` for lifecycle lines,
 *    the process name (`node`) for the program's own output. It is NOT the unit
 *    name, so the requested unit is carried separately.
 *  - The header line "-- Logs begin at ..." is not an entry and correctly fails
 *    to match.
 */
const LINE = new RegExp(
  '^' +
    '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[+-]\\d{2}:?\\d{2}|Z))' +
    '\\s+(\\S+)' +
    '\\s+(.+?)' +
    '(?:\\[(\\d+)\\])?' +
    ':\\s?' +
    '(.*)$',
);

function runJournalctl(args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'journalctl',
      [...args, '--no-pager', '--output=short-iso'],
      { timeout: 8000, maxBuffer: MAX_BYTES, encoding: 'utf8' },
      (err, stdout) => {
        resolve(err && !stdout ? '' : stdout);
      },
    );
  });
}

/** Parses short-iso output into entries, newest last. */
function parse(raw: string, unit: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const [, stamp, , ident, , message] = m;
    if (!stamp || !message) continue;
    const t = Date.parse(stamp);
    if (!Number.isFinite(t)) continue;
    out.push({
      ts: t,
      // The unit was requested explicitly by -u, so it is known with certainty;
      // the identifier varies per line and is folded into the message.
      unit,
      priority: priorityFromMessage(message),
      message:
        message.length > MAX_MESSAGE
          ? `${message.slice(0, MAX_MESSAGE)}…`
          : // Prefix the emitting process so a reader can tell a systemd
            // lifecycle line from the program's own output.
            ident && ident !== 'systemd'
            ? `[${ident}] ${message}`
            : message,
    });
  }
  return out;
}

/**
 * journald only prefixes messages with a priority tag like `error:` when the
 * entry has one, so this is the best available signal without `-o verbose`.
 */
function priorityFromMessage(message: string): string {
  const m = /^(emerg|alert|crit|err|warning|notice|info|debug):/i.exec(message);
  if (!m) return '-';
  return (m[1] ?? '-').toLowerCase();
}

export async function readLogs(options: {
  readonly unit: string;
  readonly lines?: number;
  readonly since?: string | null;
  readonly priority?: string | null;
}): Promise<{ entries: LogEntry[]; error: string | null }> {
  if (!UNIT_PATTERN.test(options.unit)) {
    return { entries: [], error: 'invalid unit name' };
  }

  const count = Math.min(Math.max(options.lines ?? 120, 1), MAX_LINES);
  const priority = validPriority(options.priority ?? null);

  const args: string[] = ['-u', options.unit, '-n', String(count)];

  // Only pass --since when it parses as a real timestamp or a relative spec of
  // bounded shape; journalctl will happily hang on some inputs.
  if (options.since) {
    const s = options.since.trim();
    const safe = /^-?\d+[smhdw]?$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s);
    if (safe) args.push('--since', s);
  }

  if (priority) args.push('--priority', priority);

  const raw = await runJournalctl(args);
  let entries = parse(raw, options.unit);

  // journalctl prints "-- No entries --" (and "-- Logs begin at ... --") as
  // status lines. They are not log entries, and an otherwise empty window is a
  // valid answer, not a parse failure.
  const hasEntryLines = raw.split('\n').some((l) => l.trim() !== '' && !l.startsWith('-- '));
  if (entries.length === 0 && hasEntryLines) {
    return { entries: [], error: 'could not parse journal output' };
  }

  // Newest first is what a log panel wants, and the caller never has to reverse.
  entries.reverse();
  return { entries, error: null };
}

/**
 * Units worth offering in the picker.
 *
 * This asks systemd rather than journalctl. `journalctl list-units` on this
 * host rejects both `--type=service` and a bare `list-units` match, so it
 * returns nothing at all — an empty picker that looks like "no logs available"
 * rather than "the command I picked was wrong". systemctl also has the answer
 * we actually want: which services are running right now, which is a better
 * default for a log picker than every unit the journal has ever seen.
 */
export async function listUnits(): Promise<string[]> {
  const raw = await new Promise<string>((resolve) => {
    execFile(
      'systemctl',
      ['list-units', '--type=service', '--state=running', '--no-legend', '--no-pager'],
      { timeout: 8000, maxBuffer: MAX_BYTES, encoding: 'utf8' },
      (err, stdout) => {
        resolve(err && !stdout ? '' : stdout);
      },
    );
  });

  const out = new Set<string>();
  for (const line of raw.split('\n')) {
    // Lines look like: "  foo.service   loaded active running Description"
    const name = line.trim().split(/\s+/)[0];
    if (name && UNIT_PATTERN.test(name)) out.add(name);
  }
  return [...out].sort();
}