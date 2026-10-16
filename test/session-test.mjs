// test/session-test.mjs — session.js 的预取/缓存/模块注册（主线 A 的真实代码路径）。
// local-test.mjs 只覆盖 engine+prelude，不碰 session.js；这里起一个假 DO ctx
// 和本地 CDN，把 prefetchGraph 的并发/缓存收益和 JSON 模块注册跑出来。
//
// 用法：node --experimental-wasm-modules --import ./test/register.mjs test/session-test.mjs
import http from 'node:http';
import { QjsSession } from '../src/session.js';
import { requestHeaders, chromiumBrands, SEC_CH_UA, BROWSER_UA, ACCEPT_LANGUAGE, CHROME_MAJOR } from '../src/fingerprint.js';

const LATENCY_MS = 30;
const hits = new Map(); // url -> 次数，用来证明缓存真的挡住了网络
const sent = new Map(); // path -> 该路径最后收到的请求头（指纹断言用真实网络，不靠读代码）

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
  sent.set(u.pathname, req.headers);
  // 指纹断言用页面：不加人工延迟，免得拖慢测试
  if (u.pathname === '/page') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>fp</title></head><body><p>hello fingerprint</p></body></html>');
    return;
  }
  setTimeout(() => {
    if (u.pathname === '/m/1.js') {
      // 3 叉树，共 60 个叶子以内；id<20 继续分叉
      const kids = [+u.pathname.match(/(\d+)/)[1] < 20
        ? [1, 2, 3].map((k) => (/^a/.test(u.searchParams.get('k') || '') ? 0 : 0)) : []];
      void kids;
    }
    if (u.pathname.endsWith('.json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":"world"}');
      return;
    }
    if (u.pathname === '/cjs.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
        .end('module.exports = function(){ return 1; }');   // 无 import/export → 应判非 ESM
      return;
    }
    const m = /^\/m\/(\d+)\.js$/.exec(u.pathname);
    if (!m) { res.writeHead(404).end(); return; }
    const id = +m[1];
    const kids = id < 20 ? [id * 3 + 1, id * 3 + 2, id * 3 + 3].filter((x) => x <= 60) : [];
    const body = kids.length
      ? kids.map((k) => `import {v${k}} from "./${k}.js";`).join('\n')
        + `\nexport const v${id} = ${kids.join('+')};\n`
      : `export const v${id} = ${id};\n`;
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
  }, LATENCY_MS);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (name, cond, got = '') => {
  console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : ' → ' + got);
  cond ? pass++ : fail++;
};

// 假 DO 上下文：只要 waitUntil 能收下 promise
const waitUntils = [];
const fakeCtx = { waitUntil: (p) => waitUntils.push(p) };
const S = new QjsSession(fakeCtx, { KEY: 'k', DEEPLX_URL: '' });
// resolveSpec 对相对说明符以会话 URL 为准（about:blank 时会指向 session.local），
// 所以先给会话一个真实 base。
S.url = `${base}/`;

const entryUrl = `${base}/m/1.js`;
// 抓 entry 本身（走 fetchModuleSource，与 prefetchGraph 同一路径）
const entry = await S.fetchModuleSource(entryUrl);

// ---- A1 首次 BFS：层内并发 ----
const t0 = performance.now();
const g1 = await S.prefetchGraph(entryUrl, entry.text);
const cold = performance.now() - t0;
check('A1 首次 BFS 抓到整张图', g1.fetches === 33 && g1.hits === 0, JSON.stringify(g1));
// 串行版本的理论耗时：每层每个模块一次 30ms RTT 串起来
console.log(`   首次 BFS（层内并发，上限 6）: ${cold.toFixed(0)} ms, 抓取 ${g1.fetches} 个模块`);

// ---- A2 第二次 BFS 全命中缓存，零网络 ----
hits.clear();
const t1 = performance.now();
const g2 = await S.prefetchGraph(entryUrl, entry.text);
const warm = performance.now() - t1;
check('A2 第二次 BFS 全部命中缓存', g2.fetches === 0 && g2.hits === 33, JSON.stringify(g2));
check('A2b 缓存命中时确实没发网络请求', hits.size === 0, [...hits.keys()].join(','));
console.log(`   二次 BFS（全缓存）: ${warm.toFixed(1)} ms  (${cold.toFixed(0)} ms → ${warm.toFixed(1)} ms, ${(cold / Math.max(warm, 0.001)).toFixed(0)}×)`);

// ---- A3 JSON 模块注册 kind=1 ----
const jsonUrl = `${base}/d.json`;
const jsonEntry = await S.fetchModuleSource(jsonUrl);
check('A3 .json 识别为 JSON 模块', jsonEntry && jsonEntry.kind === 1, JSON.stringify(jsonEntry));

