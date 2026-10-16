import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { PASSWORD_MIN, UNIT_SERVICES, type Permission, type Service, type StatsPayload } from '../shared/contract.js';
import { checkAllServices } from './probe.js';
import { getSystemSnapshot } from './collect/index.js';
import { record, query, getHistory, historyStats, maxSpanMs, rehydrate } from './history.js';
import { openStore, isStoreOpen, storeError, storeCount, storePath, closeStore, recentActions } from './store.js';
import { DEFAULT_RULES, evaluate, restoreAlertEvents, snapshot } from './alerts.js';
import { channelStatus, notify } from './notify.js';
import {
  ADMIN_USER,
  clearCookie,
  clientKey,
  createSession,
  destroy,
  destroyUserSessions,
  envAdminPassword,
  loginFailed,
  loginLocked,
  loginSucceeded,
  passwordConfigured,
  passwordShort,
  peerAddress,
  renewSession,
  requirePerm,
  requireSession,
  sameOrigin,
  sessionAccounts,
  sessionHash,
  setCookie,
  userOf,
  verifyLogin,
} from './session.js';
import { performAction, refreshAllowlist } from './actions.js';
import { readLogs, listUnits } from './logs.js';
import { checkReachability } from './reachability.js';
import { getSpend } from './spend.js';
import { closeTerminals, detachedShells, handleUpgrade } from './terminal.js';
import { getSessions, killSession, renameSession } from './tmux.js';
import { CSRF_HEADER, csrfToken, csrfValid } from './csrf.js';
import { onServicesChange, rescan, serviceList, setHidden, startDiscovery } from './discover.js';
import { registerFileRoutes, UPLOAD_PATH } from './files.js';
import { closeStreams, openStream, publish, publishScoped } from './stream.js';
import { CHAT_PROMPT_PATH, closeChat, registerChatRoutes } from './chat.js';
import { scopeSamples, scopeStats, seriesKey } from './scope.js';
import { closeDb, dbConfigured, dbError, migrate } from './db.js';
import { registerUserRoutes } from './userRoutes.js';
import { ensureSuperadmin, getUser } from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 80);
const HOST = process.env.HOST ?? '0.0.0.0';
const CLIENT_DIR = path.resolve(__dirname, '../client');

// ---------------------------------------------------------------------------
// Snapshot cache
//
// The legacy server rebuilt the full payload (4 HTTP probes + a df fork) on
// every single /api/stats hit, with N browser tabs polling every 3s. With a
// cache, concurrent callers share one probe round.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 2000;
let cache: { payload: StatsPayload; expires: number } | null = null;
let inFlight: Promise<StatsPayload> | null = null;

async function buildPayload(): Promise<StatsPayload> {
  const { visible, hidden } = serviceList();
  const [statuses, system] = await Promise.all([checkAllServices(visible), getSystemSnapshot()]);

  const services: Service[] = visible.map((service) => {
    const status = statuses.get(service.id);
    return {
      ...service,
      status: status ?? { online: false, statusCode: null, latency: null },
    };
  });

  return { services, hiddenServices: hidden, system };
}

// A scan or a hide changes the list: the next poll rebuilds it.
onServicesChange(() => {
  cache = null;
});

