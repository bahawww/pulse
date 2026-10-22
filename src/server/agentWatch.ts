import type { AgentState } from '../shared/contract.js';
import { AGENT_NAME } from './agents.js';
import { runRemote, type RunResult } from './files.js';
import { hasSubscriptions, pushTo } from './push.js';
import { superadminNames } from './session.js';
import { tmuxSeen } from './terminal.js';
import { clean } from './termNotify.js';

/**
 * Watches the agent sessions (agy-*, cc-* in tmux) so a phone hears about them:
 * a push when one finishes its turn or stops to ask for permission. Read only:
 * the answer is always given in the session itself (terminal or remote link).
 *
 * One loopback ssh call every POLL_MS reads the bottom of every agent pane.
 * State comes from what the agent draws: "esc to interrupt" while it works, a
 * "Do you want to…" menu with "❯ 1. Yes" when it waits for permission.
 */

const POLL_MS = 5_000;

export interface PaneState {
  readonly state: AgentState;
  /** The question and the lines just above it (the command or file it is about). */
  readonly ask: string | null;
}

/** Box-drawing borders and blank lines out, the rest trimmed. */
function lines(pane: string): string[] {
  return pane
    .split('\n')
    .map((l) => l.replace(/[│╭╮╰╯─━┃]+/g, ' ').trim())
    .filter(Boolean);
}

export function paneState(pane: string): PaneState {
  const all = lines(pane);
  const tail = all.slice(-18);
  const q = tail.findIndex((l) => /^(Do you want to|Would you like to|Allow\b)/i.test(l) || /\(y\/n\)\s*$/i.test(l));
  if (q >= 0 && tail.slice(q).some((l) => /^❯?\s*1\.\s/.test(l))) {
    const ask = clean(tail.slice(Math.max(0, q - 3), q + 1).join(' · '), 240);
    return { state: 'waiting', ask };
  }
  if (all.slice(-6).some((l) => /esc to interrupt/i.test(l))) return { state: 'working', ask: null };
  return { state: 'idle', ask: null };
}

// ------------------------------------------------------------------ watcher

const run = (cmd: string): Promise<RunResult> => runRemote(cmd, 512 * 1024);
const known = new Map<string, PaneState>();

const READ_ALL = `tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^(agy|cc)-' | while IFS= read -r s; do printf '\\0%s\\n' "$s"; tmux capture-pane -p -t "=$s:" 2>/dev/null | tail -n 40; done; true`;

/** Current state of every agent pane, by session name. */
async function readPanes(): Promise<Map<string, PaneState>> {
  const out = new Map<string, PaneState>();
  const r = await run(READ_ALL);
  for (const part of r.stdout.toString('utf8').split('\0').slice(1)) {
    const nl = part.indexOf('\n');
    const name = nl < 0 ? part : part.slice(0, nl);
    if (AGENT_NAME.test(name)) out.set(name, paneState(nl < 0 ? '' : part.slice(nl + 1)));
  }
  return out;
}

function tell(name: string, now: PaneState): void {
  if (tmuxSeen(name)) return;
  const to = superadminNames().filter(hasSubscriptions);
  if (!to.length) return;
  const msg =
    now.state === 'waiting'
      ? {
          title: `${name} needs your answer`,
          body: now.ask ?? 'It is waiting for permission.',
          tag: `agent-${name}`,
          url: '/#overview',
        }
      : { title: `${name} is done`, body: 'Finished its turn and waits for you.', tag: `agent-${name}`, url: '/#overview' };
  for (const user of to) void pushTo(user, msg);
}

async function tick(): Promise<void> {
  let panes: Map<string, PaneState>;
  try {
    panes = await readPanes();
  } catch {
    return;
  }
  for (const [name, now] of panes) {
    const before = known.get(name);
    known.set(name, now);
    // A session seen for the first time (or after a restart) says nothing: only changes are news.
    if (!before) continue;
    if (now.state === 'waiting' && (before.state !== 'waiting' || before.ask !== now.ask)) tell(name, now);
    else if (now.state === 'idle' && before.state === 'working') tell(name, now);
  }
  for (const name of [...known.keys()]) if (!panes.has(name)) known.delete(name);
}

let timer: NodeJS.Timeout | null = null;

export function startAgentWatch(): void {
  if (timer) return;
  let busy = false;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick().finally(() => {
      busy = false;
    });
  }, POLL_MS);
  timer.unref();
}

export function stopAgentWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Last seen state of a session, for the session list. */
export function knownState(name: string): PaneState | undefined {
  return known.get(name);
}