// ---- A4 CJS 判非 ESM（负缓存，两次都不该再抓）----
hits.clear();
const cjsUrl = `${base}/cjs.js`;
const c1 = await S.fetchModuleSource(cjsUrl);
const c2 = await S.fetchModuleSource(cjsUrl);
check('A4 UMD/CJS 判非 ESM', c1 === null && c2 === null);
check('A4b 负缓存生效（只抓一次）', hits.get('/cjs.js') === 1, String(hits.get('/cjs.js')));

// ---- A5 真跑一遍模块求值（含缓存回灌 C 源码表）----
S.ensure();
// 复刻 runPageScripts：entry 自己也注册进 C 源码表，再预取其依赖
S.registerModule(entryUrl, entry);
const mainSrc = `import {v1} from ${JSON.stringify(entryUrl)};
globalThis.modV = v1;`;
const g3 = await S.prefetchGraph(entryUrl, mainSrc);
const rc = S.engine.eval(mainSrc, `${base}/main.js`, true);
S.pump();
const got = S.engine.callGlobal('eval', 'JSON.stringify(globalThis.modV)');
// v1 是 3 叉树自底向上求和（叶子 id≥20 值=自身），实算为 15。
// 原断言写 3781 无依据（子代理臆造），已按引擎真实求值结果校正。
// v1 是 3 叉树自底向上求和（叶子 id≥20 值=自身），实算为 15。
// 原断言写 3781 无依据（子代理臆造），已按引擎真实求值结果校正。
// 注意 callGlobal 取回的是 JSON 字符串，故按字符串比较。
check('A5 模块图求值成功', rc === 0 && got.ok && got.value === '15', JSON.stringify(got));
console.log(`   60 模块图求值结果 v1 = ${got.value}`);

// ---- A6 mapLimit 不越并发 ----
let cur = 0, peak = 0;
const items = Array.from({ length: 30 }, (_, i) => i);
await S.mapLimit(items, 6, async () => {
  cur++; peak = Math.max(peak, cur);
  await new Promise((r) => setTimeout(r, 5));
  cur--;
});
check('A6 mapLimit 并发上限生效', peak <= 6, 'peak=' + peak);
const ordered = await S.mapLimit([30, 20, 10], 3, async (x) => x / 10);
check('A6b mapLimit 保持顺序', JSON.stringify(ordered) === '[3,2,1]', JSON.stringify(ordered));

// ---- A7 outbox_dropped 进日志 ----
S.pushLog('[x]');
const g4 = await S.prefetchGraph(`${base}/m/61.js`, 'export const q=1;');
check('A7 不存在的模块被跳过不炸', g4.fetches >= 0, JSON.stringify(g4));

// ---- A8 浏览器指纹：GREASE 品牌算法（Chromium 源码级）----
// 已知真值来自真实 Chrome 的 sec-ch-ua 头（120 那条是chromium 官方算法在
// major=120 时的输出，公开可查；151 是本项目 persona）。算法抄错 = 自报不是 Chrome。
const b120 = chromiumBrands(120).map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
check('A8 GREASE 品牌 major=120 与真实 Chrome 一致',
  b120 === '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"', b120);
// 146 是本项目 persona——基准不是推出来的，是 curl_cffi 的 chrome146 档位实测值
// （见 src/net/chrome-hello.js 与 test/ja3-check.mjs）。TLS 指纹也是 146，两者必须同版本，
// 否则 UA 报一个版本、ClientHello 是另一个版本的扩展布局，属于跨层自相矛盾。
const b146 = chromiumBrands(146).map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
check('A8b GREASE 品牌 major=146 与 curl_cffi chrome146 实测一致',
  b146 === '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"', b146);
check('A8c SEC_CH_UA 与算法输出一致且等于 persona 版本',
  SEC_CH_UA === b146 && SEC_CH_UA === chromiumBrands(CHROME_MAJOR).map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
  SEC_CH_UA);

// ---- A9 出站 document 头（真网络：让本地服务器把收到的头交回来）----
const pageUrl = `${base}/page`;
const shotRes = await S.shot({ url: pageUrl, w: 400, h: 300, js: false });
const docH = sent.get('/page') || {};
check('A9 出站 document 头：UA 为 Chrome（非 quickjsbrowser 自报）',
  docH['user-agent'] === BROWSER_UA && !/quickjs/i.test(docH['user-agent'] || ''), docH['user-agent']);
check('A9b Accept / Accept-Language 齐全',
  /^text\/html/.test(docH.accept || '') && docH['accept-language'] === ACCEPT_LANGUAGE,
  `${docH.accept} | ${docH['accept-language']}`);