async function getStats(): Promise<StatsPayload> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.payload;
  if (inFlight) return inFlight;

  inFlight = buildPayload()
    .then((payload) => {
      cache = { payload, expires: Date.now() + CACHE_TTL_MS };
      return payload;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

app.disable('x-powered-by');
// X-Forwarded-* is believed only from loopback, where cloudflared connects from.
// `1` trusted one hop from anywhere, so a direct client on the LAN or Tailscale
// could set its own address (rate-limit key) and protocol.
app.set('trust proxy', 'loopback');

/**
 * CSP hashes for the inline scripts in the built index.html (the theme
 * bootstrap), so script-src needs no 'unsafe-inline' and an injected inline
 * script will not run. Recomputed at start, so editing the script and
 * rebuilding just works.
 */
function inlineScriptHashes(): string[] {
  try {
    const html = fs.readFileSync(path.join(CLIENT_DIR, 'index.html'), 'utf8');
    const out: string[] = [];
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const body = m[1] ?? '';
      if (body.trim()) out.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }
    return out;
  } catch {
    return [];
  }
}
const SCRIPT_HASHES = inlineScriptHashes();

app.use(
  helmet({
    // The SPA loads Google Fonts and inlines a theme bootstrap script.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Cloudflare Web Analytics injects its beacon into proxied HTML. Allow
        // only that host (script) and its collector (connect); nothing else.
        scriptSrc: ["'self'", ...SCRIPT_HASHES, 'https://static.cloudflareinsights.com'],
        scriptSrcAttr: ["'none'"],
        // Vite emits modulepreload + stylesheet links from 'self'; fonts come
        // from Google's CDN.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://cloudflareinsights.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    // Cross-origin isolation headers would block nothing useful here (no
    // SharedArrayBuffer), and COEP breaks the noVNC link target.
    crossOriginEmbedderPolicy: false,
    // Permissive referrer keeps service links working; the dashboard is
    // internal-only and the page itself holds no secrets.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);

// Lists only features this page never uses. Unknown feature names in this
// header are what Chrome warns about, so keep the list to standard names.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

// Not for the event stream: a gzip layer may hold events back until a buffer fills.
const EVENT_STREAMS: ReadonlySet<string> = new Set(['/api/stream', '/api/chat/events']);
app.use(compression({ filter: (req, res) => !EVENT_STREAMS.has(req.path) && compression.filter(req, res) }));

// Body parsing is only needed for the action endpoint, but it is mounted here
// with a tight size cap: an unauthenticated POST that can stream a large body is
// a free denial-of-service. 16KB is far more than {target,name,action,confirm}.
// A chat prompt is the one body allowed to be bigger (a pasted log or file),
// and only with a valid login.
const smallJson = express.json({ limit: '16kb' });
const promptJson = express.json({ limit: '512kb' });
app.use((req: Request, res: Response, next: NextFunction) => (CHAT_PROMPT_PATH.test(req.path) && sessionHash(req) ? promptJson : smallJson)(req, res, next));

// The legacy server sent `Access-Control-Allow-Origin: *` on every response,
// which let any website on the internet read this host's service topology and
// telemetry by hitting the port-80 origin from a browser. The API is same-origin
// in production, so CORS is not needed at all. Narrow it to explicit origins.
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(origin && ALLOWED_ORIGINS.has(origin) ? 204 : 403);
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 240, // 4 tabs x 20 polls/min is 80; headroom for mobile reconnects
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// ---------------------------------------------------------------------------
// Login. Everything under /api needs a session except these.
// ---------------------------------------------------------------------------

const OPEN_API = new Set(['/health', '/auth/login', '/auth/me']);
app.use('/api', requireSession(OPEN_API));

// API answers are per-session and live; no proxy or browser cache may keep one.
app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/**
 * CSRF gate for every state-changing API call:
 *  1. same origin (Origin / Sec-Fetch-Site), always;
 *  2. a JSON body when there is one (a cross-site HTML form cannot send JSON);
 *  3. the session's CSRF token in X-CSRF-Token, for everything but the login
 *     itself (no session exists yet; 1 and SameSite=Strict cover it).
 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (!UNSAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (!sameOrigin(req)) {
    console.warn(`[csrf] cross-site ${req.method} ${req.originalUrl} from ${peerAddress(req)} origin=${req.headers.origin ?? '-'}`);
    res.status(403).json({ error: 'cross-site request refused', code: 'origin' });
    return;
  }
  const length = Number(req.headers['content-length'] ?? 0);
  // A file upload's body is the file itself. A cross-site form cannot send
  // application/octet-stream either, and the token below is still required.
  const rawUpload = req.path === UPLOAD_PATH && req.is('application/octet-stream') !== false;
  if ((length > 0 || req.headers['transfer-encoding']) && !req.is('application/json') && !rawUpload) {
    res.status(415).json({ error: 'JSON body required' });
    return;
  }
  if (req.path === '/auth/login') {
    next();
    return;
  }
  const hash = (res.locals.sessionHash as string | undefined) ?? sessionHash(req);
  if (!hash || !csrfValid(hash, req.get(CSRF_HEADER))) {
    console.warn(`[csrf] bad or missing token on ${req.method} ${req.originalUrl} from ${peerAddress(req)}`);
    res.status(403).json({ error: 'security token missing or expired, reload the page', code: 'csrf' });
    return;
  }
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30, // coarse backstop; the per-client lockout in session.ts is the real control
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts' },
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const hash = sessionHash(req);
  const user = hash ? userOf(hash) : null;
  if (!hash || !user) {
    res.status(401).json({ error: 'login required' });
    return;
  }
  renewSession(req, res);
  res.json({ user, csrf: csrfToken(hash) });
});

app.post('/api/auth/login', loginLimiter, (req: Request, res: Response) => {
  void login(req, res).catch((err: unknown) => {
    console.error('[auth] login failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'login failed' });
  });
});

async function login(req: Request, res: Response): Promise<void> {
  if (!passwordConfigured() && !dbConfigured()) {
    res.status(503).json({ error: 'no user database or admin password configured on the server' });
    return;
  }
  const key = clientKey(req);
  if (loginLocked(key)) {
    res.status(429).json({ error: 'too many failed attempts, try again in 15 minutes' });
    return;
  }
  const body = req.body as { username?: unknown; password?: unknown };
  const user = await verifyLogin(body.username, body.password);
  if (!user) {
    loginFailed(key);
    console.warn(`[auth] failed login from ${key}`);
    // Fixed delay: guessing speed must not depend on how fast we answer.
    setTimeout(() => res.status(401).json({ error: 'wrong username or password' }), 800);
    return;
  }
  loginSucceeded(key);
  // A login always starts a fresh session, so a cookie planted before login is never promoted.
  const old = sessionHash(req);
  if (old) destroy(old);
  const { token, hash, maxAgeSeconds } = createSession(req, user);
  setCookie(res, req, token, maxAgeSeconds);
  console.log(`[auth] ${user.breakGlass ? 'break-glass login' : `${user.role}`} ${user.name} logged in from ${key}`);
  res.json({ user: userOf(hash), csrf: csrfToken(hash) });
}

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const hash = sessionHash(req);
  if (hash) destroy(hash);
  clearCookie(res, req);
  res.json({ ok: true });
});

// Open to anyone, so it says only "up": no pid, uptime or version to fingerprint.
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/api/stream', (req: Request, res: Response) => {
  openStream(req, res, res.locals.sessionHash as string);
});

/** The logged-in reader's permissions (requireSession left the session hash). */
function permissionsOf(res: Response): readonly Permission[] {
  return userOf(res.locals.sessionHash as string)?.permissions ?? [];
}

app.get('/api/stats', apiLimiter, (_req: Request, res: Response) => {
  void getStats()
    .then((payload) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(scopeStats(payload, permissionsOf(res)));
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ error: message });
    });
});

/**
 * History answers are cached briefly: a long range only changes once a minute
 * (its buckets are minute averages), and several tabs or a quick 12h/24h
 * toggle should not rebuild and re-serialise the same megabyte.
 */
const HISTORY_CACHE_SHORT_MS = 2_000;
const HISTORY_CACHE_LONG_MS = 15_000;
/** Keyed by the requested span, which any number can be: expired answers are dropped and the map is capped. */
const HISTORY_CACHE_MAX = 16;
const historyCache = new Map<string, { at: number; body: string }>();

/**
 * Trims float noise before it goes on the wire (0.024999999999999998 ->
 * 0.025): averages and probe timings carry 16 digits nobody reads, and they
 * were a large share of a 24h payload. Integers pass through untouched.
 */
function roundForWire(_key: string, value: unknown): unknown {
  if (typeof value !== 'number' || Number.isInteger(value) || !Number.isFinite(value)) return value;
  const abs = Math.abs(value);
  if (abs >= 100) return Math.round(value);
  if (abs >= 1) return Math.round(value * 100) / 100;
  return Math.round(value * 10_000) / 10_000;
}

app.get('/api/history', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');

  // A range is requested as a duration in ms. Anything unparseable falls back to
  // the default window rather than erroring, so an old client keeps working.
  const requested = Number.parseInt(String(req.query.ms ?? ''), 10);
  const windowMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 24 * 3_600_000) : 20 * 60_000;

  const defaultView = windowMs === 20 * 60_000 && !req.query.ms;
  // The series this login may read are part of the key (src/server/scope.ts).
  const permissions = permissionsOf(res);
  const key = `${defaultView ? 'default' : String(windowMs)}|${seriesKey(permissions)}`;
  const ttl = windowMs > 3_600_000 ? HISTORY_CACHE_LONG_MS : HISTORY_CACHE_SHORT_MS;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < ttl) {
    res.type('application/json').send(hit.body);
    return;
  }

  const payload = defaultView ? getHistory() : query(windowMs);
  const stats = historyStats();
  const body = JSON.stringify(
    {
      ...payload,
      samples: scopeSamples(payload.samples, permissions),
      maxSpanMs: Math.max(payload.maxSpanMs, maxSpanMs()),
      storage: {
        ...stats,
        // Reported honestly: `persisted: false` means a restart will lose the
        // in-memory window, and the UI says so rather than implying continuity.
        persisted: isStoreOpen(),
        storedRows: storeCount(),
        error: storeError(),
      },
    },
    roundForWire,
  );
  const now = Date.now();
  for (const [k, v] of historyCache) if (now - v.at >= HISTORY_CACHE_LONG_MS) historyCache.delete(k);
  historyCache.delete(key);
  if (historyCache.size >= HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value!);
  historyCache.set(key, { at: now, body });
  res.type('application/json').send(body);
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

