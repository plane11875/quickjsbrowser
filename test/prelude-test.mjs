// test/prelude-test.mjs — prelude 宿主面补齐项（URL / TextEncoder / AbortController …）
// 这些都是页面脚本"直接用、用不到就 ReferenceError"的全局，补齐后才有浏览器味。
import fs from 'node:fs';
import { PRELUDE } from '../src/prelude.js';
import { SEC_CH_UA, BROWSER_UA, LANGUAGES, ACCEPT_LANGUAGE, CH_PLATFORM, DEVICE_MEMORY } from '../src/fingerprint.js';

const ROOT = new URL('..', import.meta.url).pathname;
const mod = new WebAssembly.Module(fs.readFileSync(ROOT + 'src/engine.wasm'));
const TE = new TextEncoder(), TD = new TextDecoder();
let mem;
const wasi = {
  clock_time_get: (_i, _p, o) => { new DataView(mem.buffer).setBigUint64(o, BigInt(Date.now()) * 1000000n, true); return 0; },
  fd_write: (_f, _i, _n, o) => { new DataView(mem.buffer).setUint32(o, 0, true); return 0; },
  fd_close: () => 0, fd_seek: () => 29,
  fd_read: () => 8, fd_fdstat_get: () => 8, fd_fdstat_set_flags: () => 8,
  fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8,
  path_open: () => 8, path_readlink: () => 8,
  environ_sizes_get: (c, s) => { const d = new DataView(mem.buffer); d.setUint32(c, 0, true); d.setUint32(s, 0, true); return 0; },
  environ_get: (e, b) => { const d = new DataView(mem.buffer); d.setUint32(e, 0, true); d.setUint32(b, 0, true); return 0; },
  proc_exit: (c) => { throw new Error('proc_exit ' + c); },
};
const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi, browser:{layout:()=>-1} });
mem = inst.exports.memory;
inst.exports._initialize();
const E = inst.exports;
E.qjs_new();
E.qjs_set_limits(128 * 1024 * 1024, 512 * 1024, 3000);
E.qjs_enable_interrupt();
const ev = (name, code) => {
  const nb = TE.encode(name), cb = TE.encode(code);
  const a = new Uint8Array(nb.length + cb.length);
  a.set(nb); a.set(cb, nb.length);
  const p = E.qjs_alloc(a.length);
  new Uint8Array(mem.buffer, p, a.length).set(a);
  return E.qjs_eval(a.length, 0, nb.length);
};
const callG = (name, args) => {
  const ob = TE.encode(name), ab = TE.encode(args);
  const al = new Uint8Array(4 + ob.length + ab.length);
  new DataView(al.buffer).setUint32(0, ob.length, true);
  al.set(ob, 4); al.set(ab, 4 + ob.length);
  const p = E.qjs_alloc(al.length);
  new Uint8Array(mem.buffer, p, al.length).set(al);
  const r = E.qjs_call_global(al.length);
  return JSON.parse(TD.decode(new Uint8Array(mem.buffer, Number(r & 0xffffffffn), Number(r >> 32n))));
};
if (ev('prelude.js', PRELUDE) !== 0) throw new Error('prelude eval failed: ' + TD.decode(new Uint8Array(mem.buffer, Number(E.qjs_take_tasks() & 0xffffffffn), Number(E.qjs_take_tasks() >> 32n))));

const log = [];
const timers = new Map();
let fetches = [];
let randPool = Array.from(crypto.getRandomValues(new Uint8Array(65536)), (c) => String.fromCharCode(c)).join('');
function pump() {
  for (let round = 0; round < 16; round++) {
    while (E.qjs_job_pending()) E.qjs_exec_job();
    const r = E.qjs_take_tasks();
    const tasks = JSON.parse(TD.decode(new Uint8Array(mem.buffer, Number(r & 0xffffffffn), Number(r >> 32n))));
    if (!tasks.length) break;
    for (const t of tasks) {
      if (t.kind === 'console') log.push(`[${t.payload.level}] ${t.payload.text}`);
      else if (t.kind === 'timer') timers.set(t.payload.id, t.payload);
      else if (t.kind === 'fetch') fetches.push(t.payload);
      else if (t.kind === 'need_random') {
        randPool += Array.from(crypto.getRandomValues(new Uint8Array(t.payload.bytes || 4096)), (c) => String.fromCharCode(c)).join('');
      }
    }
  }
  while (E.qjs_job_pending()) E.qjs_exec_job();
}
const dispatch = (o) => callG('__dispatch', JSON.stringify(o));

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : ' → got: ' + got);
  cond ? pass++ : fail++;
};
const val = (expr) => { const r = callG('eval', expr); return r.ok ? r.value : 'ERR:' + JSON.stringify(r.error); };
const j = (expr) => { const v = val('JSON.stringify(' + expr + ')'); return v === undefined ? 'undefined' : v; };

