// index.js — Worker 路由：全路由 ?key= 鉴权，会话按名字路由到 QjsSession DO。
// API（v2 = v1 + 标准 CDP 面）：
//   GET  /health                        引擎冒烟（new + eval 1+1 + free）
//   POST /s/:sid/eval   {code,url?,type?}   跑脚本/模块（module 自动预取 import 图）
//   POST /s/:sid/modules {sources:[{url,src}]}  手工预填模块源码表
//   GET  /s/:sid/state                  {url,storage,cookie,live}
//   GET  /s/:sid/log                    console/exception/任务日志
//   POST /s/:sid/reset
// CDP（Chrome DevTools Protocol，未经修改的 puppeteer-core / chrome-remote-interface 直连）：
//   GET  /json/version                  发现面（puppeteer browserURL 模式）
//   GET  /json/list | /json             target 列表（单 page target）
//   GET  /json/new?url=                 新建 target（复用单页面语义）
//   WSS  /cdp?key=&s=:sid               WS 升级 → DO（CDP JSON 帧，一 DO 会话 = 一 page target）

import { QjsSession } from './session.js';
import { BROWSER_UA, CHROME_FULL, CHROME_MAJOR } from './fingerprint.js';

export { QjsSession };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (!env.KEY || key !== env.KEY) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    if (url.pathname === '/health') return health();

    // ---- CDP 发现面（wss 地址带 key，方便 puppeteer browserURL 模式直用） ----
    if (url.pathname === '/json/version') {
      return Response.json({
        Browser: `Chrome/${CHROME_FULL}`,
        'Protocol-Version': '1.3',
        // 与 session.js 的出站头、prelude.js 的 navigator 同源（fingerprint.js）
        'User-Agent': BROWSER_UA,
        'V8-Version': `${CHROME_MAJOR / 10}.0`,
        'WebKit-Version': '537.36 (@1f2c9e4a7b3d5c8e0a6f4b2d9c7e5a3f1b8d6c40)',
        webSocketDebuggerUrl: cdpWsUrl(url, key),
      });
    }
    if (url.pathname === '/json/list' || url.pathname === '/json') {
      return Response.json([pageTarget(url, key)]);
    }
    if (url.pathname === '/json/new' || url.pathname === '/json/activate' || url.pathname === '/json/close') {
      // 单 DO = 单 page target：new/close/activate 都落到同一默认 target
      return Response.json(pageTarget(url, key));
    }

    // ---- CDP WebSocket 升级：转发进 DO（?s=<会话名> 选 DO 实例） ----
    if (url.pathname === '/cdp') {
      const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
      if (upgrade !== 'websocket') {
        return Response.json({ error: 'expected Upgrade: websocket' }, { status: 426 });
      }
      const sid = url.searchParams.get('s') || 'cdp';
      const stub = env.QJS.get(env.QJS.idFromName(sid));
      // 透传原请求（Upgrade 头必须保留）；DO 内 accept WebSocketPair
      return stub.fetch(new Request('https://do.local/cdp'+url.search, request));
    }

    const m = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return Response.json({ error: 'no route' }, { status: 404 });
    const sid = m[1];
    const stub = env.QJS.get(env.QJS.idFromName(sid));
    // 必须透传原请求（method/headers/body）；裸 URL 会变成 GET
    return stub.fetch(new Request(`https://do.local/s/${sid}${m[2] || '/'}`, request));
  },
};

function cdpWsUrl(url, key) {
  const q=new URLSearchParams({key,s:url.searchParams.get('s')||'default'});
  for(const name of ['proxy','proxy_ip','proxy_port'])if(url.searchParams.has(name))q.set(name,url.searchParams.get(name));
  return `wss://${url.host}/cdp?${q}`;
}

function pageTarget(url, key) {
  const ws = cdpWsUrl(url, key);
  return {
    id: 'page-1',
    type: 'page',
    description: '',
    title: '',
    url: 'about:blank',
    devtoolsFrontendUrl: '',
    faviconUrl: '',
    webSocketDebuggerUrl: ws,
  };
}

async function health() {
  try {
    const { QjsEngine } = await import('./engine.js');
    const e = new QjsEngine();
    const rc = e.eval('1 + 41', 'health.js', false);
    const r = e.callGlobal('eval', '1 + 41');
    const tasks = e.takeTasks();
    e.dispose();
    return Response.json({
      ok: rc === 0 && r.value === 42,
      exceptions: tasks.filter((t) => t.kind === 'exception'),
    });
  } catch (err) {
    return Response.json({ ok: false, error: String((err && err.message) || err) }, { status: 500 });
  }
}
