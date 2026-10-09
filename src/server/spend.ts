import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpendByModel, SpendPoint, SpendReport } from '../shared/contract.js';

/**
 * LLM spend, read straight out of 9router's SQLite database.
 *
 * 9router exposes /api/usage but it requires the router's own auth token, which
 * the dashboard has no business holding. The database underneath is owned by the
 * same user that runs the dashboard, so reading it directly is both simpler and
 * one less credential to manage. The file is copied first and opened read-only,
 * which means the dashboard never holds a lock on a database the router is
 * actively writing — copying a live SQLite file without a lock can otherwise
 * read a torn page.
 *
 * Two hard rules:
 *
 *  1. The `apiKey` column is never selected. It holds a partial credential, and
 *     a query that selected it would put a secret into a JSON response. Every
 *     statement below names its columns explicitly for that reason.
 *  2. No credentials are read from or written to the filesystem here. If the
 *     database is absent the panel says so instead of degrading to zero, because
 *     "no spend recorded" and "cannot read spend" are different facts.
 */

const DB_PATH = process.env.NINEROUTER_DB ?? `${os.homedir()}/.9router/db/data.sqlite`;

/** Cache; the dashboard polls every 5s and this table changes slowly. */
const TTL_MS = 60_000;
let cache: { at: number; report: SpendReport } | null = null;

interface UsageRow {
  readonly timestamp: string;
  readonly model: string;
  readonly provider: string;
  readonly cost: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

interface SqliteDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/**
 * node:sqlite only exists on Node 22+. The systemd unit originally ran the
 * distro's Node 18, where this module has no database access at all — so the
 * import is dynamic and its absence is reported, not crashed on.
 */
async function openDatabase(): Promise<SqliteDatabase | { readonly error: string }> {
  if (!fs.existsSync(DB_PATH)) {
    return { error: `9router database not found at ${DB_PATH}` };
  }

  let sqlite: { DatabaseSync: new (path: string, opts: { readOnly?: boolean }) => SqliteDatabase };
  try {
    sqlite = (await import('node:sqlite')) as unknown as typeof sqlite;
  } catch {
    return {
      error:
        'node:sqlite unavailable — this runtime is older than Node 22. Set the dashboard to a Node 22+ binary to enable spend tracking.',
    };
  }

  try {
    // Copy first: opening the live file read-only still risks reading a page
    // mid-write, and the router is writing continuously.
    //
    // The copy goes to the dashboard's own data directory rather than beside the
    // source. The service runs with ProtectHome=read-only, so ~/.9router is not
    // writable and a sibling copy there fails with EROFS — which reads as "no
    // spend data" even though the real database has plenty. Writing the scratch
    // copy somewhere the service is actually allowed to write keeps the
    // distinction between "cannot read" and "nothing recorded" intact.
    const scratchDir = process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data');
    fs.mkdirSync(scratchDir, { recursive: true });
    const tmp = path.join(scratchDir, 'spend-scratch.sqlite');
    fs.copyFileSync(DB_PATH, tmp);
    const db = new sqlite.DatabaseSync(tmp, { readOnly: true });
    return db;
  } catch (err) {
    return { error: `could not read 9router database: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function hourKey(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

async function buildReport(): Promise<SpendReport> {
  const empty: SpendReport = {
    available: false,
    reason: null,
    totalRequests: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    todayCostUsd: 0,
    todayRequests: 0,
    avgCostPerRequest: 0,
    daily: [],
    hourly: [],
    byModel: [],
    source: DB_PATH,
    fetchedAt: Date.now(),
  };

  const opened = await openDatabase();
  if ('error' in opened) return { ...empty, reason: opened.error };

  const db = opened;
  try {
    // Columns are named explicitly: `apiKey` must never be selected.
    const rows = db
      .prepare(
        `SELECT timestamp, model, provider, cost, promptTokens, completionTokens
         FROM usageHistory`,
      )
      .all() as UsageRow[];

    if (rows.length === 0) {
      return { ...empty, reason: '9router has recorded no usage yet' };
    }

    let totalCost = 0;
    let totalRequests = 0;
    let totalTokens = 0;

    const daily = new Map<string, SpendPoint>();
    const hourly = new Map<number, SpendPoint>();
    const models = new Map<string, SpendByModel>();
    const today = dayKey(Date.now());

    for (const row of rows) {
      const ms = Date.parse(row.timestamp);
      if (!Number.isFinite(ms)) continue;

      const cost = Number(row.cost) || 0;
      const tokens = (Number(row.promptTokens) || 0) + (Number(row.completionTokens) || 0);

      totalCost += cost;
      totalRequests += 1;
      totalTokens += tokens;

      const d = dayKey(ms);
      const dayPoint = daily.get(d);
      if (dayPoint) {
        dayPoint.costUsd += cost;
        dayPoint.requests += 1;
        dayPoint.tokens += tokens;
      } else {
        daily.set(d, { t: Date.parse(`${d}T00:00:00Z`), requests: 1, costUsd: cost, tokens });
      }

      // Hourly detail only for the last day; older hours are noise here.
      if (Date.now() - ms < 24 * 3_600_000) {
        const h = hourKey(ms);
        const hourPoint = hourly.get(h);
        if (hourPoint) {
          hourPoint.costUsd += cost;
          hourPoint.requests += 1;
          hourPoint.tokens += tokens;
        } else {
          hourly.set(h, { t: h, requests: 1, costUsd: cost, tokens });
        }
      }

      const modelKey = `${row.model}::${row.provider}`;
      const existing = models.get(modelKey);
      if (existing) {
        existing.costUsd += cost;
        existing.requests += 1;
        existing.tokens += tokens;
      } else {
        models.set(modelKey, {
          model: row.model,
          provider: row.provider,
          requests: 1,
          costUsd: cost,
          tokens,
        });
      }
    }

    const todayPoint = daily.get(today);

    return {
      available: true,
      reason: null,
      totalRequests,
      // Six decimals: LLM cost per request is often fractions of a cent, and
      // rounding to two would show most days as $0.00.
      totalCostUsd: Number(totalCost.toFixed(6)),
      totalTokens,
      todayCostUsd: Number((todayPoint?.costUsd ?? 0).toFixed(6)),
      todayRequests: todayPoint?.requests ?? 0,
      avgCostPerRequest: totalRequests > 0 ? Number((totalCost / totalRequests).toFixed(6)) : 0,
      daily: [...daily.values()].sort((a, b) => a.t - b.t).map((p) => ({ ...p, costUsd: Number(p.costUsd.toFixed(6)) })),
      hourly: [...hourly.values()].sort((a, b) => a.t - b.t).map((p) => ({ ...p, costUsd: Number(p.costUsd.toFixed(6)) })),
      byModel: [...models.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 12),
      source: DB_PATH,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    return {
      ...empty,
      reason: `query failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`,
    };
  } finally {
    db.close();
    try {
      const scratchDir = process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data');
      fs.unlinkSync(path.join(scratchDir, 'spend-scratch.sqlite'));
    } catch {
      /* the copy is disposable; a leftover is not worth failing a request over */
    }
  }
}

export async function getSpend(): Promise<SpendReport> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.report;
  const report = await buildReport();
  cache = { at: Date.now(), report };
  return report;
}

export function spendSource(): string {
  return DB_PATH;
}