// P1 URL
ev('p1.js', 'globalThis.u = new URL("https://ex.test:8443/a/b/c?q=1&r=2#frag");');
check('P1 URL 基础字段', j('[u.protocol,u.host,u.hostname,u.port,u.pathname,u.search,u.hash,u.origin]')
  === '["https:","ex.test:8443","ex.test","8443","/a/b/c","?q=1&r=2","#frag","https://ex.test:8443"]',
  j('[u.protocol,u.host,u.hostname,u.port,u.pathname,u.search,u.hash,u.origin]'));
ev('p1b.js', 'globalThis.u2 = new URL("../d/e", "https://ex.test/a/b/c?x=1");');
check('P1b 相对路径解析', val('u2.href') === 'https://ex.test/a/d/e', val('u2.href'));
check('P1c 默认端口被抹掉', j('new URL("https://ex.test:443/x").port') === '""', j('new URL("https://ex.test:443/x").port'));
check('P1d searchParams.get', val('new URL("https://e.test/?a=1&a=2&b=3").searchParams.getAll("a").join(",")') === '1,2',
  val('new URL("https://e.test/?a=1&a=2&b=3").searchParams.getAll("a").join(",")'));
check('P1e URL.canParse', j('[URL.canParse("https://a.test/"),URL.canParse("::::"),URL.canParse("/x","https://b.test/")]')
  === '[true,false,true]', j('[URL.canParse("https://a.test/"),URL.canParse("::::"),URL.canParse("/x","https://b.test/")]'));
check('P1f 非法 URL 抛 TypeError', val('(()=>{try{new URL("::::")}catch(e){return e instanceof TypeError}})()') === true,
  val('(()=>{try{new URL("::::")}catch(e){return e.constructor.name}})()'));

// P2 URLSearchParams
ev('p2.js', `
globalThis.sp = new URLSearchParams("a=1&b=hello%20world&a=3");
globalThis.sp.append("c", "x y");
globalThis.sp.set("a", "9");
`);
check('P2 URLSearchParams get/set', j('sp.get("a")') === '"9"', j('sp.get("a")'));
check('P2b 百分号编码还原', j('sp.get("b")') === '"hello world"', j('sp.get("b")'));
check('P2c 空格编码为 +', j('sp.toString()') === '"a=9&b=hello+world&c=x+y"', j('sp.toString()'));
check('P2d 可迭代', j('[...new URLSearchParams("x=1&y=2")]') === '[["x","1"],["y","2"]]',
  j('[...new URLSearchParams("x=1&y=2")]'));
check('P2e from object', j('new URLSearchParams({k:"v",n:2}).get("n")') === '"2"',
  j('new URLSearchParams({k:"v",n:2}).get("n")'));
check('P2f delete/has/size', j('(()=>{const p=new URLSearchParams("a=1&b=2");p.delete("a");return [p.has("a"),p.size,p.toString()]})()')
  === '[false,1,"b=2"]', j('(()=>{const p=new URLSearchParams("a=1&b=2");p.delete("a");return [p.has("a"),p.size,p.toString()]})()'));

// P3 TextEncoder / TextDecoder（含代理对）
ev('p3.js', 'globalThis.te = new TextEncoder(); globalThis.td = new TextDecoder();');
check('P3 TextEncoder UTF-8 字节数', j('te.encode("héllo").length') === '6', j('te.encode("héllo").length'));
check('P3b 多字节往返', val('td.decode(te.encode("你好，世界 🌍"))') === '你好，世界 🌍',
  val('td.decode(te.encode("你好，世界 🌍"))'));