app.get('/api/alerts', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(snapshot(DEFAULT_RULES, channelStatus()));
});

// ---------------------------------------------------------------------------
// Logs (read-only journal tail)
// ---------------------------------------------------------------------------

const logLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60, // journalctl forks a process; this is not a 5s-poll endpoint
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many log requests' },
});

app.get('/api/logs/units', logLimiter, requirePerm('view:logs'), (_req: Request, res: Response) => {
  void listUnits()
    .then((units) => res.json({ units }))
    .catch(() => res.status(500).json({ error: 'could not list units' }));
});

app.get('/api/logs', logLimiter, requirePerm('view:logs'), (req: Request, res: Response) => {
  const unit = String(req.query.unit ?? '');
  if (!unit) {
    res.status(400).json({ error: 'unit query parameter required' });
    return;
  }

  const lines = Number.parseInt(String(req.query.lines ?? '120'), 10);
  const since = typeof req.query.since === 'string' ? req.query.since : null;
  const priority = typeof req.query.priority === 'string' ? req.query.priority : null;

  void readLogs({ unit, lines: Number.isFinite(lines) ? lines : 120, since, priority })
    .then((result) => {
      if (result.error) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ entries: result.entries });
    })
    .catch(() => res.status(500).json({ error: 'could not read journal' }));
});