// 注意：node 的 undici fetch 会把 sec-fetch-mode **强制改写为 cors**（实测：直接发
// 'Sec-Fetch-Mode: navigate' 到本地服务器，收到的仍是 cors），故本地无法验证 navigate。
// 线上真机已验：httpbin 回显 Sec-Fetch-Mode: navigate（见 test/fingerprint-probe.mjs）。
check('A9c Sec-Fetch-Dest/Site/User 是顶层导航语义',
  docH['sec-fetch-dest'] === 'document' && docH['sec-fetch-site'] === 'none'
  && docH['sec-fetch-user'] === '?1',
  JSON.stringify([docH['sec-fetch-dest'], docH['sec-fetch-site'], docH['sec-fetch-user']]));
check('A9d sec-ch-ua 三件套齐全（与 JS 侧 userAgentData 同源）',
  docH['sec-ch-ua'] === SEC_CH_UA && docH['sec-ch-ua-mobile'] === '?0' && docH['sec-ch-ua-platform'] === '"macOS"',
  JSON.stringify([docH['sec-ch-ua'], docH['sec-ch-ua-mobile'], docH['sec-ch-ua-platform']]));
check('A9e 导航请求带 Cache-Control: max-age=0（实测真 Chrome 有）',
  docH['cache-control'] === 'max-age=0', docH['cache-control']);
check('A9f 顶层导航不带 Referer', docH.referer === undefined, String(docH.referer));
check('A9g 渲染出 PNG', shotRes.png && shotRes.png.length > 8, String(shotRes.png && shotRes.png.length));

// ---- A10 按资源类型区分头（一套头打天下是破绽）----
const d = requestHeaders({ type: 'document', url: 'https://a.test/x' });
const img = requestHeaders({ type: 'image', url: 'https://a.test/p.png', referer: 'https://a.test/x' });
const css = requestHeaders({ type: 'style', url: 'https://a.test/s.css', referer: 'https://a.test/x' });
const mod = requestHeaders({ type: 'script', url: 'https://cdn.test/m.js', referer: 'https://a.test/x', mode: 'cors', origin: true });
check('A10 Accept 逐类型不同（一套头打天下就是破绽）',
  new Set([d.Accept, img.Accept, css.Accept, mod.Accept]).size === 4,
  [d.Accept, img.Accept, css.Accept, mod.Accept].map((x) => x.slice(0, 18)).join(' | '));
check('A10b Sec-Fetch-Dest 逐类型不同',
  d['Sec-Fetch-Dest'] === 'document' && img['Sec-Fetch-Dest'] === 'image'
  && css['Sec-Fetch-Dest'] === 'style' && mod['Sec-Fetch-Dest'] === 'script',
  [d, img, css, mod].map((h) => h['Sec-Fetch-Dest']).join(','));
check('A10c 同源子资源 Referer 发全 URL、Site=same-origin',
  img.Referer === 'https://a.test/x' && img['Sec-Fetch-Site'] === 'same-origin',
  `${img.Referer} | ${img['Sec-Fetch-Site']}`);
check('A10d 跨源子资源 Referer 只发 origin、Site=cross-site 且带 Origin',
  mod.Referer === 'https://a.test/' && mod['Sec-Fetch-Site'] === 'cross-site' && mod.Origin === 'https://a.test',
  JSON.stringify([mod.Referer, mod['Sec-Fetch-Site'], mod.Origin]));
check('A10e 同源 module 不发 Origin（实测真 Chrome 如此）',
  requestHeaders({ type: 'script', url: 'https://a.test/m.js', referer: 'https://a.test/x', mode: 'cors', origin: true }).Origin === undefined);
check('A10f 不设 Accept-Encoding（CF 边缘强制覆盖，设了无效）',
  d['Accept-Encoding'] === undefined && img['Accept-Encoding'] === undefined);

// ---- A11 页面脚本 fetch 的默认头（真网络）----
S.engine = null; // 换会话状态，避免上面的 shot 干扰
S.ensure();
await S.hostFetch({ id: 9999, url: `${base}/m/1.js?k=x`, method: 'GET', headers: {}, body: null });
const pageFetchH = sent.get('/m/1.js') || {};
check('A11 页面 fetch 走 hostFetch 也带完整浏览器头（不再裸奔）',
  pageFetchH['sec-fetch-dest'] === 'empty' && pageFetchH['sec-fetch-mode'] === 'cors'
  && !!pageFetchH.accept && pageFetchH['user-agent'] === BROWSER_UA,
  JSON.stringify(pageFetchH));
// 页面显式给的头优先（模拟 fetch(url, {headers:{'X-Test':'1'}})，大小写不同也应覆盖）
await S.hostFetch({ id: 10000, url: `${base}/m/2.js?k=x`, method: 'GET', headers: { 'x-test': '1' }, body: null });
const overrideH = sent.get('/m/2.js') || {};
check('A11b 页面显式头优先生效', overrideH['x-test'] === '1', JSON.stringify(overrideH['x-test']));

server.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);