check('P3c 代理对（emoji）往返', val('td.decode(te.encode("🌍"))') === '🌍', val('td.decode(te.encode("🌍"))'));
check('P3d encodeInto', j('(()=>{const d=new Uint8Array(4);const r=te.encodeInto("abcdef",d);return [r.written,d.length]})()') === '[4,4]',
  j('(()=>{const d=new Uint8Array(4);const r=te.encodeInto("abcdef",d);return [r.written,d.length]})()'));
check('P3e 0..255 全字节往返', j('(()=>{let s="";for(let i=0;i<256;i++)s+=String.fromCharCode(i);return td.decode(te.encode(s))===s})()') === 'true',
  j('(()=>{let s="";for(let i=0;i<256;i++)s+=String.fromCharCode(i);return td.decode(te.encode(s))===s})()'));

// P4 AbortController / AbortSignal + fetch 联动
ev('p4.js', 'globalThis.ac = new AbortController(); globalThis.abortFired = 0; ac.signal.addEventListener("abort", () => globalThis.abortFired++);');
ev('p4b.js', 'globalThis.fp = fetch("https://x.test/slow", { signal: ac.signal }).then(()=>globalThis.fr="ok", e=>globalThis.fr="rejected");');
pump();
ev('p4c.js', 'ac.abort();');
pump();
check('P4 abort 事件触发', val('globalThis.abortFired') === 1, String(val('globalThis.abortFired')));
check('P4b 未落地 fetch 被 abort 拒绝', val('globalThis.fr') === 'rejected', String(val('globalThis.fr')));
check('P4c signal.aborted', val('ac.signal.aborted') === true, String(val('ac.signal.aborted')));
ev('p4d.js', 'globalThis.pre = "pending"; fetch("https://x.test/y", { signal: AbortSignal.abort() }).then(()=>globalThis.pre="resolved", e=>globalThis.pre="rejected:"+e.constructor.name);');
pump();
check('P4d 已 abort 的 signal 立即拒绝', val('globalThis.pre') === 'rejected:Error', String(val('globalThis.pre')));

// P5 queueMicrotask / matchMedia / getComputedStyle / 观测器
ev('p5.js', 'globalThis.qm=[]; queueMicrotask(()=>qm.push("a")); queueMicrotask(()=>qm.push("b"));');
check('P5 queueMicrotask', j('globalThis.qm') === '["a","b"]', j('globalThis.qm'));
check('P5b matchMedia 不抛且有 matches', j('matchMedia("(prefers-color-scheme: dark)").matches') === 'true',
  j('matchMedia("(prefers-color-scheme: dark)").matches'));
check('P5c getComputedStyle 可调用', j('(()=>{const el={style:{color:"red"}};const cs=getComputedStyle(el);return [cs.getPropertyValue("color"),cs.color]})()') === '["red","red"]',
  j('(()=>{const el={style:{color:"red"}};const cs=getComputedStyle(el);return [cs.getPropertyValue("color"),cs.color]})()'));
check('P5d 观测器类齐备', j('["IntersectionObserver","ResizeObserver","PerformanceObserver","structuredClone"].every(n=>typeof globalThis[n]==="function")') === 'true',
  j('["IntersectionObserver","ResizeObserver","PerformanceObserver","structuredClone"].filter(n=>typeof globalThis[n]!=="function")'));
check('P5e performance.now 单调', j('(()=>{const a=performance.now();let b=0;for(let i=0;i<1e6;i++)b+=i;const c=performance.now();return c>=a})()') === 'true');

// P6 事件子类
check('P6 MouseEvent/KeyboardEvent/PopStateEvent 齐备',
  j('["UIEvent","MouseEvent","PointerEvent","WheelEvent","KeyboardEvent","InputEvent","FocusEvent","TouchEvent","DragEvent","ClipboardEvent","ErrorEvent","PopStateEvent","HashChangeEvent","MessageEvent"].filter(n=>typeof globalThis[n]!=="function")') === '[]',
  j('["UIEvent","MouseEvent","PointerEvent","WheelEvent","KeyboardEvent","InputEvent","FocusEvent","TouchEvent","DragEvent","ClipboardEvent","ErrorEvent","PopStateEvent","HashChangeEvent","MessageEvent"].filter(n=>typeof globalThis[n]!=="function")'));
