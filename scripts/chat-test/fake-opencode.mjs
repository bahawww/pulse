#!/usr/bin/env node
// A small stand-in for `opencode web`, enough for Pulse's chat adapter
// (src/server/chatOpencode.ts) and its tests. Scripted replies, no model, no cost.
//
//   node scripts/chat-test/fake-opencode.mjs [port]      (default 4097)
//
// Basic auth: user "opencode", password from FAKE_OC_PASSWORD (default "testpw").
// Prompt keywords pick the reply: "todo", "perm" (asks for permission), "restart"
// (a systemctl block), "slow" (long, for Stop), "image" (echoes attachments), and a line
// "run: <cmd>" answers with that command in a bash block.
import http from 'node:http';

const PORT = Number(process.argv[2] ?? process.env.FAKE_OC_PORT ?? 4097);
const PASS = process.env.FAKE_OC_PASSWORD ?? 'testpw';
const AUTH = `Basic ${Buffer.from(`opencode:${PASS}`).toString('base64')}`;
const DIR = process.env.FAKE_OC_DIR ?? '/tmp';

let seq = 0;
const rid = (p) => `${p}_${Date.now().toString(36).padStart(9, '0')}${(seq++).toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;
const sessions = new Map();
const messages = new Map();
const status = new Map();
const perms = new Map();
const waiting = new Map();
const todos = new Map();
const streams = new Set();

function emit(type, properties, directory = DIR) {
  const data = JSON.stringify({ directory, payload: { type, properties } });
  for (const res of streams) res.write(`data: ${data}\n\n`);
}

function mkSession(body = {}, parent) {
  const now = Date.now();
  const s = {
    id: rid('ses'),
    title: body.title || 'New session',
    directory: DIR,
    time: { created: now, updated: now },
    permission: body.permission ?? [],
    metadata: body.metadata ?? {},
    ...(parent ? { parentID: parent } : {}),
  };
  sessions.set(s.id, s);
  messages.set(s.id, []);
  return s;
}
const touch = (s) => {
  s.time.updated = Date.now();
  emit('session.updated', { info: s });
};
const setStatus = (id, type) => {
  status.set(id, type);
  emit('session.status', { sessionID: id, status: { type } });
  if (type === 'idle') emit('session.idle', { sessionID: id });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

async function reply(sid, userText, files) {
  const list = messages.get(sid);
  if (!list) return;
  setStatus(sid, 'busy');
  const info = { id: rid('msg'), sessionID: sid, role: 'assistant', time: { created: Date.now() }, providerID: 'fake', modelID: 'fake-1', cost: 0.0123, tokens: { input: 1200, output: 80, reasoning: 0, cache: { read: 300, write: 0 } } };
  const m = { info, parts: [] };
  list.push(m);
  emit('message.updated', { info });
  const abortedNow = () => status.get(sid) !== 'busy';
  const part = (p) => {
    const full = { id: rid('prt'), messageID: info.id, sessionID: sid, ...p };
    m.parts.push(full);
    emit('message.part.updated', { part: full });
    return full;
  };
  const say = async (body) => {
    const p = part({ type: 'text', text: '' });
    for (let i = 0; i < body.length && !abortedNow(); i += 6) {
      const delta = body.slice(i, i + 6);
      p.text += delta;
      emit('message.part.delta', { sessionID: sid, messageID: info.id, partID: p.id, field: 'text', delta });
      await sleep(15);
    }
    emit('message.part.updated', { part: p });
  };
  const t = userText.toLowerCase();
  const runLine = /^run: (.+)$/m.exec(userText);
  if (runLine) {
    await say(`Try this:\n\n\`\`\`bash\n${runLine[1]}\n\`\`\`\n`);
  } else if (t.includes('slow')) {
    await say('Working on it, this takes a while. ');
    for (let i = 0; i < 600 && !abortedNow(); i += 1) await sleep(100);
  } else if (t.includes('todo')) {
    const list2 = [
      { content: 'Read the config', status: 'completed', priority: 'high' },
      { content: 'Patch the unit file', status: 'in_progress', priority: 'high' },
      { content: 'Restart and verify', status: 'pending', priority: 'medium' },
    ];
    todos.set(sid, list2);
    part({ type: 'tool', tool: 'todowrite', callID: rid('call'), state: { status: 'completed', input: { todos: list2 }, output: '', title: '3 todos' } });
    await say('Plan written. Starting now.');
  } else if (t.includes('perm')) {
    const callID = rid('call');
    const tool = part({ type: 'tool', tool: 'bash', callID, state: { status: 'running', input: { command: 'echo hi', description: 'say hi' }, title: 'echo hi' } });
    const p = { id: rid('per'), sessionID: sid, permission: 'bash', patterns: ['echo hi'], always: ['echo *'], metadata: {}, tool: { messageID: info.id, callID } };
    perms.set(p.id, p);
    emit('permission.asked', p);
    const answer = await new Promise((r) => waiting.set(p.id, r));
    perms.delete(p.id);
    emit('permission.replied', { sessionID: sid, requestID: p.id });
    tool.state = answer === 'reject' ? { status: 'error', input: tool.state.input, error: 'The user rejected permission', title: 'echo hi' } : { status: 'completed', input: tool.state.input, output: 'hi\n', title: 'echo hi' };
    emit('message.part.updated', { part: tool });
    await say(answer === 'reject' ? 'Denied, stopping.' : 'Done: hi');
  } else if (t.includes('restart')) {
    await say('Restart the dashboard:\n\n```bash\nsudo systemctl restart pulse.service\n```\n\nThen check:\n\n```bash\nsystemctl status pulse.service\n```\n');
  } else if (t.includes('image') || files.length) {
    await say(`Got ${files.length} attachment(s): ${files.map((f) => `${f.filename} (${f.mime}, ${String(f.url).length} chars)`).join(', ') || 'none'}`);
  } else {
    await say(`You said: ${userText}\n\n\`\`\`ts\nconst answer: number = 42; // a comment\nconsole.log("hello", answer);\n\`\`\`\n\n- one\n- two\n`);
  }
  info.time.completed = Date.now();
  if (abortedNow()) info.error = { name: 'MessageAbortedError' };
  emit('message.updated', { info });
  setStatus(sid, 'idle');
  touch(sessions.get(sid));
  if (sessions.get(sid).title === 'New session') {
    sessions.get(sid).title = userText.slice(0, 40) || 'Chat';
    touch(sessions.get(sid));
  }
}

