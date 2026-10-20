#!/usr/bin/env node
// Chat end-to-end tests: fake OpenCode + isolated Pulse + headless Chrome.
//
//   node scripts/chat-test/run.mjs [--root <built tree>] [--shots <dir>]
//
// Needs a built tree (npm run build). Prints one line per check; exit 1 on a failure.
import path from 'node:path';
import { assert, sleep, start, suite } from './harness.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const shots = arg('shots');
const t = await start({ root: arg('root') });
const s = suite('chat');
const shot = (n) => (shots ? t.shot(path.join(shots, `${n}.png`)) : undefined);

const openChat = async () => {
  await t.ev(`document.querySelector('.chat-fab')?.click()`);
  await t.waitFor(`!!document.querySelector('.chat-overlay[data-phase="open"] textarea')`, 8000, 'chat open');
};
const type = async (text) => {
  await t.ev(`(()=>{const el=document.querySelector('.chat-composer textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));el.focus();return true})()`);
};
const sendText = async (text) => {
  await type(text);
  await t.ev(`document.querySelector('.chat-composer .chat-send[type=submit]').click()`);
};
const idle = () => t.waitFor(`!document.querySelector('.chat-working') && document.querySelectorAll('.chat-msg.is-assistant').length>0`, 15000, 'reply done');