// ---------------------------------------------------------------------------
// External reachability
// ---------------------------------------------------------------------------

const reachLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12, // each check may make outbound requests
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many reachability checks' },
});

// Reach and spend is one view, opened by view:overview (VIEW_NEEDS in src/lib/views.ts).
app.get('/api/reachability', reachLimiter, requirePerm('view:overview'), (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  void checkReachability()
    .then((report) => res.json(report))
    .catch(() => res.status(500).json({ error: 'reachability check failed' }));
});

// ---------------------------------------------------------------------------
// LLM spend
// ---------------------------------------------------------------------------

const spendLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many spend requests' },
});

app.get('/api/spend', spendLimiter, requirePerm('view:overview'), (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  void getSpend()
    .then((report) => res.json(report))
    .catch(() => res.status(500).json({ error: 'spend query failed' }));
});

// ---------------------------------------------------------------------------
// Write actions
//
// The only mutating endpoints in the app. They sit behind the auth gate, a
// much tighter rate limit than the read endpoints, and the two-phase
// confirmation token in actions.ts.
// ---------------------------------------------------------------------------

const actionLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many action requests' },
});

// File explorer (src/server/files.ts). Reads share the normal limiter; writes
// get their own, generous enough for a folder of uploads.
const filesWriteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many file operations' },
});
// The explorer reads and writes anything the dashboard user can, secrets
// included: reads need files:read, every write files:write (both admin-only roles).
const filesRead = requirePerm('files:read');
const filesWrite = requirePerm('files:write');
app.use('/api/files', (req: Request, res: Response, next: NextFunction) => (req.method === 'GET' ? filesRead : filesWrite)(req, res, next));
registerFileRoutes(app, apiLimiter, filesWriteLimiter);

