// test/tls-fingerprint.mjs — 实测 quickjsbrowser 出站 TLS 指纹（JA3/JA4）
// 用 CDP 连上，在页面里 fetch 指纹站，把响应原文取回来。
import puppeteer from 'puppeteer-core';
import { ProxyAgent, WebSocket } from 'undici';

const KEY = 'local-test-key';
const HOST = 'quickjsbrowser.berry55.workers.dev';
const sid = 'tlsfp-' + Math.random().toString(36).slice(2, 7);

const agent = new ProxyAgent(process.env.PROXY || 'http://127.0.0.1:7890');
const ws = new WebSocket(`wss://${HOST}/cdp?key=${KEY}&s=${sid}`, { dispatcher: agent });
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', (e) => j(new Error('wss: ' + (e.message || e))), { once: true });
});
const transport = { send: (m) => ws.send(m), close() { try { ws.close(); } catch {} }, onmessage: null, onclose: null };
ws.addEventListener('message', async (ev) => {
  let d = ev.data;
  if (typeof d !== 'string') d = (d?.arrayBuffer ? Buffer.from(await d.arrayBuffer()) : Buffer.from(d)).toString();
  transport.onmessage?.(d);
});
ws.addEventListener('close', () => transport.onclose?.());

const browser = await puppeteer.connect({ transport, defaultViewport: { width: 1280, height: 900 } });
const page = await browser.newPage();
await page.goto('https://example.com', { waitUntil: 'load', timeout: 60000 });
console.log('[0] 会话就绪');

const ENDPOINTS = [
  'https://tls.peet.ws/api/all',
  'https://tls.browserleaks.com/json',
  'https://ja3er.com/json',
];

for (const ep of ENDPOINTS) {
  console.log(`\n########## ${ep} ##########`);
  try {
    const txt = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const t = await r.text();
      return `HTTP ${r.status} | ${t.slice(0, 3000)}`;
    }, ep);
    console.log(txt);
  } catch (e) {
    console.log('失败:', e && e.message ? e.message : e);
  }
}

await browser.close();
