import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  ActionLogEntry,
  AlertEvent,
  AlertSeverity,
  ContainerSample,
  HistorySample,
  ProcessSample,
} from '../shared/contract.js';

/**
 * Durable telemetry storage on SQLite (node:sqlite, no native modules).
 *
 * Why persist now: the history buffer is in-memory, so every restart began an
 * empty window. That made the charts briefly useless after each deploy, and it
 * also made "zoom into the last 20 minutes" impossible right after a restart
 * because there was only a handful of samples to zoom into.
 *
 * Design notes:
 *
 *  - One row per sample, with the scalar host metrics as REAL columns and the
 *    optional nested series (latency / containers / processes) as JSON text.
 *    JSON keeps the schema stable as services and containers come and go, and
 *    these series are read whole rather than queried by key.
 *  - WAL mode so a chart read never blocks the 5s sampler write.
 *  - Writes happen on the sampler's own tick, inside a transaction, and are
 *    guarded: if the disk is full or the DB is locked, persistence degrades to
 *    in-memory rather than taking the dashboard down. Telemetry is not worth
 *    losing the live view over.
 *  - Retention is enforced with a periodic sweep plus a hard row cap, so the
 *    file cannot grow without bound.
 */

type SqliteCtor = new (path: string) => DatabaseSync;

let Sqlite: SqliteCtor | null = null;

/**
 * Loads node:sqlite on demand.
 *
 * A static import would be evaluated at module load and throw on Node < 22,
 * killing the server at boot. Dynamic import keeps the failure contained to
 * openStore(), so an older runtime degrades to in-memory history instead.
 */
async function loadSqlite(): Promise<SqliteCtor | null> {
  if (Sqlite) return Sqlite;
  try {
    const mod = (await import('node:sqlite')) as { DatabaseSync: SqliteCtor };
    Sqlite = mod.DatabaseSync;
    return Sqlite;
  } catch {
    return null;
  }
}

/** Where the database lives. Overridable so tests can use a temp file. */
const DB_PATH = process.env.DASHBOARD_DB ?? path.join(process.cwd(), 'data', 'telemetry.db');

/** 24h of 5s rows (17,280), plus generous headroom. */
const MAX_ROWS = 25_000;

/** How often aged rows are swept. */
const SWEEP_INTERVAL_MS = 60_000;

/** Rows older than this are deleted. Matches the longest range the UI offers. */
const RETENTION_MS = 25 * 60 * 60_000;

interface Row {
  readonly t: number;
  readonly cpu: number;
  readonly ram: number;
  readonly disk: number;
  readonly net_rx: number;
  readonly net_tx: number;
  readonly latency: string | null;
  readonly containers: string | null;
  readonly processes: string | null;
}

let db: DatabaseSync | null = null;
let insertStmt: ReturnType<DatabaseSync['prepare']> | null = null;
let alertUpsertStmt: ReturnType<DatabaseSync['prepare']> | null = null;
let actionInsertStmt: ReturnType<DatabaseSync['prepare']> | null = null;
let lastSweepAt = 0;

/** Alert and action history are small; these caps keep them bounded too. */
const MAX_ALERT_ROWS = 500;
const MAX_ACTION_ROWS = 1000;

/** Set when persistence is unavailable, so the UI can say so instead of lying. */
let lastError: string | null = null;

function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * Opens the database and creates the schema.
 *
 * Returns false instead of throwing: a dashboard that cannot persist history
 * should still show live telemetry. node:sqlite is only present on Node 22+, so
 * the caller can also be running an older runtime.
 */