// tmux session manager (tmux.ts): list, rename, kill. Attaching is a terminal window.
const wrapAsync = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
  fn(req, res).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'tmux command failed' });
  });
};
app.get('/api/tmux', apiLimiter, requirePerm('terminal'), wrapAsync(getSessions));
app.post('/api/tmux/kill', actionLimiter, requirePerm('terminal'), wrapAsync(killSession));
app.post('/api/tmux/rename', actionLimiter, requirePerm('terminal'), wrapAsync(renameSession));

// Shells a new tab or a relaunched phone app can reattach (terminal.ts).
app.get('/api/terminal/sessions', apiLimiter, requirePerm('terminal'), (_req: Request, res: Response) => {
  res.json({ shells: detachedShells(res.locals.sessionHash as string) });
});

// Accounts (userRoutes.ts). Admin-only; the rows live in MySQL.
// Agent chat (chat.ts): admin-only, like the terminal. Writes start agent
// work, so they get their own limit.
const chatWriteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many chat requests' },
});
registerChatRoutes(app, apiLimiter, chatWriteLimiter);

registerUserRoutes(app, apiLimiter, destroyUserSessions, (req) => {
  const hash = sessionHash(req);
  return hash ? userOf(hash) : null;
});

// Auto-scanned services: hide or show one, or scan again now.
app.post('/api/services/hidden', apiLimiter, requirePerm('services:control'), (req: Request, res: Response) => {
  const body = req.body as { id?: unknown; hidden?: unknown };
  if (typeof body.id !== 'string' || body.id.length > 120 || typeof body.hidden !== 'boolean') {
    res.status(400).json({ error: 'id and hidden required' });
    return;
  }
  if (!setHidden(body.id, body.hidden)) {
    res.status(404).json({ error: 'unknown service' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/services/scan', apiLimiter, requirePerm('services:control'), (_req: Request, res: Response) => {
  void rescan().then(() => {
    const { visible, hidden } = serviceList();
    res.json({ ok: true, visible: visible.length, hidden: hidden.length });
  });
});

// Audit trail of executed write actions, newest first. Read-only, so it sits
// behind the normal read limiter rather than the action one.
app.get('/api/actions/log', apiLimiter, requirePerm('view:logs'), (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ entries: recentActions(50) });
});

app.post('/api/action', actionLimiter, requirePerm('services:control'), (req: Request, res: Response) => {
  const body = req.body as { target?: unknown; name?: unknown; action?: unknown; confirm?: unknown };

  void performAction(
    {
      target: body.target as 'systemd' | 'docker',
      name: String(body.name ?? ''),
      action: body.action as 'restart' | 'stop' | 'start',
    },
    typeof body.confirm === 'string' ? body.confirm : null,
  )
    .then((result) => {
      if (!result) {
        res.status(500).json({ error: 'action failed' });
        return;
      }
      if (result.ok && !result.confirmToken) publish('actions', { entries: recentActions(50) });
      res.status(result.ok ? 200 : 400).json(result);
    })
    .catch(() => res.status(500).json({ error: 'action failed' }));
});

// Unknown API routes must not fall through to the SPA fallback and answer 200
// with HTML — a client bug would look like a successful fetch.
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});

