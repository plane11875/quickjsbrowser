// test/fingerprint-probe.mjs — 指纹插桩测量（对线上 Worker 真机跑，禁用 wrangler dev）。
// 量三件事：
//   1) 各目标站的出站结果（HTTP 状态 / 是否拿到页面）——指纹改动的效果指标
//   2) 出站请求实际带上了哪些头（在 CF 边缘真实发出的，不是本地推测）——用 httpbin 回显
//   3) VM 内 navigator/screen 的可见指纹面 —— 用 /eval 直接读
// 用法：node test/fingerprint-probe.mjs [--sid=名字]
import { ProxyAgent, fetch } from 'undici';

const KEY = 'local-test-key';
const BASE = 'https://quickjsbrowser.berry55.workers.dev';
const agent = new ProxyAgent(process.env.PROXY || 'http://127.0.0.1:7890');
const sidArg = process.argv.find((a) => a.startsWith('--sid='));
// 默认每次新会话名：DO 会话缓存旧的代码，换名字才是新代码的真实行为
const SID = sidArg ? sidArg.slice(6) : 'fp-' + Date.now().toString(36);

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    dispatcher: agent,
  });
  return r;
};

console.log(`sid = ${SID}\n`);

// ---- 1. 目标站出站结果 ----
const TARGETS = [
  'https://linux.do/t/topic/3029893',
  'https://news.ycombinator.com',
];
console.log('== 1. 目标站（/shot，读 x-final-url / x-html-bytes；失败看 error） ==');
for (const url of TARGETS) {
  const sid = `${SID}-t${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  try {
    const r = await post(`/s/${sid}/shot`, { url, w: 1280, h: 900, js: false });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('image/png')) {
      const b = new Uint8Array(await r.arrayBuffer());
      console.log(`  ${url}\n    → HTTP ${r.status} PNG ${b.length}B, final=${r.headers.get('x-final-url')}, html=${r.headers.get('x-html-bytes')}B, ${Date.now() - t0}ms`);
    } else {
      console.log(`  ${url}\n    → HTTP ${r.status} ${(await r.text()).slice(0, 300)} (${Date.now() - t0}ms)`);
    }
  } catch (e) {
    console.log(`  ${url}\n    → 本地异常 ${e.message}`);
  }
}

// ---- 2. 出站真实请求头（httpbin 回显） ----
console.log('\n== 2. 出站请求头（httpbin.org/headers 回显） ==');
const evalSession = `${SID}-hdr`;
const runEval = async (code) => (await post(`/s/${evalSession}/eval`, { code })).json();
const echoOnce = async (label, url) => {
  await runEval(`globalThis.__probe='pending';globalThis.__probeErr=null;
fetch(${JSON.stringify(url)}).then(r=>r.text()).then(t=>{globalThis.__probe=t}).catch(e=>{globalThis.__probeErr=String(e&&e.message||e)});`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await runEval('globalThis.__probe');
    if (s.value === 'pending') continue;
    if (s.value) {
      try { console.log(`  [${label}]`, JSON.stringify(JSON.parse(s.value).headers)); }
      catch { console.log(`  [${label}] raw:`, String(s.value).slice(0, 400)); }
    } else {
      const e = await runEval('globalThis.__probeErr');
      console.log(`  [${label}] 失败: ${e.value}`);
    }
    return;
  }
  console.log(`  [${label}] 超时`);
};
await echoOnce('脚本内 fetch', 'https://httpbin.org/headers');
for (const url of TARGETS) await echoOnce(`目标站预检 ${url}`, url);

// ---- 3. VM 内可见指纹面 ----
console.log('\n== 3. VM 可见指纹（navigator/screen/window.chrome/Intl） ==');
const fpSession = `${SID}-fp`;
const probe = `(() => {
  const n = navigator, w = globalThis, s = typeof screen !== 'undefined' ? screen : null;
  const g = (fn, d) => { try { return fn(); } catch (e) { return 'ERR:' + (e && e.message || e); } };
  return JSON.stringify({
    ua: n.userAgent, appVersion: n.appVersion, vendor: n.vendor, vendorSub: n.vendorSub,
    product: n.product, productSub: n.productSub, platform: n.platform,
    appCodeName: n.appCodeName, appName: n.appName, javaEnabled: typeof n.javaEnabled,
    language: n.language, languages: n.languages,
    hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory,
    maxTouchPoints: n.maxTouchPoints, cookieEnabled: n.cookieEnabled, onLine: n.onLine,
    webdriver: n.webdriver, pdfViewerEnabled: n.pdfViewerEnabled,
    plugins: g(() => Array.from(n.plugins || []).map(p => p.name + '|' + p.filename + '|' + Array.from(p).map(m => m.type).join(','))),
    pluginsLen: g(() => (n.plugins || {}).length),
    mimeTypes: g(() => Array.from(n.mimeTypes || []).map(m => m.type + '|' + m.suffixes)),
    uaData: g(() => n.userAgentData && { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform, hasGHEV: typeof n.userAgentData.getHighEntropyValues }),
    connection: g(() => n.connection && { type: n.connection.type, effectiveType: n.connection.effectiveType, rtt: n.connection.rtt, downlink: n.connection.downlink, saveData: n.connection.saveData }),
    permissions: g(() => typeof (n.permissions || {}).query),
    storage: g(() => typeof (n.storage || {}).estimate),
    sendBeacon: typeof n.sendBeacon, getGamepads: typeof n.getGamepads,
    chrome: g(() => typeof w.chrome === 'object' ? Object.keys(w.chrome) : typeof w.chrome),
    screen: g(() => s && { w: s.width, h: s.height, aw: s.availWidth, ah: s.availHeight, cd: s.colorDepth, pd: s.pixelDepth }),
    dpr: w.devicePixelRatio, inner: [w.innerWidth, w.innerHeight], outer: [w.outerWidth, w.outerHeight],
    scroll: [w.scrollX, w.scrollY],
    timeZone: g(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    tzOffset: new Date().getTimezoneOffset(),
    intlLocale: g(() => Intl.DateTimeFormat().resolvedOptions().locale),
    fnToString: g(() => Function.prototype.toString.call(w.fetch)),
    navigatorProtoCount: g(() => Object.getOwnPropertyNames(Object.getPrototypeOf(n)).length),
  });
})()`;
const r3 = await post(`/s/${fpSession}/eval`, { code: probe });
const j3 = await r3.json();
let fp = null;
try {
  fp = JSON.parse(j3.value);
  for (const [k, v] of Object.entries(fp)) console.log(`  ${k.padEnd(18)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
} catch {
  console.log('  eval 失败:', JSON.stringify(j3).slice(0, 600));
}

console.log(`\nsid(供复查 session 用) = ${SID}`);
