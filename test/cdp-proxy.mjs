// 本地日志代理：puppeteer → ws://localhost:8899 → wrangler ws://localhost:8799
// 双向逐帧打印，定位 Network.enable 超时
import { WebSocketServer } from 'ws';
import { WebSocket } from 'undici';

const UP = 'ws://localhost:8799/cdp?key=local-test-key&s=t5';
const wss = new WebSocketServer({ port: 8899 });
wss.on('connection', (down) => {
  console.log('=== proxy: client connected');
  const up = new WebSocket(UP);
  let upstreamReady = false;
  const queue = [];
  up.addEventListener('open', () => {
    console.log('=== proxy: upstream open');
    upstreamReady = true;
    for (const f of queue.splice(0)) {
      console.log('>>>(queued)', f.slice(0, 400));
      up.send(f);
    }
  });
  up.addEventListener('message', (ev) => {
    console.log('<<<', ev.data.toString().slice(0, 400));
    try { down.send(ev.data.toString()); } catch (e) {}
  });
  up.addEventListener('close', () => { console.log('=== proxy: upstream closed'); try { down.close(); } catch (e) {} });
  up.addEventListener('error', (e) => console.log('=== proxy upstream ERR', e.message || e));
  down.on('message', (d) => {
    const s = d.toString();
    if (!upstreamReady) { queue.push(s); console.log('>>>(buffered)', s.slice(0, 400)); return; }
    console.log('>>>', s.slice(0, 400));
    try { up.send(s); } catch (e) {}
  });
  down.on('close', () => { console.log('=== proxy: client closed'); try { up.close(); } catch (e) {} });
  down.on('error', () => {});
});
console.log('proxy on ws://localhost:8899');