try {
  await t.viewport(1280, 900, false);
  await t.login();
  await s.check('chat opens', openChat);
  await s.check('send and get a streamed reply', async () => {
    await sendText('hello there');
    await idle();
    const txt = await t.ev(`document.querySelector('.chat-msg.is-assistant')?.textContent ?? ''`);
    assert(txt.includes('You said: hello there'), `reply was: ${txt.slice(0, 80)}`);
    await shot('base-reply');
  });
  // Feature checks are appended below by each phase.
  
  // ---- Phase 1 ----
  await s.check('code block is highlighted (keyword, string, comment)', async () => {
    const cls = await t.ev(`[...document.querySelectorAll('.md-code code span')].map(e=>e.className).join(' ')`);
    assert(/tok-k/.test(cls) && /tok-s/.test(cls) && /tok-c/.test(cls), `classes: ${cls}`);
    const text = await t.ev(`document.querySelector('.md-code code').textContent`);
    assert(text === 'const answer: number = 42; // a comment\nconsole.log("hello", answer);', `text changed: ${JSON.stringify(text)}`);
  });
  await s.check('wrap toggle works', async () => {
    await t.ev(`document.querySelector('.md-code .md-copy[aria-label="Wrap long lines"]').click()`);
    assert(await t.ev(`document.querySelector('.md-code').classList.contains('is-wrap')`), 'not wrapped');
  });
  await s.check('message actions: copy, retry on last reply, edit on user', async () => {
    assert((await t.ev(`document.querySelectorAll('.chat-msg.is-assistant .chat-act').length`)) >= 2, 'assistant actions missing');
    assert((await t.ev(`document.querySelectorAll('.chat-msg.is-user .chat-act').length`)) >= 2, 'user actions missing');
  });
  await s.check('edit puts the prompt back in the box and hides the old turn', async () => {
    await t.ev(`document.querySelector('.chat-msg.is-user .chat-act[aria-label="Edit and send again"]').click()`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value === 'hello there'`, 6000, 'prompt back in box');
    await t.waitFor(`!!document.querySelector('.chat-undone')`, 6000, 'undone banner');
    await t.ev(`(()=>{const el=document.querySelector('.chat-composer textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,'edited hello');el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await t.ev(`document.querySelector('.chat-composer .chat-send[type=submit]').click()`);
    await t.waitFor(`document.querySelector('.chat-msg.is-assistant')?.textContent.includes('You said: edited hello')`, 12000, 'new reply');
    await t.waitFor(`document.querySelectorAll('.chat-msg.is-user').length === 1`, 6000, 'old turn gone');
  });
  await s.check('retry sends the same prompt again', async () => {
    await t.waitFor(`!document.querySelector('.chat-working')`, 8000, 'idle');
    // Tag the current reply: a fresh one is a new element without the tag.
    await t.ev(`document.querySelectorAll('.chat-msg').forEach(e=>e.dataset.old='1')`);
    await t.ev(`document.querySelector('.chat-msg.is-assistant .chat-act[aria-label="Try again"]').click()`);
    await t.waitFor(`!!document.querySelector('.chat-msg.is-assistant:not([data-old])') && !document.querySelector('.chat-working')`, 12000, 'fresh reply');
    assert((await t.ev(`document.querySelectorAll('.chat-msg.is-user').length`)) === 1, 'one user turn');
    assert(await t.ev(`document.querySelector('.chat-msg.is-assistant:not([data-old])').textContent.includes('You said: edited hello')`), 'same prompt answered');
  });
  await s.check('todo plan shows a progress panel and a checklist card', async () => {
    await sendText('make a todo plan');
    await t.waitFor(`!!document.querySelector('.chat-progress')`, 10000, 'progress panel');
    const head = await t.ev(`document.querySelector('.chat-progress-title').textContent`);
    assert(head.includes('1/3') && head.includes('Patch the unit file'), `head: ${head}`);
    assert((await t.ev(`document.querySelectorAll('.chat-progress .chat-todos li').length`)) === 3, 'three items');
    await shot('p1-progress');
    await t.waitFor(`!document.querySelector('.chat-working')`, 8000, 'idle');
  });
  await s.check('alerts toggle is in the chat menu', async () => {
    await t.ev(`document.querySelector('button[aria-label="Chat options"]').click()`);
    assert(await t.ev(`!!document.querySelector('.chat-menu-pop [role=menuitemcheckbox]')`), 'no alerts item');
    await t.ev(`document.querySelector('.pop-backdrop').click()`);
  });
  await s.check('phone width: actions reachable, code wraps by default', async () => {
    await t.viewport(390, 844, true);
    await sleep(400);
    await shot('p1-mobile');
    assert(!(await t.ev(`document.documentElement.scrollWidth > window.innerWidth + 1`)), 'horizontal overflow');
    await t.viewport(1280, 900, false);
  });
  
  // ---- Phase 2 ----
  const api = (path) => t.ev(`fetch(${JSON.stringify(path)}).then(async r=>({status:r.status,body:await r.json().catch(()=>null)}))`);
  await s.check('context endpoint: metrics, bad kind, bad unit', async () => {
    const m = await api('/api/chat/context?kind=metrics');
    assert(m.status === 200 && /CPU \d+%/.test(m.body.text) && /RAM \d+%/.test(m.body.text), `metrics: ${JSON.stringify(m).slice(0, 120)}`);
    assert((await api('/api/chat/context?kind=nope')).status === 400, 'bad kind accepted');
    assert((await api('/api/chat/context?kind=logs&name=' + encodeURIComponent('x;rm -rf /'))).status === 400, 'bad unit accepted');
    assert((await api('/api/chat/context?kind=diagnose&name=no-such-thing-here')).status === 404, 'unknown service accepted');
    const d = await api('/api/chat/context?kind=disk');
    assert(d.status === 200 && /used/.test(d.body.text), 'disk');
  });
  await s.check('"+" menu puts a host snapshot in the box (readable, editable)', async () => {
    await t.ev(`document.querySelector('.chat-ctx-btn').click()`);
    await t.waitFor(`!!document.querySelector('.chat-ctx-pop')`, 4000, 'menu');
    await t.ev(`[...document.querySelectorAll('.chat-ctx-pop .menu-item')].find(b=>b.textContent.includes('Host snapshot')).click()`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value.includes('Host snapshot:')`, 8000, 'snapshot in box');
    const v = await t.ev(`document.querySelector('.chat-composer textarea').value`);
    assert(v.includes('```text') && /CPU \d+%/.test(v), 'block shape');
    await shot('p2-snapshot');
    await type('');
  });
  await s.check('/why-slow fills the box with the question and a snapshot, and sends nothing', async () => {
    const before = await t.ev(`document.querySelectorAll('.chat-msg.is-user').length`);
    await type('/why-slow');
    await t.ev(`document.querySelector('.chat-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value.includes('The server feels slow')`, 8000, 'template in box');
    assert((await t.ev(`document.querySelector('.chat-composer textarea').value`)).includes('Host snapshot:'), 'snapshot missing');
    assert((await t.ev(`document.querySelectorAll('.chat-msg.is-user').length`)) === before, 'something was sent');
    await type('');
  });
  await s.check('/diagnose waits for a name; an unknown one says so', async () => {
    await type('/diagnose');
    await t.ev(`document.querySelector('.chat-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value === '/diagnose '`, 4000, 'waits for a name');
    await type('/diagnose no-such-thing-here');
    await t.ev(`document.querySelector('.chat-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await t.waitFor(`document.querySelector('.toast')?.textContent.includes('no service called')`, 6000, 'toast');
    await type('');
  });
  await s.check('a suggested restart command gets a Run button that only asks to confirm', async () => {
    const targets = (await api('/api/chat/targets')).body;
    const sys = targets.systemd[0];
    const cmd = targets.docker[0] ? `docker restart ${targets.docker[0]}` : sys ? `${sys.scope === 'user' ? 'systemctl --user' : 'sudo systemctl'} restart ${sys.unit}` : null;
    if (!cmd) throw new Error('this host has no target to try');
    await sendText(`run: ${cmd}`);
    await t.waitFor(`!!document.querySelector('.chat-run-btn')`, 12000, 'run button');
    await sleep(400);
    assert(!(await t.ev(`!!document.querySelector('.chat-progress')`)), 'an earlier turn\'s plan is still shown');
    const geo = await t.ev(`(()=>{const b=document.querySelector('.chat-run-btn').getBoundingClientRect();const c=document.querySelector('.chat-composer').getBoundingClientRect();const sc=document.querySelector('.chat-scroll');const p=document.querySelector('.chat-progress')?.getBoundingClientRect();return {btnBottom:b.bottom,composerTop:c.top,progressTop:p?.top??null,scrollTop:sc.scrollTop,scrollH:sc.scrollHeight,clientH:sc.clientHeight,jump:!!document.querySelector('.chat-jump'),scBottom:sc.getBoundingClientRect().bottom}})()`);
    assert(geo.btnBottom <= geo.scBottom + 1, `Run button below the thread's visible area: ${JSON.stringify(geo)}`);
    await shot('p2-run');
    await t.ev(`document.querySelector('.chat-run-btn').click()`);
    await t.waitFor(`!!document.querySelector('.chat-run-confirm')`, 6000, 'confirm step');
    assert(!(await t.ev(`!!document.querySelector('.chat-run-result.is-ok')`)), 'ran without confirming');
    await t.ev(`[...document.querySelectorAll('.chat-run-confirm button')].find(b=>b.textContent==='Cancel').click()`);
    await t.waitFor(`!document.querySelector('.chat-run-confirm')`, 3000, 'cancelled');
    await t.waitFor(`!document.querySelector('.chat-working')`, 8000, 'idle');
  });
  await s.check('no Run button for unknown units or compound lines', async () => {
    const before = await t.ev(`document.querySelectorAll('.chat-run-btn').length`);
    await sendText('run: sudo systemctl restart definitely-not-a-unit');
    await t.waitFor(`document.querySelectorAll('.md-code').length >= 3 && !document.querySelector('.chat-working')`, 12000, 'reply');
    await sendText('run: docker restart a && docker restart b');
    await t.waitFor(`!document.querySelector('.chat-working') && [...document.querySelectorAll('.md-code code')].some(c=>c.textContent.includes('&&'))`, 12000, 'reply 2');
    assert((await t.ev(`document.querySelectorAll('.chat-run-btn').length`)) === before, 'extra Run buttons');
  });
  await s.check('"Ask agent" on the logs panel opens a new chat with the logs in the box', async () => {
    await t.ev(`document.querySelector('.chat-overlay [aria-label^="Minimize"]').click()`);
    await sleep(500);
    await t.goto('#logs-and-control');
    await t.waitFor(`[...document.querySelectorAll('.toolbar-compact button')].some(b=>b.textContent.includes('Ask agent'))`, 10000, 'ask button');
    await t.ev(`[...document.querySelectorAll('.toolbar-compact button')].find(b=>b.textContent.includes('Ask agent')).click()`);
    await t.waitFor(`document.querySelector('.chat-overlay[data-phase="open"] .chat-composer textarea')?.value.includes('Read the recent logs')`, 12000, 'logs in box');
    assert((await t.ev(`document.querySelector('.chat-composer textarea').value`)).includes('Logs of'), 'no logs block');
    assert(await t.ev(`!!document.querySelector('.chat-empty')`), 'not a new chat');
  });
  /*__CHECKS__*/
} catch (err) {
  console.log('ABORT', err instanceof Error ? err.stack : err);
  console.log(t.logs().pulse.split('\n').slice(-15).join('\n'));
  s.check('suite ran to the end', () => {
    throw err;
  });
}
const ok = s.done();
await t.close();
process.exit(ok ? 0 : 1);
