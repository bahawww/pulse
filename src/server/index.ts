import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { SERVICES, type Service, type StatsPayload } from '../shared/contract.js';
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
  loginFailed,
  loginLocked,
  loginSucceeded,
  passwordConfigured,
  requireSession,
  sameOrigin,
  sessionHash,
  setCookie,
  userOf,
  verifyLogin,
} from './session.js';
import { performAction, refreshAllowlist } from './actions.js';
import { readLogs, listUnits } from './logs.js';
import { checkReachability } from './reachability.js';
import { getSpend } from './spend.js';
import { handleUpgrade } from './terminal.js';

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
  const [statuses, system] = await Promise.all([checkAllServices(), getSystemSnapshot()]);

  const services: Service[] = SERVICES.map((service) => {
    const status = statuses.get(service.id);
    return {
      ...service,
      status: status ?? { online: false, statusCode: null, latency: null },
    };
  });

  return { services, system };
}

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
app.set('trust proxy', 1);

app.use(
  helmet({
    // The SPA loads Google Fonts and inlines a theme bootstrap script.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Cloudflare Web Analytics injects its beacon into proxied HTML. Allow
        // only that host (script) and its collector (connect); nothing else.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://static.cloudflareinsights.com'],
        // Vite emits modulepreload + stylesheet links from 'self'; fonts come
        // from Google's CDN.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://cloudflareinsights.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
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

app.use(compression());

// Body parsing is only needed for the action endpoint, but it is mounted here
// with a tight size cap: an unauthenticated POST that can stream a large body is
// a free denial-of-service. 16KB is far more than {target,name,action,confirm}.
app.use(express.json({ limit: '16kb' }));

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

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30, // coarse backstop; the per-client lockout in session.ts is the real control
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts' },
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  const hash = sessionHash(req);
  const user = hash ? userOf(hash) : null;
  if (!user) {
    res.status(401).json({ error: 'login required' });
    return;
  }
  res.json({ user });
});

app.post('/api/auth/login', loginLimiter, (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req)) {
    res.status(403).json({ error: 'cross-site request refused' });
    return;
  }
  if (!passwordConfigured()) {
    res.status(503).json({ error: 'no admin password configured on the server' });
    return;
  }
  const key = clientKey(req);
  if (loginLocked(key)) {
    res.status(429).json({ error: 'too many failed attempts, try again in 15 minutes' });
    return;
  }
  const body = req.body as { username?: unknown; password?: unknown };
  if (!verifyLogin(body.username, body.password)) {
    loginFailed(key);
    console.warn(`[auth] failed login from ${key}`);
    // Fixed delay: guessing speed must not depend on how fast we answer.
    setTimeout(() => res.status(401).json({ error: 'wrong username or password' }), 800);
    return;
  }
  loginSucceeded(key);
  const { token, maxAgeSeconds } = createSession(req);
  setCookie(res, req, token, maxAgeSeconds);
  console.log(`[auth] ${ADMIN_USER} logged in from ${key}`);
  res.json({ user: { name: ADMIN_USER, role: 'admin' } });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  if (!sameOrigin(req)) {
    res.status(403).json({ error: 'cross-site request refused' });
    return;
  }
  const hash = sessionHash(req);
  if (hash) destroy(hash);
  clearCookie(res, req);
  res.json({ ok: true });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime(), pid: process.pid });
});

app.get('/api/stats', apiLimiter, (_req: Request, res: Response) => {
  void getStats()
    .then((payload) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
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
  const key = defaultView ? 'default' : String(windowMs);
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
  historyCache.set(key, { at: Date.now(), body });
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

app.get('/api/logs/units', logLimiter, (_req: Request, res: Response) => {
  void listUnits()
    .then((units) => res.json({ units }))
    .catch(() => res.status(500).json({ error: 'could not list units' }));
});

app.get('/api/logs', logLimiter, (req: Request, res: Response) => {
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

app.get('/api/reachability', reachLimiter, (_req: Request, res: Response) => {
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

app.get('/api/spend', spendLimiter, (_req: Request, res: Response) => {
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

// Audit trail of executed write actions, newest first. Read-only, so it sits
// behind the normal read limiter rather than the action one.
app.get('/api/actions/log', apiLimiter, (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ entries: recentActions(50) });
});

app.post('/api/action', actionLimiter, (req: Request, res: Response) => {
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
app.use((err: NodeJS.ErrnoException, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err?.code === 'ENOENT' ? 404 : 500;
  if (status === 500) console.error('[vps-dashboard] unhandled error:', err);
  res.status(status).type('text/plain').send(status === 404 ? 'Not Found' : 'Internal Server Error');
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[vps-dashboard] listening on http://${HOST}:${PORT} (client: ${CLIENT_DIR})`);

  if (!passwordConfigured()) {
    console.warn('[vps-dashboard] NO ADMIN_PASSWORD set — nobody can log in, the API stays locked');
  }
  const channel = channelStatus();
  console.log(
    channel.configured
      ? `[vps-dashboard] alerts: telegram channel configured`
      : '[vps-dashboard] alerts: web delivery only (bell, toast, desktop notification while the page is open); telegram not configured',
  );
});

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
        payload.services.map((s) => s.id),
        payload.system.docker.map((c) => c.name),
      );

      // Alerts run on the same tick as the samples they judge, so an alert can
      // never fire on data that was never recorded.
      const { fired } = evaluate(DEFAULT_RULES, payload.system, latency, Date.now());
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}