ev('p6.js', 'globalThis.me = new MouseEvent("click", { clientX: 5, button: 2, ctrlKey: true }); globalThis.pe = new PopStateEvent("popstate", { state: { n: 1 } });');
check('P6b MouseEvent 字段', j('[me.type, me.clientX, me.button, me.ctrlKey, me instanceof Event]') === '["click",5,2,true,true]',
  j('[me.type, me.clientX, me.button, me.ctrlKey, me instanceof Event]'));
check('P6c PopStateEvent.state', j('pe.state.n') === '1', j('pe.state.n'));

// P7 crypto.randomUUID + 随机池消耗
ev('p7.js', 'globalThis.uu = crypto.randomUUID(); globalThis.nb = new Uint8Array(16); crypto.getRandomValues(nb);');
check('P7 randomUUID 形状', j('typeof uu === "string" && uu.length === 36 && uu[14] === "4"') === 'true', j('uu'));
check('P7b 随机池仍能供数（无 all-zero）', val('nb.some(v=>v!==0)') === true, String(val('nb.some(v=>v!==0)')));
dispatch({ kind: 'random', b64: Buffer.alloc(4096, 9).toString('base64') });
ev('p7c.js', 'globalThis.nc = new Uint8Array(1024); for(let i=0;i<40;i++) crypto.getRandomValues(nc);');
check('P7c 多次消耗不触发降级', val('nc.some(v=>v===9)') === true, String(val('nc.some(v=>v===9)')));

// P8 Intl / Temporal 页面可见
check('P8 页面可见 Intl', val('new Intl.NumberFormat("de-DE").format(1234.5)') === '1.234,5',
  val('new Intl.NumberFormat("de-DE").format(1234.5)'));
check('P8b 页面可见 Temporal', val('Temporal.PlainDate.from("2026-01-02").add({months:1}).toString()') === '2026-02-02',
  val('Temporal && String(Temporal.PlainDate.from("2026-01-02").add({months:1}))'));

