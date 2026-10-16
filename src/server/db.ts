import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql, { type Connection, type Pool, type PoolOptions } from 'mysql2/promise';

/**
 * MySQL connection for the user store (stack in /opt/pulse-db, loopback only).
 *
 * Settings come from DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD in
 * /opt/pulse/.env. With no DB_PASSWORD the pool is never made and every
 * caller sees the database as down, so login falls back to the env admin.
 *
 * Migrations are the files in deploy/sql, applied in name order at start.
 * Each one must be safe to run again (CREATE TABLE IF NOT EXISTS and so on).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/server and dist/server both sit two levels below the project root.
const SQL_DIR = path.resolve(__dirname, '../../deploy/sql');

let pool: Pool | null = null;
let ready = false;
let lastError: string | null = null;

export function dbConfigured(): boolean {
  return Boolean(process.env.DB_PASSWORD);
}

function settings(): PoolOptions {
  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_NAME ?? 'pulse',
    user: process.env.DB_USER ?? 'pulse',
    password: process.env.DB_PASSWORD,
    connectTimeout: 3000,
    // DATETIME/TIMESTAMP come back as Date; the API sends epoch ms.
    dateStrings: false,
  };
}

export function getPool(): Pool | null {
  if (pool || !dbConfigured()) return pool;
  pool = mysql.createPool({ ...settings(), connectionLimit: 5 });
  return pool;
}

/** True after migrations ran once. A later outage shows up as query errors, not here. */
export function dbReady(): boolean {
  return ready;
}

export function dbError(): string | null {
  return lastError;
}

export async function migrate(): Promise<boolean> {
  if (!dbConfigured()) {
    lastError = 'DB_PASSWORD not set';
    return false;
  }
  let conn: Connection | null = null;
  try {
    // A migration file holds several statements. Only this one-off connection
    // allows that: on the shared pool it would also let an injected "; DROP ..."
    // ride along with any query.
    conn = await mysql.createConnection({ ...settings(), multipleStatements: true });
    const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) await conn.query(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
    ready = true;
    lastError = null;
    return true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    await conn?.end().catch(() => undefined);
  }
}

export async function closeDb(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = null;
}
