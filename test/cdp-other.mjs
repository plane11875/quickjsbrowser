// test/cdp-other.mjs — 连 paperfold-core-test（用户另一个实现，boa engine），测它能否访问 HN
import puppeteer from 'puppeteer-core';
import { ProxyAgent, WebSocket } from 'undici';

const url = process.env.OTHER_WS || 'wss://paperfold-core-test.berry55.workers.dev/cdp?s=main';
const target = process.argv[2] || 'https://news.ycombinator.com';

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
console.log('[2] puppeteer 已连, 版本 =', await browser.version());

try {
  const page = await browser.newPage();
  console.log('[3] newPage ok');
  const t0 = Date.now();
  await page.goto(target, { waitUntil: 'load', timeout: 60000 });
  console.log(`[4] goto ${Date.now() - t0}ms -> ${page.url()}`);
  console.log('[5] title =', JSON.stringify(await page.evaluate(() => document.title)));
  console.log('[6] innerText 长度 =', await page.evaluate(() => (document.body?.innerText || '').length));
  console.log('[7] 前 150 字:', (await page.evaluate(() => (document.body?.innerText || '').slice(0, 150).replace(/\n+/g, ' '))));
  const shot = await page.screenshot({ type: 'png' });
  console.log('[8] screenshot', shot.length, 'B', Buffer.from(shot).subarray(0, 8).toString('hex'));
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/other-target.png', Buffer.from(shot));
  console.log('\nOTHER-PASS');
} catch (e) {
  console.log('\nOTHER-FAIL:', e && e.message ? e.message : e);
} finally {
  await browser.close();
}
