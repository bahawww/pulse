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
  
  // ---- Phase 3 ----
  // Files are handed to the page like a user would: paste (clipboard) and drop (drag and drop).
  const mkFiles = `(async()=>{
    const blob=(c,t,q)=>new Promise(r=>c.toBlob(r,t,q));
    const small=document.createElement('canvas'); small.width=120; small.height=80; small.getContext('2d').fillStyle='#39c'; small.getContext('2d').fillRect(0,0,120,80);
    const big=document.createElement('canvas'); big.width=3000; big.height=2000; const g=big.getContext('2d');
    for(let i=0;i<4000;i++){g.fillStyle='rgb('+(Math.random()*255|0)+','+(Math.random()*255|0)+','+(Math.random()*255|0)+')';g.fillRect(Math.random()*3000,Math.random()*2000,40,40)}
    window.__files={
      dot:new File([await blob(small,'image/png')],'dot.png',{type:'image/png'}),
      big:new File([await blob(big,'image/png')],'photo.png',{type:'image/png'}),
      log:new File(['line one\\nline two\\n'],'notes.log',{type:'text/plain'}),
      env:new File(['TOKEN=abc'],'.env',{type:'text/plain'}),
      bin:new File([new Uint8Array([0,1,2,3])],'data.bin',{type:'application/octet-stream'}),
    };
    return Object.fromEntries(Object.entries(window.__files).map(([k,f])=>[k,f.size]));
  })()`;
  const paste = (...names) => t.ev(`(()=>{const dt=new DataTransfer();for(const n of ${JSON.stringify(names)})dt.items.add(window.__files[n]);document.querySelector('.chat-composer textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return true})()`);
  const waitIdle = () => t.waitFor(`!document.querySelector('.chat-working') && !document.querySelector('.chat-attach.is-busy')`, 15000, 'idle');
  await s.check('pasted image and text file become attachments (big image is shrunk)', async () => {
    const sizes = await t.ev(mkFiles);
    assert(sizes.big > 340_000, `test image too small to prove shrinking: ${sizes.big}`);
    await sendText('hello');
    await waitIdle();
    await paste('dot', 'big', 'log');
    await t.waitFor(`document.querySelectorAll('.chat-attach:not(.is-busy)').length === 3 && !document.querySelector('.chat-attach.is-busy')`, 20000, 'three chips');
    await shot('p3-attach');
    const names = await t.ev(`[...document.querySelectorAll('.chat-attach-name')].map(e=>e.textContent).join('|')`);
    assert(names === 'dot.png|photo.png|notes.log', names);
  });
  await s.check('send: server gets the files; the box and chips clear; chips show in the bubble', async () => {
    await type('what is this');
    await t.ev(`document.querySelector('.chat-composer .chat-send[type=submit]').click()`);
    await t.waitFor(`document.querySelector('.chat-msg.is-assistant:last-of-type')?.textContent.includes('Got 3 attachment')`, 15000, 'reply about attachments');
    const reply = await t.ev(`[...document.querySelectorAll('.chat-msg.is-assistant')].pop().textContent`);
    assert(/dot\.png \(image\/png/.test(reply), `dot: ${reply}`);
    assert(/photo\.png \(image\/jpeg/.test(reply), `big image not re-encoded: ${reply}`);
    assert(/notes\.log \(text\/plain/.test(reply), `log: ${reply}`);
    assert((await t.ev(`document.querySelectorAll('.chat-attach').length`)) === 0, 'chips not cleared');
    await waitIdle();
    const chips = await t.ev(`[...document.querySelectorAll('.chat-msg.is-user')].pop().querySelectorAll('.chat-file').length`);
    assert(chips === 3, `bubble chips: ${chips}`);
    assert(!(await t.ev(`!!document.querySelector('.chat-msg.is-assistant:last-of-type .chat-act[aria-label="Try again"]')`)), 'Try again offered for a message with attachments');
  });
  await s.check('a secret-looking file is refused, and the text and files come back', async () => {
    await paste('env');
    await t.waitFor(`document.querySelectorAll('.chat-attach:not(.is-busy)').length === 1`, 8000, 'env chip');
    await type('see this');
    await t.ev(`document.querySelector('.chat-composer .chat-send[type=submit]').click()`);
    await t.waitFor(`document.querySelector('.toast')?.textContent.includes('looks like a secret file')`, 8000, 'refusal toast');
    await t.waitFor(`document.querySelector('.chat-composer textarea').value === 'see this' && document.querySelectorAll('.chat-attach').length === 1`, 6000, 'text and file restored');
    await t.ev(`document.querySelector('.chat-attach button').click()`);
    await type('');
    assert((await t.ev(`document.querySelectorAll('.chat-attach').length`)) === 0, 'remove failed');
  });
  await s.check('a binary file is refused with a reason; drop works too', async () => {
    await paste('bin');
    await t.waitFor(`document.querySelector('.toast')?.textContent.includes('only images and text files')`, 8000, 'binary refused');
    assert((await t.ev(`document.querySelectorAll('.chat-attach').length`)) === 0, 'binary attached');
    await t.ev(`(()=>{const dt=new DataTransfer();dt.items.add(window.__files.log);document.dispatchEvent(new DragEvent('dragenter',{dataTransfer:dt,bubbles:true,cancelable:true}))})()`);
    assert(await t.ev(`document.querySelector('.chat-composer').classList.contains('is-drop')`), 'no drop highlight');
    await t.ev(`(()=>{const dt=new DataTransfer();dt.items.add(window.__files.log);document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))})()`);
    await t.waitFor(`document.querySelectorAll('.chat-attach:not(.is-busy)').length === 1 && !document.querySelector('.chat-composer').classList.contains('is-drop')`, 8000, 'dropped file attached');
    await t.ev(`document.querySelector('.chat-attach button').click()`);
  });
  await s.check('a file with no words still sends (with a default sentence)', async () => {
    await paste('dot');
    await t.waitFor(`document.querySelectorAll('.chat-attach:not(.is-busy)').length === 1`, 8000, 'chip');
    await t.ev(`document.querySelector('.chat-composer .chat-send[type=submit]').click()`);
    await t.waitFor(`[...document.querySelectorAll('.chat-msg.is-user')].pop()?.textContent.includes('Please look at the attached image')`, 12000, 'default sentence');
    await waitIdle();
  });
  await s.check('drafts are kept per chat', async () => {
    await type('draft in chat A');
    await sleep(600);
    await t.ev(`document.querySelector('.chat-new').click()`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value === ''`, 4000, 'empty box in a new chat');
    await type('draft in chat B');
    await sleep(600);
    await t.ev(`document.querySelector('.chat-session:not(.is-current) .chat-session-main, .chat-session .chat-session-main').click()`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value === 'draft in chat A'`, 6000, 'chat A draft back');
    await t.ev(`document.querySelector('.chat-new').click()`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value === 'draft in chat B'`, 6000, 'chat B draft back');
    await type('');
    await sleep(500);
  });
  await s.check('up arrow in an empty box brings back the last message', async () => {
    await t.ev(`document.querySelector('.chat-session .chat-session-main').click()`);
    await t.waitFor(`document.querySelectorAll('.chat-msg.is-user').length > 0`, 6000, 'chat loaded');
    await type('');
    await t.ev(`document.querySelector('.chat-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value.length > 0`, 4000, 'last prompt in box');
    await type('');
  });
  await s.check('size hint shows for a long message', async () => {
    await type('x'.repeat(900));
    await t.waitFor(`document.querySelector('.chat-est')?.textContent.includes('~225')`, 4000, 'estimate');
    await type('');
  });
  await s.check('dictation button does not break the page', async () => {
    const present = await t.ev(`!!document.querySelector('.chat-ctx-btn[aria-label="Dictate"]')`);
    if (!present) return; // this browser has no speech recognition: no button is correct
    await t.ev(`document.querySelector('.chat-ctx-btn[aria-label="Dictate"]').click()`);
    await sleep(1500);
    // Headless Chrome has no microphone or speech service: it must say so (a toast) or listen, not hang.
    await t.ev(`document.querySelector('.chat-ctx-btn[aria-label="Stop dictation"]')?.click()`);
    await sleep(300);
    assert(await t.ev(`!!document.querySelector('.chat-composer textarea')`), 'page broke');
  });
  
  await s.check('server refuses bad attachments (wrong type, wrong bytes, too many, bad base64, too big)', async () => {
    const res = await t.ev(`(async()=>{
      const me = await (await fetch('/api/auth/me')).json();
      const list = await (await fetch('/api/chat/sessions')).json();
      const id = list.sessions[0].id;
      const post = async (attachments) => (await fetch('/api/chat/sessions/'+id+'/prompt',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':me.csrf},body:JSON.stringify({text:'x',attachments})})).status;
      const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      return {
        ok: await post([{name:'a.png',mime:'image/png',data:png}]),
        jpegBytesAsPng: await post([{name:'a.png',mime:'image/jpeg',data:png}]),
        pdf: await post([{name:'a.pdf',mime:'application/pdf',data:png}]),
        proto: await post([{name:'a.png',mime:'constructor',data:png}]),
        five: await post(Array.from({length:5},()=>({name:'a.png',mime:'image/png',data:png}))),
        badB64: await post([{name:'a.png',mime:'image/png',data:'not base64!!'}]),
        big: await post([{name:'a.txt',mime:'text/plain',data:'QQ=='.repeat(1).padEnd(450000,'A')}]),
        key: await post([{name:'id_rsa',mime:'text/plain',data:'aGk='}]),
        pem: await post([{name:'x.pem',mime:'text/plain',data:'aGk='}]),
        pathName: await post([{name:'../../etc/x.txt',mime:'text/plain',data:'aGk='}]),
      };
    })()`);
    assert(res.ok === 200, `valid png: ${res.ok}`);
    for (const k of ['jpegBytesAsPng','pdf','proto','five','badB64','key','pem']) assert(res[k] === 400, `${k}: ${res[k]}`);
    assert(res.big === 400 || res.big === 413, `big: ${res.big}`);
    assert(res.pathName === 200, `a path in the name is cut, not refused: ${res.pathName}`);
    await sleep(1500);
  });
  
  // ---- Phase 4 ----
  const newChat = async () => { await t.ev(`document.querySelector('.chat-new').click()`); await t.waitFor(`!!document.querySelector('.chat-empty')`, 5000, 'new chat'); };
  await s.check('chats are grouped by day; filter and origin chips work', async () => {
    await newChat(); await sendText('alpha topic here'); await waitIdle();
    await newChat(); await sendText('beta subject there zebra-quartz-7'); await waitIdle();
    assert((await t.ev(`[...document.querySelectorAll('.chat-side .chat-group-title')].map(e=>e.textContent).join('|')`)).includes('Today'), 'no Today group');
    await t.ev(`(()=>{const el=document.querySelector('.chat-side .chat-search input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'alpha');el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await t.waitFor(`document.querySelectorAll('.chat-side .chat-session').length === 1 && document.querySelector('.chat-side .chat-session').textContent.includes('alpha')`, 4000, 'filtered to alpha');
    await t.ev(`(()=>{const el=document.querySelector('.chat-side .chat-search input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await t.ev(`[...document.querySelectorAll('.chat-side .chat-chip')].find(b=>b.textContent==='Other').click()`);
    await t.waitFor(`document.querySelector('.chat-side .chat-sessions').textContent.includes('No chat matches')`, 4000, 'no Other chats');
    await t.ev(`[...document.querySelectorAll('.chat-side .chat-chip')].find(b=>b.textContent==='All').click()`);
  });
  await s.check('Enter in the filter searches inside the chats', async () => {
    await t.ev(`(()=>{const el=document.querySelector('.chat-side .chat-search input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'zebra-quartz');el.dispatchEvent(new Event('input',{bubbles:true}));el.form.requestSubmit()})()`);
    await t.waitFor(`document.querySelector('.chat-side .chat-session-snippet')?.textContent.includes('zebra-quartz-7')`, 12000, 'search hit with a snippet');
    assert((await t.ev(`document.querySelectorAll('.chat-side .chat-session').length`)) === 1, 'one hit expected');
    await shot('p4-search');
    await t.ev(`document.querySelector('.chat-side .chat-link').click()`);
    await t.ev(`(()=>{const el=document.querySelector('.chat-side .chat-search input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  });
  await s.check('pin moves a chat to the top group and back', async () => {
    const menu = async (label) => { await t.ev(`document.querySelector('button[aria-label="Chat options"]').click()`); await t.waitFor(`!!document.querySelector('.chat-menu-pop')`, 3000, 'menu'); await t.ev(`[...document.querySelectorAll('.chat-menu-pop:not(.is-leaving) .menu-item')].find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`); };
    await t.ev(`[...document.querySelectorAll('.chat-side .chat-session-main')].find(b=>b.textContent.includes('alpha')).click()`);
    await t.waitFor(`document.querySelector('.chat-title')?.textContent.includes('alpha')`, 5000, 'alpha open');
    await menu('Pin to the top');
    await t.waitFor(`document.querySelector('.chat-side .chat-group-title')?.textContent === 'Pinned' && document.querySelector('.chat-side .chat-group .chat-session').textContent.includes('alpha')`, 6000, 'pinned group first');
    await menu('Unpin');
    await t.waitFor(`![...document.querySelectorAll('.chat-side .chat-group-title')].some(e=>e.textContent==='Pinned')`, 6000, 'unpinned');
  });
  await s.check('branch from a reply keeps the rules and copies messages up to it', async () => {
    await sendText('second turn'); await waitIdle();
    const before = (await t.fakeSessions()).length;
    const origRules = (await t.fakeSessions()).find((x) => x.title.startsWith('alpha')).permission;
    assert(origRules.length > 0, 'original has no rules to compare');
    await t.ev(`document.querySelectorAll('.chat-msg.is-assistant')[0].querySelector('.chat-act[aria-label="Branch into a new chat"]').click()`);
    await t.waitFor(`document.querySelector('.chat-title')?.textContent.includes('(fork')`, 8000, 'fork open');
    const all = await t.fakeSessions();
    assert(all.length === before + 1, 'fork not created');
    const fork = all.find((x) => x.title.includes('(fork'));
    assert(fork.messageCount === 2, `fork has ${fork.messageCount} messages, wanted 2 (turn one)`);
    assert(JSON.stringify(fork.permission) === JSON.stringify(origRules), `fork rules differ: ${JSON.stringify(fork.permission)}`);
    assert((await t.ev(`document.querySelectorAll('.chat-msg.is-user').length`)) === 1, 'fork should show one user turn');
  });
  await s.check('branch from a user message: earlier turns kept, its text ready to edit', async () => {
    await t.ev(`[...document.querySelectorAll('.chat-side .chat-session-main')].find(b=>b.textContent.includes('alpha topic here') && !b.textContent.includes('fork')).click()`);
    await t.waitFor(`document.querySelectorAll('.chat-msg.is-user').length === 2`, 6000, 'two turns');
    await t.ev(`document.querySelectorAll('.chat-msg.is-user')[1].querySelector('.chat-act[aria-label="Branch into a new chat"]').click()`);
    await t.waitFor(`document.querySelector('.chat-composer textarea').value === 'second turn'`, 8000, 'text in the box');
    assert((await t.ev(`document.querySelectorAll('.chat-msg.is-user').length`)) === 1, 'fork should hold only turn one');
    await type('');
  });
  await s.check('export builds a Markdown file; the whole-chat copy works from the menu', async () => {
    await t.ev(`(()=>{window.__blob=null;const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blob=b;return o(b)};HTMLAnchorElement.prototype.click=function(){window.__downloadName=this.download}})()`);
    await t.ev(`document.querySelector('button[aria-label="Chat options"]').click()`);
    await t.ev(`[...document.querySelectorAll('.chat-menu-pop:not(.is-leaving) .menu-item')].find(b=>b.textContent.includes('Export as Markdown')).click()`);
    await t.waitFor(`!!window.__blob`, 4000, 'blob made');
    const md = await t.ev(`window.__blob.text()`);
    assert(md.startsWith('# ') && md.includes('## You') && md.includes('## Agent'), `markdown: ${md.slice(0, 160)}`);
    assert(/\.md$/.test(await t.ev(`window.__downloadName`)), 'file name');
    const before = (await t.fakeSessions()).length;
    const forksBefore = await t.ev(`performance.getEntriesByType('resource').filter(r=>r.name.includes('/fork')).length`);
    await t.ev(`document.querySelector('button[aria-label="Chat options"]').click()`);
    const items = await t.ev(`[...document.querySelectorAll('.chat-menu-pop:not(.is-leaving) .menu-item')].map(b=>b.textContent).join('|')`);
    await t.ev(`[...document.querySelectorAll('.chat-menu-pop:not(.is-leaving) .menu-item')].find(b=>b.textContent.includes('Copy into a new chat')).click()`);
    await sleep(1500);
    assert((await t.fakeSessions()).length === before + 1, `whole-chat copy not made; toast: ${await t.ev(`document.querySelector('.toast')?.textContent ?? ''`)}; title: ${await t.ev(`document.querySelector('.chat-title')?.textContent`)}; items ${items}; forks ${forksBefore}->${await t.ev(`performance.getEntriesByType('resource').filter(r=>r.name.includes('/fork')).length`)}; pulse log: ${t.logs().pulse.split('\n').slice(-4).join(' / ')}`);
  });
  
  // ---- Phase 5 ----
  await s.check('a long chat draws the latest 60 messages and keeps your place when earlier ones load', async () => {
    await newChat();
    await sendText('bulk 50');
    await sleep(800);
    // Leave and come back: the history is fetched fresh (all 101 messages).
    await t.ev(`[...document.querySelectorAll('.chat-side .chat-session-main')].find(b=>!b.closest('.chat-session').classList.contains('is-current')).click()`);
    await sleep(600);
    await t.ev(`[...document.querySelectorAll('.chat-side .chat-session-main')].find(b=>b.textContent.includes('bulk chat')).click()`);
    await t.waitFor(`document.querySelectorAll('.chat-msg').length === 60`, 8000, 'sixty messages drawn');
    assert(await t.ev(`!!document.querySelector('.chat-earlier')`), 'no "show earlier" button');
    assert((await t.ev(`document.querySelector('.chat-earlier').textContent`)).includes('41 hidden'), 'hidden count');
    assert(await t.ev(`document.querySelector('.chat-scroll').scrollTop + document.querySelector('.chat-scroll').clientHeight >= document.querySelector('.chat-scroll').scrollHeight - 4`), 'not at the bottom');
    await t.ev(`document.querySelector('.chat-scroll').scrollTop = 0`);
    await sleep(300);
    // The first message on screen must stay where it is after earlier ones are added above it.
    const probe = await t.ev(`(()=>{const sc=document.querySelector('.chat-scroll').getBoundingClientRect();const m=[...document.querySelectorAll('.chat-msg')].find(e=>e.getBoundingClientRect().top>sc.top+60);window.__probe=m;return {text:m.textContent.slice(0,30),top:m.getBoundingClientRect().top}})()`);
    await t.ev(`document.querySelector('.chat-earlier').click()`);
    await t.waitFor(`document.querySelectorAll('.chat-msg').length === 101 && !document.querySelector('.chat-earlier')`, 6000, 'all drawn');
    const after = await t.ev(`window.__probe.getBoundingClientRect().top`);
    assert(Math.abs(after - probe.top) < 3, `view jumped: ${probe.top} -> ${after} (${probe.text})`);
  });
  await s.check('a dropped connection shows a banner, reconnects by itself and the chat keeps working', async () => {
    await newChat();
    await sendText('before the outage'); await waitIdle();
    await t.restartPulse(3500);
    await t.waitFor(`!!document.querySelector('.chat-status.is-link')`, 10000, 'connection banner').catch(() => { /* a fast browser retry may beat the banner delay */ });
    await t.waitFor(`!document.querySelector('.chat-status.is-link')`, 20000, 'banner gone after reconnect');
    await sendText('after the outage');
    await t.waitFor(`[...document.querySelectorAll('.chat-msg.is-assistant')].pop()?.textContent.includes('You said: after the outage')`, 15000, 'reply after reconnect');
    await waitIdle();
  });
  await s.check('the page comes back from an outage mid-turn: text kept, still shown as working, Stop works', async () => {
    await sendText('slow please');
    await t.waitFor(`[...document.querySelectorAll('.chat-msg.is-assistant')].pop()?.textContent.includes('Working on it') && !!document.querySelector('.chat-working')`, 10000, 'agent working');
    await t.restartPulse(2000);
    await t.waitFor(`!document.querySelector('.chat-status.is-link')`, 20000, 'reconnected');
    await t.waitFor(`[...document.querySelectorAll('.chat-msg.is-assistant')].pop()?.textContent.includes('Working on it') && !!document.querySelector('.chat-working')`, 15000, 'text kept and still working').catch(async (err) => {
      const state = await t.ev(`JSON.stringify({msgs:[...document.querySelectorAll('.chat-msg')].map(e=>e.className.replace('chat-msg','').trim()+':'+e.textContent.slice(0,30)),working:!!document.querySelector('.chat-working'),banner:!!document.querySelector('.chat-status'),upstream:document.querySelector('.chat-upstream')?.textContent,title:document.querySelector('.chat-title')?.textContent})`);
      throw new Error(`${err.message}: ${state} fake: ${JSON.stringify((await t.fakeSessions()).map((x) => [x.title, x.messageCount, x.status]))} api: ${await t.ev(`fetch('/api/chat/sessions').then(r=>r.json()).then(j=>JSON.stringify(j.sessions.map(x=>[x.title,x.busy])))`)}`);
    });
    await t.ev(`document.querySelector('.chat-send.is-stop').click()`);
    await t.waitFor(`!document.querySelector('.chat-working')`, 20000, 'idle after Stop');
  });
  
  await s.check('phone layout: files in the box, the chat list sheet, a long answer; nothing scrolls sideways', async () => {
    await t.viewport(390, 844, true);
    await sleep(500);
    await paste('dot', 'log');
    await t.waitFor(`document.querySelectorAll('.chat-attach:not(.is-busy)').length === 2`, 8000, 'chips on phone');
    await shot('p5-mobile-composer');
    assert(!(await t.ev(`document.documentElement.scrollWidth > window.innerWidth + 1 || document.querySelector('.chat-composer').scrollWidth > document.querySelector('.chat-composer').clientWidth + 1`)), 'composer overflows');
    await t.ev(`document.querySelectorAll('.chat-attach button').forEach(b=>b.click())`);
    await t.ev(`document.querySelector('.chat-list-btn').click()`);
    await t.waitFor(`!!document.querySelector('.chat-list-pop .chat-search')`, 4000, 'list sheet');
    await shot('p5-mobile-list');
    assert(!(await t.ev(`document.documentElement.scrollWidth > window.innerWidth + 1`)), 'page overflows with the sheet open');
    await t.ev(`document.querySelector('.pop-backdrop')?.click()`);
    await t.viewport(1280, 900, false);
  });
  
  await s.check('phone dashboard: few buttons per row, sheets cover the chat button', async () => {
    await t.ev(`document.querySelector('.chat-overlay [aria-label^="Minimize"]')?.click()`);
    await sleep(500);
    await t.viewport(450, 900, true);
    await t.goto('#logs-and-control');
    await t.waitFor(`document.querySelectorAll('.action-row.is-target').length > 0`, 12000, 'service rows');
    const counts = await t.ev(`[...document.querySelectorAll('.action-row.is-target')].map(r=>[...r.querySelectorAll('button')].filter(b=>b.offsetParent!==null).length)`);
    assert(counts.every((n) => n <= 2), `buttons per row: ${counts}`);
    assert(!(await t.ev(`document.documentElement.scrollWidth > window.innerWidth + 1`)), 'page scrolls sideways');
    const name = await t.ev(`(()=>{const e=document.querySelector('.action-row.is-target .action-name');return e.scrollWidth<=e.clientWidth+1})()`);
    assert(name, 'service name is cut off');
    await t.ev(`window.scrollTo(0, document.querySelector('#actions-h').getBoundingClientRect().top + scrollY - 130)`);
    await sleep(400);
    await t.ev(`document.querySelector('[aria-label^="More for"]').click()`);
    await sleep(600);
    assert(await t.ev(`(()=>{const f=document.querySelector('.chat-fab').getBoundingClientRect();const el=document.elementFromPoint(f.left+f.width/2,f.top+f.height/2);return !!el?.closest('.pop, .pop-backdrop')})()`), 'the chat button shows through the sheet');
    await shot('p6-service-sheet');
    await t.ev(`document.querySelector('.pop-backdrop').click()`);
    await t.goto('#workload');
    await t.waitFor(`document.querySelectorAll('.proc-table tbody tr').length > 0`, 10000, 'process rows');
    assert(!(await t.ev(`document.documentElement.scrollWidth > window.innerWidth + 1 || document.querySelector('.proc-table').closest('div').scrollWidth > document.querySelector('.proc-table').closest('div').clientWidth + 1`)), 'process table scrolls sideways');
    await t.viewport(1280, 900, false);
  });
  await s.check('phone chat box: one "+" holds attach, dictate and host info', async () => {
    await t.viewport(450, 900, true);
    await t.goto('');
    await t.ev(`document.querySelector('.chat-fab').click()`);
    await t.waitFor(`!!document.querySelector('.chat-overlay[data-phase="open"] textarea')`, 8000, 'chat open');
    const visible = await t.ev(`[...document.querySelectorAll('.chat-composer-tools button')].filter(b=>b.offsetParent!==null).length`);
    assert(visible <= 3, `visible tool buttons: ${visible}`);
    await t.ev(`document.querySelector('.chat-ctx-btn').click()`);
    await t.waitFor(`document.querySelectorAll('.chat-ctx-pop .phone-only').length >= 1`, 3000, 'phone items');
    assert((await t.ev(`[...document.querySelectorAll('.chat-ctx-pop .phone-only')].filter(e=>e.offsetParent!==null).length`)) >= 1, 'attach item hidden');
    await sleep(700);
    assert(await t.ev(`(()=>{const r=document.querySelector('.chat-ctx-pop').getBoundingClientRect();return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.height > 60})()`), 'the + menu is not on screen');
    await shot('p6-chat-plus');
    await t.ev(`document.querySelector('.pop-backdrop').click()`);
    await t.viewport(1280, 900, false);
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