function addUser(sid, parts) {
  const info = { id: rid('msg'), sessionID: sid, role: 'user', time: { created: Date.now() } };
  const m = { info, parts: parts.map((p) => ({ id: rid('prt'), messageID: info.id, sessionID: sid, ...p })) };
  messages.get(sid).push(m);
  emit('message.updated', { info });
  for (const p of m.parts) emit('message.part.updated', { part: p });
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== AUTH) return json(res, 401, { error: 'auth' });
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;
  const method = req.method;
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
  let m;

  if (route === '/global/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    streams.add(res);
    res.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
    const beat = setInterval(() => res.write(`data: ${JSON.stringify({ payload: { type: 'server.heartbeat', properties: {} } })}\n\n`), 10_000);
    req.on('close', () => {
      clearInterval(beat);
      streams.delete(res);
    });
    return;
  }
  if (route === '/__drop' && method === 'POST') {
    // Test hook: cut every event stream, like a network drop.
    for (const s of streams) s.destroy();
    streams.clear();
    return json(res, 200, { ok: true });
  }
  if (route === '/__sessions') return json(res, 200, [...sessions.values()].map((x) => ({ ...x, messageCount: messages.get(x.id)?.length ?? 0, status: status.get(x.id) ?? 'idle' })));
  if (route === '/session/status') return json(res, 200, Object.fromEntries([...status].filter(([, v]) => v !== 'idle').map(([k, v]) => [k, { type: v }])));
  if (route === '/experimental/session') return json(res, 200, [...sessions.values()].sort((a, b) => b.time.updated - a.time.updated));
  if (route === '/session' && method === 'POST') {
    const s = mkSession(body);
    emit('session.created', { info: s });
    return json(res, 200, s);
  }
  if (route === '/session') return json(res, 200, [...sessions.values()]);
  if (route === '/command') return json(res, 200, [{ name: 'init', description: 'Create AGENTS.md', source: 'command', template: 'init', hints: [] }]);
  if (route === '/agent') return json(res, 200, [{ name: 'general', description: 'General helper', mode: 'subagent' }]);
  if (route === '/config/providers')
    return json(res, 200, { providers: [{ id: 'fake', name: 'Fake', models: { 'fake-1': { id: 'fake-1', name: 'Fake One', limit: { context: 10000 } }, 'fake-2': { id: 'fake-2', name: 'Fake Two', limit: { context: 20000 } } } }], default: { fake: 'fake-1' } });
  if (route === '/find/file') return json(res, 200, ['src/index.ts', 'README.md'].filter((p) => p.toLowerCase().includes((url.searchParams.get('query') ?? '').toLowerCase())));
  if (route === '/file') return json(res, 200, [{ name: 'notes.txt', path: 'notes.txt', type: 'file' }]);
  if (route === '/permission') return json(res, 200, [...perms.values()]);
  if ((m = /^\/permission\/([^/]+)\/reply$/.exec(route))) {
    const w = waiting.get(m[1]);
    waiting.delete(m[1]);
    w?.(body.reply);
    return json(res, 200, true);
  }
  if ((m = /^\/session\/([^/]+)(?:\/(\w+))?$/.exec(route))) {
    const id = m[1];
    const sub = m[2];
    const s = sessions.get(id);
    if (!s) return json(res, 404, { data: { message: 'session not found' } });
    if (!sub) {
      if (method === 'GET') return json(res, 200, s);
      if (method === 'DELETE') {
        sessions.delete(id);
        messages.delete(id);
        emit('session.deleted', { sessionID: id });
        return json(res, 200, true);
      }
      if (method === 'PATCH') {
        if (typeof body.title === 'string') s.title = body.title;
        if (body.metadata) s.metadata = body.metadata;
        if (body.permission) s.permission = [...(s.permission ?? []), ...body.permission];
        if (body.time?.archived) s.time.archived = body.time.archived;
        touch(s);
        return json(res, 200, s);
      }
    }
    if (sub === 'message') return json(res, 200, messages.get(id));
    if (sub === 'todo') return json(res, 200, todos.get(id) ?? []);
    if (sub === 'prompt_async') {
      const files = body.parts.filter((p) => p.type === 'file');
      if (s.revert) {
        const list = messages.get(id);
        for (const x of list.filter((x) => x.info.id >= s.revert.messageID)) emit('message.removed', { sessionID: id, messageID: x.info.id });
        messages.set(id, list.filter((x) => x.info.id < s.revert.messageID));
        delete s.revert;
        touch(s);
      }
      addUser(id, body.parts);
      json(res, 204);
      // "bulk N": N finished turns appended at once, for long-chat tests (no events, no model).
      const bulk = /^bulk (\d+)$/.exec(text(body.parts).trim());
      if (bulk) {
        const list = messages.get(id);
        for (let i = 1; i <= Number(bulk[1]); i += 1) {
          for (const role of ['user', 'assistant']) {
            const info = { id: rid('msg'), sessionID: id, role, time: { created: Date.now(), ...(role === 'assistant' ? { completed: Date.now() } : {}) }, ...(role === 'assistant' ? { providerID: 'fake', modelID: 'fake-1' } : {}) };
            list.push({ info, parts: [{ id: rid('prt'), messageID: info.id, sessionID: id, type: 'text', text: `${role} turn ${i}` }] });
          }
        }
        if (sessions.get(id).title === 'New session') sessions.get(id).title = 'bulk chat';
        touch(sessions.get(id));
        return;
      }
      void reply(id, text(body.parts), files);
      return;
    }
    if (sub === 'abort') {
      setStatus(id, 'idle');
      for (const [k, w] of waiting) {
        waiting.delete(k);
        w('reject');
      }
      return json(res, 200, true);
    }
    if (sub === 'revert') {
      s.revert = { messageID: body.messageID };
      touch(s);
      return json(res, 200, s);
    }
    if (sub === 'unrevert') {
      delete s.revert;
      touch(s);
      return json(res, 200, s);
    }
    if (sub === 'share') {
      if (method === 'DELETE') delete s.share;
      else s.share = { url: `https://share.invalid/${id}` };
      touch(s);
      return json(res, 200, s);
    }
    if (sub === 'fork') {
      // Like OpenCode: the messages and the metadata are copied, the permission rules are not.
      const f = mkSession({ title: `${s.title} (fork)`, metadata: s.metadata });
      const cut = body.messageID;
      messages.set(f.id, messages.get(id).filter((x) => !cut || x.info.id < cut).map((x) => JSON.parse(JSON.stringify(x))));
      emit('session.created', { info: f });
      return json(res, 200, f);
    }
    if (sub === 'summarize' || sub === 'command') {
      json(res, 200, true);
      void reply(id, sub === 'command' ? `/${body.command} ${body.arguments ?? ''}` : 'summary', []);
      return;
    }
  }
  return json(res, 404, { data: { message: `no route ${method} ${route}` } });
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake opencode on 127.0.0.1:${PORT}`));
