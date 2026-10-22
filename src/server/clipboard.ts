import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Clip } from '../shared/contract.js';
import { userOf } from './session.js';

/**
 * A clipboard shared by one account's devices: text sent from the laptop shows
 * up on the phone and back. Each account sees only its own clips: they are kept
 * under the account id (the env admin, which has none, under its own key). Kept in the
 * data dir (mode 600) so a restart loses nothing; clips expire after a day and
 * only the newest MAX_CLIPS stay.
 */

const DATA_DIR = process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'clipboard.json');
const MAX_CLIPS = 20;
const MAX_TEXT = 64 * 1024;
const TTL_MS = 24 * 3_600_000;

let all: Record<string, Clip[]> | null = null;

function load(): Record<string, Clip[]> {
  if (all) return all;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, Clip[]>;
    // Only owner keys (user:<id>, env:<name>); lists from the first, name-keyed version go.
    all = Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([k]) => /^(user|env):/.test(k)));
  } catch {
    all = {};
  }
  return all;
}

function save(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all ?? {}), { mode: 0o600 });
  } catch (err) {
    console.warn('[clipboard] could not save:', err instanceof Error ? err.message : err);
  }
}

/** This login's clips, newest first, expired ones dropped. */
export function clipsOf(user: string, now = Date.now()): Clip[] {
  const list = (load()[user] ?? []).filter((c) => now - c.ts < TTL_MS);
  load()[user] = list;
  return list;
}

/** Adds a clip (an identical older one moves to the top); an error string when refused. */
export function addClip(user: string, text: unknown, device: unknown, now = Date.now()): Clip[] | string {
  if (typeof text !== 'string' || !text.trim()) return 'nothing to send';
  if (text.length > MAX_TEXT) return `text is over ${MAX_TEXT / 1024} KB`;
  const from = typeof device === 'string' ? device.replace(/[^\w .()-]/g, '').slice(0, 40) : '';
  const clip: Clip = { id: randomBytes(8).toString('hex'), text, device: from || 'a device', ts: now };
  const list = [clip, ...clipsOf(user, now).filter((c) => c.text !== text)].slice(0, MAX_CLIPS);
  load()[user] = list;
  save();
  return list;
}

/** Removes one clip, or all of them when id is null. */
export function removeClip(user: string, id: string | null): Clip[] {
  load()[user] = id === null ? [] : clipsOf(user).filter((c) => c.id !== id);
  save();
  return load()[user] ?? [];
}

/** Whose clips: the account id, so two accounts never share a list even if a name repeats. */
function ownerOf(res: Response): string {
  const u = userOf(res.locals.sessionHash as string);
  if (!u) return '';
  return u.id === null ? `env:${u.name}` : `user:${u.id}`;
}

export function getClips(_req: Request, res: Response): void {
  const owner = ownerOf(res);
  res.json({ clips: owner ? clipsOf(owner) : [] });
}

export function postClip(req: Request, res: Response): void {
  const owner = ownerOf(res);
  const b = req.body as { text?: unknown; device?: unknown } | null;
  const out = owner ? addClip(owner, b?.text, b?.device) : 'no user';
  if (typeof out === 'string') {
    res.status(400).json({ error: out });
    return;
  }
  res.json({ clips: out });
}

export function deleteClip(req: Request, res: Response): void {
  const id = (req.body as { id?: unknown } | null)?.id;
  if (id !== null && (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id))) {
    res.status(400).json({ error: 'bad clip id' });
    return;
  }
  const owner = ownerOf(res);
  res.json({ clips: owner ? removeClip(owner, id) : [] });
}
