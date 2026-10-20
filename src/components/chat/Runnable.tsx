import { type JSX, createContext, useState } from 'react';

import { postJson } from '../../lib/csrf';
import type { ActionResult } from '../../shared/contract';
import { PlayIcon } from '../icons';

/**
 * When an answer suggests `systemctl restart x` or `docker restart y` for
 * something Service control manages, the code block gets a Run button. It goes
 * through the same /api/action as the Operations view: the confirmation step,
 * the audit log and the permission check are the dashboard's, not the agent's,
 * and Auto mode has no part in it.
 */

export interface RunTargets {
  readonly systemd: readonly { readonly id: string; readonly unit: string; readonly scope: 'system' | 'user' }[];
  readonly docker: readonly string[];
}

/** Null where the login may not control services (no buttons). */
export const RunContext = createContext<RunTargets | null>(null);

type Verb = 'restart' | 'start' | 'stop';

export interface Runnable {
  readonly target: 'systemd' | 'docker';
  /** The id Service control knows it by. */
  readonly name: string;
  readonly action: Verb;
}

const SYSTEMCTL = /^(?:sudo\s+)?systemctl\s+(--user\s+)?(restart|start|stop)\s+([A-Za-z0-9][\w@.:-]*)$/;
const DOCKER = /^(?:sudo\s+)?docker\s+(restart|start|stop)\s+([A-Za-z0-9][\w.-]*)$/;

const bare = (unit: string): string => unit.replace(/\.service$/, '');

/** Whole-line, single commands only: a pipe, `&&` or `;` is not offered. */
export function findRunnables(code: string, t: RunTargets): Runnable[] {
  const out: Runnable[] = [];
  const seen = new Set<string>();
  const add = (r: Runnable) => {
    const key = `${r.target}:${r.action}:${r.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  };
  for (const raw of code.split('\n')) {
    const line = raw.trim().replace(/^[$#]\s+/, '');
    const sys = SYSTEMCTL.exec(line);
    if (sys) {
      const scope = sys[1] ? 'user' : 'system';
      const unit = sys[3]!;
      const hit = t.systemd.find((x) => x.scope === scope && (x.id === unit || bare(x.unit) === bare(unit)));
      if (hit) add({ target: 'systemd', name: hit.id, action: sys[2] as Verb });
      continue;
    }
    const dock = DOCKER.exec(line);
    if (dock && t.docker.includes(dock[2]!)) add({ target: 'docker', name: dock[2]!, action: dock[1] as Verb });
  }
  return out;
}

const VERB_LABEL: Readonly<Record<Verb, string>> = { restart: 'Restart', start: 'Start', stop: 'Stop' };

export function RunnableBar({ items }: { readonly items: readonly Runnable[] }): JSX.Element {
  const [pending, setPending] = useState<{ item: Runnable; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function post(item: Runnable, token?: string) {
    setBusy(true);
    try {
      const res = await postJson('/api/action', { target: item.target, name: item.name, action: item.action, ...(token ? { confirm: token } : {}) });
      const body = (await res.json()) as ActionResult & { confirmToken?: string };
      if (!res.ok) {
        setResult({ ...body, ok: false, message: body.message || `HTTP ${res.status}` });
        setPending(null);
      } else if (body.confirmToken) {
        setPending({ item, token: body.confirmToken });
        setResult(null);
      } else {
        setResult(body);
        setPending(null);
      }
    } catch {
      setResult({ ok: false, target: item.target, name: item.name, action: item.action, message: 'Request failed. Is the dashboard still running?', stdout: '', durationMs: 0 });
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-run">
      {pending ? (
        <div className="chat-run-confirm" role="alertdialog" aria-label="Confirm">
          <span>
            {VERB_LABEL[pending.item.action]} <strong>{pending.item.name}</strong> ({pending.item.target === 'docker' ? 'container' : 'systemd unit'}) on this host?
            {pending.item.action === 'stop' && ' It stays down until someone starts it again.'}
          </span>
          <span className="chat-run-buttons">
            <button type="button" className={`btn btn-sm ${pending.item.action === 'start' ? 'btn-primary' : 'btn-danger'}`} disabled={busy} onClick={() => void post(pending.item, pending.token)}>
              {busy ? 'Working…' : `Yes, ${pending.item.action}`}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        items.map((item) => (
          <button
            key={`${item.target}:${item.action}:${item.name}`}
            type="button"
            className="btn btn-sm chat-run-btn"
            disabled={busy}
            title="Runs through Service control: it asks you to confirm and is logged"
            onClick={() => void post(item)}
          >
            <PlayIcon size={11} />
            {VERB_LABEL[item.action]} {item.name}
          </button>
        ))
      )}
      {result && (
        <div className={`chat-run-result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
          {result.message}
        </div>
      )}
    </div>
  );
}