// ---------------------------------------------------------------------------
// Static client + SPA fallback
// ---------------------------------------------------------------------------
if (fs.existsSync(CLIENT_DIR)) {
  // Vite fingerprints filenames under /assets, so those are immutable.
  app.use(
    '/assets',
    express.static(path.join(CLIENT_DIR, 'assets'), {
      immutable: true,
      maxAge: '1y',
      fallthrough: false,
    }),
  );

  app.use(
    express.static(CLIENT_DIR, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        // The service worker and manifest must be re-checked on every load, or a
        // new deploy would wait out the one-hour static cache.
        if (/\.(html|webmanifest)$/.test(filePath) || filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
      },
    }),
  );

  // SPA fallback. express.static already rejected traversal attempts by
  // normalizing the URL, and this handler only ever serves index.html — there
  // is no join(PUBLIC_DIR, req.path) left to escape from.
  //
  // Only extension-less paths get the SPA: a request for /nope.js is a missing
  // asset and must 404, otherwise stale bundles fail silently as HTML.
  app.get(/.*/, (req: Request, res: Response) => {
    if (path.extname(req.path) !== '') {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
  });
} else {
  app.get('/', (_req: Request, res: Response) => {
    res
      .status(503)
      .type('text/plain')
      .send('Client bundle missing. Run `npm run build` before starting the server.');
  });
}

// `express.static` with fallthrough:false calls next(err) with a plain ENOENT
// for a missing asset. That is a 404, not a server fault — returning 500 here
// turned every stale/missing bundle into a false alarm in the logs.
// The JSON body parser fails with its own 4xx (400 malformed, 413 too large,
// 415 bad charset). Those are the client's mistake: answer with that status and
// log nothing. As a 500 with a stack trace, any anonymous POST filled the journal.
app.use((err: NodeJS.ErrnoException & { status?: unknown }, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const clientError = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : null;
  const status = clientError ?? (err?.code === 'ENOENT' ? 404 : 500);
  if (status === 500) console.error('[vps-dashboard] unhandled error:', err);
  if (req.path.startsWith('/api/')) {
    res.status(status).json({ error: status === 413 ? 'request body too large' : status === 500 ? 'internal error' : status === 404 ? 'not found' : 'bad request' });
    return;
  }
  res.status(status).type('text/plain').send(status === 404 ? 'Not Found' : status === 500 ? 'Internal Server Error' : 'Bad Request');
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[vps-dashboard] listening on http://${HOST}:${PORT} (client: ${CLIENT_DIR})`);
  startDiscovery(PORT);

  if (!passwordConfigured()) {
    console.warn(
      dbConfigured()
        ? '[vps-dashboard] no ADMIN_PASSWORD set — no break-glass login while MySQL is down'
        : '[vps-dashboard] NO ADMIN_PASSWORD and no user database — nobody can log in, the API stays locked',
    );
  } else if (passwordShort()) {
    console.warn(`[vps-dashboard] ADMIN_PASSWORD is shorter than ${PASSWORD_MIN} characters, the rule for everyone's own password`);
  }
  if (SCRIPT_HASHES.length === 0 && fs.existsSync(CLIENT_DIR)) {
    console.warn('[vps-dashboard] no inline script hashes found; the theme bootstrap will be blocked by CSP');
  }
  const channel = channelStatus();
  console.log(
    channel.configured
      ? `[vps-dashboard] alerts: telegram channel configured`
      : '[vps-dashboard] alerts: web delivery only (bell, toast, desktop notification while the page is open); telegram not configured',
  );
});

