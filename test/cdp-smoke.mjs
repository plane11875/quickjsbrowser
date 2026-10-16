import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const base = process.env.QJSB_BASE;
const key = process.env.QJSB_KEY;
if (!base || !key) throw new Error('Set QJSB_BASE and QJSB_KEY');
const output = process.env.QJSB_TEST_OUTPUT || '.cache/cdp-smoke';
fs.mkdirSync(output, { recursive: true });
const minimal = fs.readFileSync(new URL('./fixtures/float-inline.html', import.meta.url), 'utf8');
const targets = process.argv.slice(2);
if (!targets.length) targets.push(`data:text/html,${encodeURIComponent(minimal)}`, 'https://example.com', 'https://linux.do/t/topic/3029893');
const reports = [];
for (const target of targets) {
  const sid = `regression-${randomUUID()}`;
  const url = new URL('/cdp', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('key', key);
  url.searchParams.set('s', sid);
  const ws = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    const task = pending.get(frame.id);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(frame.id);
    if (frame.error) task.reject(new Error(frame.error.message));
    else task.resolve(frame.result);
  });
  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 20_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); }, { once: true });
    });
    await send('Page.enable');
    await send('Runtime.enable');
    const started = performance.now();
    const navigation = await send('Page.navigate', { url: target });
    assert.ok(!navigation.errorText, navigation.errorText);
    const navigationMs = performance.now() - started;
    const metadata = await send('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title,text:document.body.textContent.slice(0,200)})', returnByValue: true });
    assert.ok(!metadata.exceptionDetails, JSON.stringify(metadata.exceptionDetails));
    const page = JSON.parse(metadata.result.value);
    const screenshotStarted = performance.now();
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    const screenshotMs = performance.now() - screenshotStarted;
    const png = Buffer.from(screenshot.data, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.length > 1000);
    const logUrl = new URL(`/s/${sid}/log`, base);
    logUrl.searchParams.set('key', key);
    const logs = await (await fetch(logUrl)).json();
    fs.writeFileSync(path.join(output, `${sid}-log.json`), JSON.stringify(logs, null, 2));
    const label = target.startsWith('data:') ? 'inline-float' : new URL(target).hostname;
    const filename = path.join(output, `${label}-${sid}.png`);
    fs.writeFileSync(filename, png);
    const report = { target: target.startsWith('data:') ? 'minimal inline float' : target, sid, navigationMs, screenshotMs, bytes: png.length, title: page.title, screenshot: filename };
    reports.push(report);
    console.log(JSON.stringify({ status: 'PASS', ...report }));
  } finally {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP connection closed')); }
    pending.clear();
    ws.close();
  }
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(reports, null, 2));
