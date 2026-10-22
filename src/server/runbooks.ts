import type { Request, Response } from 'express';
import type { Runbook, RunbookStep, RunbooksBody } from '../shared/contract.js';
import { loadSetting, recentActions, recordAction, saveSetting } from './store.js';

/**
 * Runbooks: named procedures whose steps a person runs one at a time in the
 * terminal, seeing each command before it runs. The list lives in the store's
 * settings so every device sees the same one; each step run (its exit code
 * comes back from the shell) goes to the action log, which is the history.
 */

const KEY = 'runbooks';
const MAX_BOOKS = 50;
const MAX_STEPS = 20;
const ID = /^[a-z0-9-]{1,40}$/;

export const DEFAULT_RUNBOOKS: readonly Runbook[] = [
  {
    id: 'disk-space',
    name: 'Free disk space',
    steps: [
      { label: 'See what is full', command: 'df -h / && sudo du -xh --max-depth=1 /var 2>/dev/null | sort -h | tail -8' },
      { label: 'Trim the journal to 7 days', command: 'sudo journalctl --vacuum-time=7d' },
      { label: 'Remove unused Docker data', command: 'docker system prune -f' },
      { label: 'Check again', command: 'df -h /' },
    ],
  },
  {
    id: 'service-health',
    name: 'Service health',
    steps: [
      { label: 'Failed units', command: 'systemctl --failed --no-pager' },
      { label: 'Containers not running', command: "docker ps -a --filter status=exited --filter status=restarting --format '{{.Names}}\\t{{.Status}}'" },
      { label: 'Pulse health', command: 'curl -s http://127.0.0.1/api/health' },
    ],
  },
];

/** The list from a client, or an error to show. */
export function parseRunbooks(body: unknown): Runbook[] | string {
  const list = (body as { runbooks?: unknown } | null)?.runbooks;
  if (!Array.isArray(list) || list.length > MAX_BOOKS) return `up to ${MAX_BOOKS} runbooks`;
  const out: Runbook[] = [];
  const ids = new Set<string>();
  for (const b of list as { id?: unknown; name?: unknown; steps?: unknown }[]) {
    if (typeof b?.id !== 'string' || !ID.test(b.id) || ids.has(b.id)) return 'bad runbook id';
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 60) return 'each runbook needs a name (60 characters at most)';
    if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.length > MAX_STEPS) return `each runbook needs 1 to ${MAX_STEPS} steps`;
    const steps: RunbookStep[] = [];
    for (const s of b.steps as { label?: unknown; command?: unknown }[]) {
      if (typeof s?.command !== 'string' || !s.command.trim() || s.command.length > 2000 || /[\r\n]/.test(s.command)) return 'each step is one line of command';
      const label = typeof s.label === 'string' ? s.label.trim().slice(0, 80) : '';
      steps.push({ label, command: s.command.trim() });
    }
    ids.add(b.id);
    out.push({ id: b.id, name: b.name.trim(), steps });
  }
  return out;
}

function body(): RunbooksBody {
  return {
    runbooks: loadSetting<Runbook[] | null>(KEY, null) ?? [...DEFAULT_RUNBOOKS],
    runs: recentActions(300)
      .filter((a) => a.target === 'runbook')
      .slice(0, 30),
  };
}

export function getRunbooks(_req: Request, res: Response): void {
  res.json(body());
}

export function putRunbooks(req: Request, res: Response): void {
  const list = parseRunbooks(req.body);
  if (typeof list === 'string') {
    res.status(400).json({ error: list });
    return;
  }
  if (!saveSetting(KEY, list)) {
    res.status(503).json({ error: 'the store is not open' });
    return;
  }
  res.json(body());
}

/** One step done in the terminal: its exit code (null when the shell never said). */
export function postStep(req: Request, res: Response): void {
  const b = req.body as { runbook?: unknown; step?: unknown; total?: unknown; command?: unknown; code?: unknown; ms?: unknown };
  const step = Number(b.step);
  const total = Number(b.total);
  if (typeof b.runbook !== 'string' || !b.runbook || b.runbook.length > 60 || !Number.isInteger(step) || !Number.isInteger(total) || step < 1 || step > total || total > MAX_STEPS) {
    res.status(400).json({ error: 'bad step' });
    return;
  }
  const code = typeof b.code === 'number' && Number.isInteger(b.code) ? b.code : null;
  const command = typeof b.command === 'string' ? b.command.slice(0, 200) : '';
  recordAction({
    ts: Date.now(),
    target: 'runbook',
    name: b.runbook,
    action: code === -1 ? `skip ${step}/${total}` : `step ${step}/${total}`,
    ok: code === 0 || code === -1,
    message: code === -1 ? `skipped: ${command}` : `${command} · ${code === null ? 'no exit code' : `exit ${code}`}`,
    durationMs: Math.max(0, Math.min(86_400_000, Number(b.ms) || 0)),
  });
  res.json({ ok: true });
}