// User store. Runs the migrations, then makes the env account the one
// superadmin (created from ADMIN_PASSWORD if missing). Re-checked every few
// minutes, so a superadmin row deleted or demoted in phpMyAdmin comes back
// without a restart. A failure only logs: login falls back to the env account
// until MySQL answers.
const SUPERADMIN_CHECK_MS = 5 * 60_000;
async function keepSuperadmin(): Promise<void> {
  try {
    const what = await ensureSuperadmin(ADMIN_USER, envAdminPassword());
    if (what.startsWith('restored') || what.startsWith('created') || what.startsWith('no ')) console.warn(`[users] ${what}`);
  } catch (err) {
    console.warn('[users] superadmin check failed:', err instanceof Error ? err.message : err);
  }
  await syncSessions();
}

/**
 * A session copies the account's name, role and permissions at login, renews
 * itself while used and survives restarts, so an account edited outside the
 * app (phpMyAdmin, scripts/user.mjs) stayed logged in with its old rights for
 * good. On the same timer: a deleted, disabled or changed account is logged out.
 * A database that does not answer changes nothing.
 */
async function syncSessions(): Promise<void> {
  try {
    for (const [id, given] of sessionAccounts()) {
      const now = await getUser(id);
      const stale = !now || now.disabled || given.some((s) => s.name !== now.username || s.role !== now.role || s.permissions.join() !== now.permissions.join());
      if (stale) console.log(`[users] ${destroyUserSessions(id)} session(s) of #${id} ended: account ${now ? 'changed' : 'deleted'} outside the app`);
    }
  } catch (err) {
    console.warn('[users] session check failed:', err instanceof Error ? err.message : err);
  }
}
// At boot MySQL (a Docker container) is often not up yet when this service
// starts. One failed try used to be final: no migrations and no superadmin
// check until the next restart. Keep trying until it answers.
const MIGRATE_RETRY_MS = 30_000;
let migrateWarned = false;
async function startUserStore(): Promise<void> {
  if (!(await migrate())) {
    if (!migrateWarned) console.warn(`[vps-dashboard] user database unavailable: ${dbError() ?? 'unknown'} — only the env admin can log in until it answers`);
    migrateWarned = true;
    if (dbConfigured()) setTimeout(() => void startUserStore(), MIGRATE_RETRY_MS).unref();
    return;
  }
  await keepSuperadmin();
  console.log(`[vps-dashboard] user database ready, superadmin ${ADMIN_USER}`);
  setInterval(() => void keepSuperadmin(), SUPERADMIN_CHECK_MS).unref();
}
void startUserStore();

// Browser terminal (WebSocket -> SSH). Has its own, stricter gate in terminal.ts.
server.on('upgrade', handleUpgrade);

// Durable history storage.
//
// Opened before the sampler starts so the first write already lands on disk.
// node:sqlite needs Node 22+; on an older runtime openStore() returns false and
// the dashboard runs exactly as before — in-memory history, and the UI is told
// so via storage.persisted instead of implying a durability it does not have.
void openStore().then(
  (ready) => {
    if (!ready) {
      console.warn(
        `[vps-dashboard] history store unavailable: ${storeError() ?? 'unknown'} — ` +
          'history will not survive a restart',
      );
      return;
    }
    const restored = rehydrate();
    const alertsRestored = restoreAlertEvents(Date.now());
    console.log(
      `[vps-dashboard] history store ready at ${storePath()} ` +
        `(${storeCount()} rows, ${restored} rehydrated, ${alertsRestored} alert events restored)`,
    );
  },
  (err: unknown) => {
    // Never let a storage problem stop the dashboard from serving live metrics.
    console.warn('[vps-dashboard] history store failed to open:', err);
  },
);

// History sampler.
//
// It used to run as a side effect of a /api/stats request, so the sample
// cadence was really "however often a browser tab happened to poll" — 3s with
// two tabs open, minutes while closed, and after a restart the buffer replayed
// a multi-hour gap as one straight line. Sampling on a fixed interval makes the
// timeline mean the same thing regardless of who is watching.
const SAMPLE_INTERVAL_MS = 5000;

