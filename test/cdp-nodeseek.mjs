// test/cdp-nodeseek.mjs — CDP 真机测试：连线上 quickjsbrowser，用 puppeteer 访问 nodeseek.com
// 用法：node test/cdp-nodeseek.mjs [url]
import puppeteer from 'puppeteer-core';
import { ProxyAgent, WebSocket } from 'undici';

const TARGET = process.argv[2] || 'https://www.nodeseek.com/';
const KEY = 'local-test-key';
const sid = 'nodeseek-' + Math.random().toString(36).slice(2, 8);
const url = `wss://quickjsbrowser.berry55.workers.dev/cdp?key=${KEY}&s=${sid}`;

console.log(`[0] 连 ${url}`);
const agent = new ProxyAgent(process.env.PROXY || 'http://127.0.0.1:7890');
const ws = new WebSocket(url, { dispatcher: agent });
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', (e) => j(new Error('wss 失败: ' + (e.message || e))), { once: true });
});
console.log('[1] wss 已连接');

const transport = {
  send: (m) => ws.send(m),
  close() { try { ws.close(); } catch {} },
  onmessage: null, onclose: null,
};
ws.addEventListener('message', async (ev) => {
  let d = ev.data;
  if (typeof d !== 'string') {
    d = (d && typeof d.arrayBuffer === 'function') ? Buffer.from(await d.arrayBuffer()).toString() : Buffer.from(d).toString();
  }
  transport.onmessage?.(d);
});
ws.addEventListener('close', () => transport.onclose?.());

const browser = await puppeteer.connect({ transport, defaultViewport: { width: 1280, height: 900 } });
console.log('[2] puppeteer 已连');

try {
  const page = await browser.newPage();
  console.log('[3] newPage ok');

  const t0 = Date.now();
  await page.goto(TARGET, { waitUntil: 'load', timeout: 60000 });
  console.log(`[4] goto ok ${Date.now() - t0}ms, url = ${page.url()}`);

  const title = await page.evaluate(() => document.title);
  const bodyLen = await page.evaluate(() => (document.body && document.body.innerText || '').length);
  const htmlLen = await page.evaluate(() => (document.documentElement.outerHTML || '').length);
  const links = await page.evaluate(() => document.querySelectorAll('a').length);
  console.log(`[5] title   = ${JSON.stringify(title)}`);
  console.log(`[6] innerText 长度 = ${bodyLen} 字符`);
  console.log(`[7] outerHTML 长度 = ${htmlLen} 字符`);
  console.log(`[8] <a> 数量 = ${links}`);

  const snippet = await page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 200));
  console.log(`[9] 正文前 200 字:\n${snippet}`);

  const t1 = Date.now();
  const shot = await page.screenshot({ type: 'png' });
  console.log(`[10] screenshot ${Date.now() - t1}ms, ${shot.length}B, magic=${Buffer.from(shot).subarray(0, 8).toString('hex')}`);
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/nodeseek-cdp.png', Buffer.from(shot));
  console.log('[11] 已存 /tmp/nodeseek-cdp.png');

  console.log('\nCDP-NODESEEK-PASS');
} catch (e) {
  console.log('\nCDP-NODESEEK-FAIL: ' + (e && e.message ? e.message : e));
} finally {
  await browser.close();
}
