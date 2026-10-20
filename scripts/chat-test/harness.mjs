// Shared pieces of the chat tests: a fake OpenCode, an isolated Pulse (own port,
// data dir and HOME, env-admin login, no MySQL), and headless Chrome over CDP.
// Nothing here touches the real Pulse, the real OpenCode or its sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(120);
  }
}

/**
 * @param {{ root?: string, pulsePort?: number, ocPort?: number, chromePort?: number }} opts
 * `root` is a built Pulse tree (dist/ present); default is the repo this file is in.
 */
export async function start(opts = {}) {
  const root = path.resolve(opts.root ?? path.join(HERE, '..', '..'));
  const pulsePort = opts.pulsePort ?? 5299;
  const ocPort = opts.ocPort ?? 4097;
  const chromePort = opts.chromePort ?? 9340;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-chat-test-'));
  const home = path.join(tmp, 'home');
  const data = path.join(tmp, 'data');
  const work = path.join(tmp, 'work');
  for (const d of [home, data, work]) fs.mkdirSync(d, { recursive: true });
  const password = `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const children = [];
  const run = (cmd, args, env, cwd) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    c.logs = '';
    c.stdout.on('data', (b) => (c.logs += b));
    c.stderr.on('data', (b) => (c.logs += b));
    children.push(c);
    return c;
  };

  const fake = run(process.execPath, [path.join(HERE, 'fake-opencode.mjs'), String(ocPort)], { FAKE_OC_DIR: work }, root);
  const spawnPulse = () =>
    run(process.execPath, ['dist/server/index.js'], {
      PORT: String(pulsePort),
      HOST: '127.0.0.1',
      DASHBOARD_DATA_DIR: data,
      DASHBOARD_DB: path.join(data, 'telemetry.db'),
      HOME: home,
      ADMIN_USER: 'tester',
      ADMIN_PASSWORD: password,
      OPENCODE_URL: `http://127.0.0.1:${ocPort}`,
      OPENCODE_SERVER_PASSWORD: 'testpw',
      CHAT_DIRECTORY: work,
      DB_PASSWORD: '',
    }, root);
  let pulse = spawnPulse();
  const base = `http://127.0.0.1:${pulsePort}`;
  const pulseUp = () => until(async () => (await fetch(`${base}/api/health`)).ok, 20_000, `pulse up\n${pulse.logs}`);
  await pulseUp();

  const chrome = run('google-chrome', ['--headless=new', `--remote-debugging-port=${chromePort}`, '--no-first-run', '--disable-gpu', `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], {});
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()).find((x) => x.type === 'page'), 15_000, 'chrome up');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pend = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    } else if (m.method) events.push(m);
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pend.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  const h = {
    base,
    work,
    password,
    send,
    events,
    /** Evaluates an expression (awaited); returns its value or throws its error. */
    async ev(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
      return r.result?.result?.value;
    },
    async waitFor(expr, ms = 8000, what = expr) {
      return until(() => h.ev(expr), ms, what);
    },
    async shot(file, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    },
    async viewport(width, height, mobile) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile });
    },
    async goto(hash = '') {
      await send('Page.navigate', { url: `${base}/${hash}` });
      await sleep(1200);
    },
    async login() {
      await h.goto();
      const status = await h.ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'tester',password:${JSON.stringify(password)}})}).then(r=>r.status)`);
      if (status !== 200) throw new Error(`login failed: ${status}`);
      await send('Page.reload');
      await sleep(2500);
    },
    /** Test hook of the fake: cut the agent's event streams. */
    dropAgentStream: () => fetch(`http://127.0.0.1:${ocPort}/__drop`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from('opencode:testpw').toString('base64')}` } }),
    /** Every session the fake holds, with its rules and message count. */
    fakeSessions: async () => (await fetch(`http://127.0.0.1:${ocPort}/__sessions`, { headers: { Authorization: `Basic ${Buffer.from('opencode:testpw').toString('base64')}` } })).json(),
    /** Kills Pulse, stays down for `downMs`, starts it again with the same data (the browser's event stream must notice and come back). */
    async restartPulse(downMs = 3500) {
      pulse.kill('SIGKILL');
      await sleep(downMs);
      pulse = spawnPulse();
      await pulseUp();
    },
    logs: () => ({ pulse: pulse.logs, fake: fake.logs }),
    async close() {
      try {
        ws.close();
      } catch {
        /* closing */
      }
      for (const c of children) c.kill('SIGKILL');
      await sleep(300);
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  return h;
}

/** Tiny assertion helper: collects results, prints one line each, exits non-zero on any failure. */
export function suite(name) {
  const results = [];
  return {
    async check(label, fn) {
      try {
        await fn();
        results.push([true, label]);
        console.log(`  ok   ${label}`);
      } catch (err) {
        results.push([false, label]);
        console.log(`  FAIL ${label}\n       ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      }
    },
    done() {
      const bad = results.filter(([ok]) => !ok).length;
      console.log(`${name}: ${results.length - bad}/${results.length} passed`);
      return bad === 0;
    },
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}