// ---- P9 指纹面（navigator / screen / window.chrome）----
// 断言的核心是「JS 可见值必须与出站 HTTP 头同源」——反爬检测最看重的就是跨接口
// 自相矛盾（请求头说 Chrome 151/macOS，JS 里却对不上）。参考实现 Chromix 的 P0 校验
// 就是逐字段拿 JS 值比对 HTTP 头。
check('P9 navigator.userAgent 与出站 UA 同源', val('navigator.userAgent') === BROWSER_UA, val('navigator.userAgent'));
check('P9b appVersion = UA 去掉 Mozilla/', val('navigator.appVersion') === BROWSER_UA.replace(/^Mozilla\//, ''), val('navigator.appVersion'));
const brandExpr = 'navigator.userAgentData.brands.map(b=>\'"\'+b.brand+\'";v="\'+b.version+\'"\').join(", ")';
check('P9c userAgentData.brands 与 sec-ch-ua 逐字一致',
  val(brandExpr) === SEC_CH_UA, `${val(brandExpr)} vs ${SEC_CH_UA}`);
check('P9d 其余 UA-CH 字段与头一致',
  j('[navigator.userAgentData.mobile, navigator.userAgentData.platform]') === JSON.stringify([false, CH_PLATFORM]),
  j('[navigator.userAgentData.mobile, navigator.userAgentData.platform]'));
check('P9e languages 与 Accept-Language 一致',
  JSON.stringify(LANGUAGES) === j('navigator.languages') && ACCEPT_LANGUAGE.split(',')[0].split(';')[0] === val('navigator.language'),
  `${j('navigator.languages')} / ${val('navigator.language')}`);
check('P9f navigator 是真类实例（constructor.name 不是 Object）',
  val('navigator.constructor.name') === 'Navigator' && val('navigator instanceof Navigator') === true,
  `${val('navigator.constructor.name')} / ${val('navigator instanceof Navigator')}`);
// 真 Chrome 固定 5 个 PDF 插件 / 2 个 MIME，文件名全是 internal-pdf-viewer
check('P9g navigator.plugins 5 个 PDF 插件，可索引 / namedItem',
  val('navigator.plugins.length') === 5
  && val('navigator.plugins[0].name') === 'PDF Viewer'
  && val('navigator.plugins[0].filename') === 'internal-pdf-viewer'
  && val('navigator.plugins[0].length') === 2
  && val('navigator.plugins.namedItem("Chrome PDF Viewer").name') === 'Chrome PDF Viewer',
  j('[navigator.plugins.length, navigator.plugins[0].name, navigator.plugins[0].length]'));
check('P9h mimeTypes 2 条且 enabledPlugin 反向指回 Plugin',
  val('navigator.mimeTypes.length') === 2
  && val('navigator.mimeTypes[0].type') === 'application/pdf'
  && val('navigator.mimeTypes[0].enabledPlugin.name') === 'PDF Viewer',
  j('[navigator.mimeTypes.length, navigator.mimeTypes[0].type]'));
check('P9i deviceMemory / connection（桌面真 Chrome 的 connection 没有 type 字段）',
  val('navigator.deviceMemory') === DEVICE_MEMORY
  && val('navigator.connection.effectiveType') === '4g'
  && j('"type" in navigator.connection') === 'false',
  j('[navigator.deviceMemory, navigator.connection.effectiveType, "type" in navigator.connection]'));
ev('p9j.js', 'globalThis.permState = "pending"; navigator.permissions.query({ name: "clipboard-write" }).then((s) => { globalThis.permState = s.state + "/" + s.name; });');
pump();
check('P9j permissions.query 返回 PermissionStatus 形状',
  val('typeof navigator.permissions.query') === 'function' && val('permState') === 'granted/clipboard-write', val('permState'));
check('P9k pdfViewerEnabled / webdriver / sendBeacon / getGamepads',
  j('[navigator.pdfViewerEnabled, navigator.webdriver, typeof navigator.sendBeacon, JSON.stringify(navigator.getGamepads())]') === '[true,false,"function","[]"]',
  j('[navigator.pdfViewerEnabled, navigator.webdriver, typeof navigator.sendBeacon, JSON.stringify(navigator.getGamepads())]'));
// window.chrome：无头检测最经典的一条
check('P9l window.chrome 存在且恰好 app/csi/loadTimes 三键',
  val('Object.keys(window.chrome).sort().join(",")') === 'app,csi,loadTimes'
  && val('typeof chrome.app.isInstalled') === 'boolean',
  `${val('Object.keys(window.chrome).sort().join(",")')} / ${val('typeof chrome.app.isInstalled')}`);
check('P9m chrome.loadTimes() 13 键（照实测真 Chrome 抄）',
  j('Object.keys(chrome.loadTimes()).length') === '13', j('Object.keys(chrome.loadTimes()).length'));
check('P9n screen 与 innerWidth/outerHeight 自洽（默认视口）',
  j('[screen.width, screen.availWidth, innerWidth, outerWidth, devicePixelRatio>0]') === '[1280,1280,1280,1280,true]'
  && val('outerHeight > innerHeight') === true && val('screen.height >= innerHeight') === true,
  j('[screen.width, screen.availWidth, innerWidth, outerWidth]'));
dispatch({ kind: 'viewport', w: 1400, h: 1000 });
check('P9o 宿主派发 viewport 后 screen/inner 跟着变（页面读到本次渲染尺寸）',
  j('[innerWidth, innerHeight, screen.width, screen.height]') === '[1400,1000,1400,1074]',
  j('[innerWidth, innerHeight, screen.width, screen.height]'));
dispatch({ kind: 'viewport', w: 1280, h: 900 });
// Function.prototype.toString：自写桩函数不能暴露 JS 源码
check('P9p 桩函数 toString 是 native 形态',
  val('Function.prototype.toString.call(fetch)') === 'function fetch() { [native code] }'
  && val('Function.prototype.toString.call(getComputedStyle)') === 'function getComputedStyle() { [native code] }'
  && val('Function.prototype.toString.call(navigator.javaEnabled)') === 'function javaEnabled() { [native code] }',
  val('Function.prototype.toString.call(fetch)'));
check('P9q 普通用户函数 toString 不受影响（不能改动语言语义）',
  val('(function foo() { return 1; }).toString()') === 'function foo() { return 1; }',
  val('(function foo() { return 1; }).toString()'));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);