const sampler = setInterval(() => {
  // Read the cached system metrics rather than probing fresh: the chart wants a
  // steady sample, and a probe round costs TCP connects to every service.
  void getStats()
    .then((payload) => {
      // Only reachable services contribute a latency. An absent key means
      // "offline", which is not the same as a latency of zero and must not be
      // averaged in as one.
      const latency: Record<string, number> = {};
      for (const service of payload.services) {
        const ms = service.status.latency;
        if (service.status.online && typeof ms === 'number') latency[service.id] = ms;
      }

      // Per-container CPU and RSS. The collector already bounds this to a few
      // hundred ms of Docker socket reads, so it runs on the sample cadence.
      const containers: Record<string, { cpuPercent: number; memBytes: number; name: string }> = {};
      for (const c of payload.system.docker) {
        containers[c.id] = { cpuPercent: c.cpuPercent, memBytes: c.memBytes, name: c.name };
      }

      // Top processes by CPU, keyed by pid, for per-process drill-down.
      const processes: Record<string, { name: string; cpuFraction: number; rssBytes: number }> = {};
      for (const p of payload.system.processes.slice(0, 12)) {
        processes[String(p.pid)] = { name: p.name, cpuFraction: p.cpuFraction, rssBytes: p.rssBytes };
      }

      record({
        system: {
          t: Date.now(),
          cpu: payload.system.cpu.usage,
          ram: payload.system.memory.percent,
          disk: payload.system.disk.percent,
          // Interfaces are already filtered to real ones, so this is host-wide
          // throughput without double-counting veth pairs.
          netRx: payload.system.net.reduce((sum, n) => sum + (n.rxPerSec ?? 0), 0),
          netTx: payload.system.net.reduce((sum, n) => sum + (n.txPerSec ?? 0), 0),
        },
        latency: Object.keys(latency).length > 0 ? latency : undefined,
        containers: Object.keys(containers).length > 0 ? containers : undefined,
        processes: Object.keys(processes).length > 0 ? processes : undefined,
      });

      // The action allowlist tracks what exists on the host, so a container
      // created after boot becomes controllable without a server restart. Stopped
      // services stay on it: a service that was just stopped must still be startable.
      refreshAllowlist(
        payload.services.map((s) => s.id).filter((id) => UNIT_SERVICES.has(id)),
        payload.system.docker.map((c) => c.name),
      );

      // Alerts run on the same tick as the samples they judge, so an alert can
      // never fire on data that was never recorded.
      const { fired } = evaluate(DEFAULT_RULES, payload.system, latency, Date.now());
      // Push to open tabs: telemetry every tick, alerts only when they change.
      publishScoped('stats', (permissions) => scopeStats(payload, permissions));
      publish('alerts', snapshot(DEFAULT_RULES, channelStatus()), true);
      for (const event of fired) {
        void notify(event).catch((err: unknown) =>
          console.error('[vps-dashboard] alert notify:', err),
        );
      }
    })
    .catch((err: unknown) => console.error('[vps-dashboard] sampler:', err));
}, SAMPLE_INTERVAL_MS);

// Do not let the sampler keep the process alive on its own during shutdown.
sampler.unref();

// Graceful shutdown so systemd's Restart=always doesn't race a dying process.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[vps-dashboard] ${signal} received, closing`);
    clearInterval(sampler);
    // Flush WAL and close cleanly so the next boot reads a consistent file
    // rather than replaying a recovery log. Safe to call when the store never
    // opened (older runtime), where it is a no-op.
    closeStore();
    void closeDb();
    // Open event streams and terminal sockets never end on their own, so
    // server.close() used to wait out the 8 s timer and exit 1 on every restart
    // with a tab open (systemd: "Failed with result 'exit-code'"). End them;
    // both reconnect by themselves once the server is back.
    closeStreams();
    closeChat();
    closeTerminals();
    server.close(() => process.exit(0));
    // A download or upload in flight gets a moment, then everything is cut.
    setTimeout(() => server.closeAllConnections(), 2000).unref();
    setTimeout(() => process.exit(0), 4000).unref();
  });
}