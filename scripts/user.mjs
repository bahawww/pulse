#!/usr/bin/env node
// Pulse account helper, for when the Users view is out of reach (no admin
// can log in) or for scripting. phpMyAdmin can edit roles and the disabled
// flag but cannot make a password hash; this can.
//
//   node scripts/user.mjs list
//   node scripts/user.mjs create <name> <viewer|operator|admin>   (asks for the password)
//   node scripts/user.mjs passwd <name>                            (asks for the password)
//
// Reads DB_* from /opt/pulse/.env. The hash format must match src/server/users.ts.
// Open sessions of a changed account end within 5 minutes (the server's
// session check, src/server/index.ts syncSessions).

import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = ['viewer', 'operator', 'admin'];

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function hashPassword(password) {
  const N = 1 << 15, r = 8, p = 1;
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(`scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`),
    ),
  );
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function newPassword() {
  const a = await askHidden('Password: ');
  if (a.length === 0) throw new Error('password required');
  const b = await askHidden('Again: ');
  if (a !== b) throw new Error('passwords do not match');
  return a;
}

function usage() {
  console.error('usage: user.mjs list | create <name> <viewer|operator|admin> | passwd <name>');
  process.exit(2);
}

loadEnv();
const [cmd, name, role] = process.argv.slice(2);
if (!cmd) usage();
if (!process.env.DB_PASSWORD) {
  console.error('DB_PASSWORD not set (expected in /opt/pulse/.env)');
  process.exit(1);
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? 'pulse',
  user: process.env.DB_USER ?? 'pulse',
  password: process.env.DB_PASSWORD,
});

try {
  if (cmd === 'list') {
    const [rows] = await db.query('SELECT id, username, role, disabled, last_login_at FROM users ORDER BY username');
    console.table(rows);
  } else if (cmd === 'create') {
    if (!name || !ROLES.includes(role)) usage();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) throw new Error('username: 2-64 chars, a-z 0-9 . _ -');
    const hash = await hashPassword(await newPassword());
    await db.query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [name, hash, role]);
    console.log(`created ${name} as ${role}`);
  } else if (cmd === 'passwd') {
    if (!name) usage();
    const hash = await hashPassword(await newPassword());
    const [res] = await db.query('UPDATE users SET password_hash = ? WHERE username = ?', [hash, name]);
    if (res.affectedRows === 0) throw new Error(`no user ${name}`);
    console.log(`password changed for ${name}`);
  } else {
    usage();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.end();
}
