// 验收 B（部署端 wss）：undici ProxyAgent 走 7890 代理连公网 wss，标准 CDP JSON 帧
// navigate → loadEventFired → evaluate → captureScreenshot（PNG 魔数校验）
import { ProxyAgent, fetch as ufetch, WebSocket } from 'undici';

const BASE = 'https://quickjsbrowser.berry55.workers.dev';
const KEY = 'local-test-key';
const SID = process.env.CDP_SID || 'cdp-rem2';
const agent = new ProxyAgent('http://127.0.0.1:7890');

const ver = await (await ufetch(`${BASE}/json/version?key=${KEY}&s=${SID}`, { dispatcher: agent })).json();
console.log('[1] /json/version:', ver.Browser, '| ws =', ver.webSocketDebuggerUrl.slice(0, 60) + '...');

const ws = new WebSocket(`${BASE}/cdp?key=${KEY}&s=${SID}`, { dispatcher: agent });
let id = 0;
const pending = new Map();
const events = [];
const send = (method, params = {}, sid) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    const f = { id: i, method, params };
    if (sid) f.sessionId = sid;
    ws.send(JSON.stringify(f));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(method + ' timeout')); } }, 60000);
  });

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data.toString());
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method) {
    events.push(m.method);
  }
});
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', (e) => j(new Error('wss 连接失败: ' + (e.message || e))), { once: true });
});
console.log('[2] wss handshake ok');

// puppeteer 式 flatten 握手（带 sessionId 复用）
await send('Target.getBrowserContexts');
await send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
await send('Target.setAutoAttach', { waitForDebuggerOnStart: true, flatten: true, autoAttach: true, filter: [{ type: 'page', exclude: true }, {}] });
console.log('[3] events so far:', events.join(', '));
const sid = 's-page-1'; // attachedToTarget 里服务端给的 sessionId
await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
console.log('[4] session commands ok');

await send('Page.navigate', { url: 'https://example.com' }, sid);
const deadline = Date.now() + 60000;
while (!events.includes('Page.loadEventFired') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
console.log('[5] navigate done, loadEventFired =', events.includes('Page.loadEventFired'));

const t = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sid);
console.log('[6] evaluate document.title =', JSON.stringify(t.result?.value));

const n = await send('Runtime.evaluate', { expression: 'document.querySelectorAll("a").length', returnByValue: true }, sid);
console.log('[7] <a> count =', n.result?.value);

const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
const buf = Buffer.from(shot.data, 'base64');
console.log('[8] captureScreenshot bytes =', buf.length, 'magic =', buf.subarray(0, 8).toString('hex'), '(\\x89PNG = 89504e470d0a1a0a)');
console.log('REMOTE-TITLE-PASS =', t.result?.value === 'Example Domain');
console.log('REMOTE-PNG-PASS =', buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
ws.close();
await agent.close();