export async function openStore(): Promise<boolean> {
  if (db) return true;
  const SqliteCtor = await loadSqlite();
  if (!SqliteCtor) {
    lastError = 'node:sqlite requires Node 22+ (this runtime is older)';
    return false;
  }
  try {
    ensureDir(DB_PATH);
    db = new SqliteCtor(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // A busy timeout keeps a chart read from immediately failing a sampler write.
    db.exec('PRAGMA busy_timeout = 3000');

    db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        t          INTEGER PRIMARY KEY,
        cpu        REAL NOT NULL,
        ram        REAL NOT NULL,
        disk       REAL NOT NULL,
        net_rx     REAL NOT NULL,
        net_tx     REAL NOT NULL,
        latency    TEXT,
        containers TEXT,
        processes  TEXT
      )
    `);
    // Queries always filter and order by t.
    db.exec('CREATE INDEX IF NOT EXISTS idx_samples_t ON samples(t)');

    insertStmt = db.prepare(
      `INSERT OR REPLACE INTO samples (t, cpu, ram, disk, net_rx, net_tx, latency, containers, processes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Alert events: one row per breach. A breach updates its own row when it
    // resolves, so the table stays one-row-per-event rather than a log of ticks.
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_events (
        id          TEXT PRIMARY KEY,
        rule_id     TEXT NOT NULL,
        severity    TEXT NOT NULL,
        metric      TEXT NOT NULL,
        message     TEXT NOT NULL,
        value       REAL,
        threshold   REAL,
        since       INTEGER NOT NULL,
        fired_at    INTEGER NOT NULL,
        resolved_at INTEGER,
        occurrences INTEGER NOT NULL
      )
    `);
    alertUpsertStmt = db.prepare(
      `INSERT OR REPLACE INTO alert_events
         (id, rule_id, severity, metric, message, value, threshold, since, fired_at, resolved_at, occurrences)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Write-action audit: who restarted or stopped what, and whether it worked.
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        target      TEXT NOT NULL,
        name        TEXT NOT NULL,
        action      TEXT NOT NULL,
        ok          INTEGER NOT NULL,
        message     TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      )
    `);
    actionInsertStmt = db.prepare(
      `INSERT INTO action_log (ts, target, name, action, ok, message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    sweep(Date.now());
    lastError = null;
    return true;
  } catch (err) {
    db = null;
    insertStmt = null;
    alertUpsertStmt = null;
    actionInsertStmt = null;
    lastError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

export function isStoreOpen(): boolean {
  return db !== null;
}

export function storeError(): string | null {
  return lastError;
}

export function storePath(): string {
  return DB_PATH;
}

/** Rows currently stored, for the UI's storage line and for tests. */
export function storeCount(): number {
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM samples').get() as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Stores one sample.
 *
 * Best-effort: any failure is recorded and swallowed, because losing a history
 * row is strictly better than interrupting the 5s sampler.
 */
export function persist(sample: HistorySample): void {
  if (!db || !insertStmt) return;
  try {
    insertStmt.run(
      sample.t,
      sample.cpu,
      sample.ram,
      sample.disk,
      sample.netRx,
      sample.netTx,
      sample.latency ? JSON.stringify(sample.latency) : null,
      sample.containers ? JSON.stringify(sample.containers) : null,
      sample.processes ? JSON.stringify(sample.processes) : null,
    );
    if (sample.t - lastSweepAt > SWEEP_INTERVAL_MS) sweep(sample.t);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Deletes rows past the retention window, then trims to MAX_ROWS.
 *
 * Trimming by row count as well as by age means a burst of writes (a restart
 * loop, a debugger) cannot make the file grow without bound even when every row
 * is young.
 */
function sweep(now: number): void {
  if (!db) return;
  lastSweepAt = now;
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM samples WHERE t < ?').run(now - RETENTION_MS);
    const row = db.prepare('SELECT COUNT(*) AS n FROM samples').get() as unknown as { n: number } | undefined;
    const excess = (row?.n ?? 0) - MAX_ROWS;
    if (excess > 0) {
      // Delete the oldest excess rows rather than the newest: recent telemetry is
      // what the dashboard is actually showing.
      db.prepare('DELETE FROM samples WHERE t IN (SELECT t FROM samples ORDER BY t ASC LIMIT ?)').run(excess);
    }
    db.exec('COMMIT');
  } catch {
    // Roll back so a failed sweep cannot poison the connection.
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
  }
}

/** Parses a JSON column, tolerating a corrupt row rather than failing the query. */
function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Reads samples in [since, until], ascending.
 *
 * `limit` caps the returned rows, keeping the MOST RECENT ones within the
 * window: a caller asking for a wide range wants the freshest data, not the
 * oldest slice of it.
 */
export function load(since: number, until: number, limit = 5000): HistorySample[] {
  if (!db) return [];
  let rows: Row[];
  try {
    rows = db
      .prepare(
        `SELECT t, cpu, ram, disk, net_rx, net_tx, latency, containers, processes
         FROM samples WHERE t >= ? AND t <= ? ORDER BY t ASC`,
      )
      .all(since, until) as unknown as Row[];
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return [];
  }

  let slice = rows;
  if (rows.length > limit) slice = rows.slice(rows.length - limit);

  return slice.map((r) => ({
    t: r.t,
    cpu: r.cpu,
    ram: r.ram,
    disk: r.disk,
    netRx: r.net_rx,
    netTx: r.net_tx,
    ...(parseJson<Record<string, number>>(r.latency) ? { latency: parseJson<Record<string, number>>(r.latency)! } : {}),
    ...(parseJson<Record<string, ContainerSample>>(r.containers)
      ? { containers: parseJson<Record<string, ContainerSample>>(r.containers)! }
      : {}),
    ...(parseJson<Record<string, ProcessSample>>(r.processes)
      ? { processes: parseJson<Record<string, ProcessSample>>(r.processes)! }
      : {}),
  }));
}

/** Oldest stored timestamp, or null when the store is empty or closed. */
export function oldestTimestamp(): number | null {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT MIN(t) AS t FROM samples').get() as unknown as { t: number | null } | undefined;
    return row?.t ?? null;
  } catch {
    return null;
  }
}

/** Deletes every row. Used by tests and by an explicit history reset. */
export function wipe(): void {
  if (!db) return;
  try {
    db.exec('DELETE FROM samples');
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

export function closeStore(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* closing a store that is already gone is not an error worth raising */
  }
  db = null;
  insertStmt = null;
  alertUpsertStmt = null;
  actionInsertStmt = null;
}

interface AlertEventRow {
  readonly id: string;
  readonly rule_id: string;
  readonly severity: string;
  readonly metric: string;
  readonly message: string;
  readonly value: number | null;
  readonly threshold: number | null;
  readonly since: number;
  readonly fired_at: number;
  readonly resolved_at: number | null;
  readonly occurrences: number;
}

/**
 * Upserts one alert event. Best-effort: a failed write must never stop an
 * alert from firing, so the error is recorded and swallowed.
 */
export function saveAlertEvent(e: AlertEvent): void {
  if (!db || !alertUpsertStmt) return;
  try {
    alertUpsertStmt.run(
      e.id,
      e.ruleId,
      e.severity,
      e.metric,
      e.message,
      e.value,
      e.threshold,
      e.since,
      e.firedAt,
      e.resolvedAt,
      e.occurrences,
    );
    db.prepare(
      'DELETE FROM alert_events WHERE id NOT IN (SELECT id FROM alert_events ORDER BY fired_at DESC LIMIT ?)',
    ).run(MAX_ALERT_ROWS);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Newest alert events first. Empty when the store is unavailable. */
export function loadAlertEvents(limit: number): AlertEvent[] {
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id, rule_id, severity, metric, message, value, threshold, since, fired_at, resolved_at, occurrences
           FROM alert_events ORDER BY fired_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as AlertEventRow[];
    return rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      severity: r.severity as AlertSeverity,
      metric: r.metric,
      message: r.message,
      value: r.value,
      threshold: r.threshold,
      since: r.since,
      firedAt: r.fired_at,
      resolvedAt: r.resolved_at,
      occurrences: r.occurrences,
    }));
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return [];
  }
}

/** Appends one executed write action to the audit log. Best-effort. */
export function recordAction(entry: Omit<ActionLogEntry, 'id'>): void {
  if (!db || !actionInsertStmt) return;
  try {
    actionInsertStmt.run(
      entry.ts,
      entry.target,
      entry.name,
      entry.action,
      entry.ok ? 1 : 0,
      entry.message,
      entry.durationMs,
    );
    db.prepare('DELETE FROM action_log WHERE id NOT IN (SELECT id FROM action_log ORDER BY id DESC LIMIT ?)').run(
      MAX_ACTION_ROWS,
    );
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Newest first. Empty when the store is unavailable. */
export function recentActions(limit: number): ActionLogEntry[] {
  if (!db) return [];
  try {
    const rows = db
      .prepare('SELECT id, ts, target, name, action, ok, message, duration_ms FROM action_log ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as {
      id: number;
      ts: number;
      target: string;
      name: string;
      action: string;
      ok: number;
      message: string;
      duration_ms: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      target: r.target as ActionLogEntry['target'],
      name: r.name,
      action: r.action,
      ok: r.ok === 1,
      message: r.message,
      durationMs: r.duration_ms,
    }));
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return [];
  }
}

export const RETENTION_HOURS = Math.round(RETENTION_MS / 3_600_000);
export const STORE_ROW_CAP = MAX_ROWS;