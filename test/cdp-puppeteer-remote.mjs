// 验收 B（部署端）：puppeteer-core + 自定义 transport（undici ProxyAgent 经 7890 连公网 wss）
import puppeteer from 'puppeteer-core';
import { ProxyAgent, WebSocket } from 'undici';

const sid = process.env.CDP_SID || 'cdp-rem-pptr3';
const url = `wss://quickjsbrowser.berry55.workers.dev/cdp?key=local-test-key&s=${sid}`;
const agent = new ProxyAgent('http://127.0.0.1:7890');
const ws = new WebSocket(url, { dispatcher: agent });
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', (e) => j(new Error('wss failed: ' + (e.message || e))), { once: true });
});
console.log('[0] wss open (via proxy)');
const transport = {
  send(m) { ws.send(m); },
  close() { try { ws.close(); } catch (e) {} },
  onmessage: null,
  onclose: null,
};
ws.addEventListener('message', async (ev) => {
  let d = ev.data;
  if (typeof d !== 'string' && d && typeof d.arrayBuffer === 'function') d = Buffer.from(await d.arrayBuffer()).toString();
  else if (typeof d !== 'string') d = Buffer.from(d).toString();
  if (process.env.DBG) console.log('[frame]', typeof ev.data, String(d).slice(0, 120));
  transport.onmessage?.(d);
});
ws.addEventListener('close', () => { transport.onclose?.(); });

const browser = await puppeteer.connect({ transport, defaultViewport: { width: 1280, height: 900 } });
console.log('[1] connect ok');
try {
  const page = await browser.newPage();
  console.log('[2] newPage ok');
  await page.goto('https://example.com', { waitUntil: 'load', timeout: 90000 });
  console.log('[3] goto ok, url =', page.url());
  const title = await page.evaluate(() => document.title);
  console.log('[4] evaluate document.title =', JSON.stringify(title));
  const shot = await page.screenshot({ type: 'png' });
  console.log('[5] screenshot bytes =', shot.length, 'magic =', Buffer.from(shot).subarray(0, 8).toString('hex'));
  console.log('REMOTE-PPTR-PASS =', title === 'Example Domain');
} finally { await browser.close(); }
