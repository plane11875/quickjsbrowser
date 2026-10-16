// session.js — QjsSession Durable Object：一实例 = 一个 JS 会话。
// 职责：持有 QjsEngine、泵 VM→宿主任务（console/定时器/fetch/navigate/storage/随机池）、
// 模块 import 图预取代抓（JS 侧解析器与 C 侧 normalize_module 语义对齐）、
// 对外提供 /eval /modules /state /log /reset。
// v1 边界：会话状态在 DO 内存（engine + storage + log），无 hibernation；
// DO 重启即丢会话（浏览器组件阶段再接 storage 持久化）。

import { QjsEngine } from './engine.js';
import { PageScripts } from './page-scripts.js';
import { moduleSpecifiers } from './module-resolver.js';
import { CdpConnection } from './cdp.js';
import { requestHeaders, guessType } from './fingerprint.js';
import { relayFetch } from './net/relay.js';

// 「被反爬挡住」的状态码。CF Bot Management 的挑战页是 403（带 cf-mitigated: challenge），
// HN 这类自研拦截是 419，限频是 429。这三种换个出口还有救；
// 404/500 之类是站点对内容的正常回答，重试纯属浪费。
const BLOCKED_STATUS = new Set([403, 419, 429]);
import initBlitz, { add_font, set_generic_lead, add_resource, clear_resources,
  missed_resources, render_png_rgba_no_js, last_panic } from './vendor/pkg/kitesurf_clone.js';
import blitzWasm from './vendor/pkg/kitesurf_clone_bg.wasm';
import { encodePNG } from './vendor/png.js';
import fontSansReg from './vendor/fonts/sans-regular.ttf';
import fontSansBold from './vendor/fonts/sans-bold.ttf';
import fontMono from './vendor/fonts/mono-regular.ttf';
import fontSc from './vendor/fonts/sc-regular.ttf';
import fontJp from './vendor/fonts/jp-regular.ttf';

const GENERIC_LEAD = [['monospace', ['mono', 'sc', 'jp']], ['ui-monospace', ['mono', 'sc', 'jp']]];

// 说明符是否像模像样。压缩过的 JS 里 `from`/`import(` 会出现在字符串和三元表达式内部，
// 纯正则会扫出 `],[30,0,[` 这类噪声，再被 resolveSpec 拼成 jsdelivr 地址真发出去。
// 实测一个 Discourse 页面能扫出 19 个垃圾——每个都白吃一次子请求（**每请求只有 50 个**）
// 外加一轮 CPU，属于纯亏。规则：不能含空白/引号/括号/方括号/逗号/分号/花括号/反斜杠，
// 长度 1..300。宁可漏掉极少数怪名字，也不能把噪声当模块名去抓。
const SPEC_BAD = /[\s"'`\\[\](){}<>,;|]/;
export function plausibleSpec(spec) {
  return typeof spec === 'string' && spec.length > 0 && spec.length <= 300 && !SPEC_BAD.test(spec);
}

// 能不能当「裸包名」去 jsdelivr 兜底。同样是压缩噪声的主要来源——`],[30,0,[` 这种
// 一旦被拼成 https://cdn.jsdelivr.net/npm/],[30,0,[/+esm 就是一个必然 404 的请求。
const BARE_OK = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[a-z0-9-~][a-z0-9-._~]*)*$/i;

// 模块源码二级缓存（会话内）。上一版每次 eval / 每次导航都把整张 import 图
// 重抓一遍：实测 60 模块的图，串行 BFS 1108ms，其中 99.9% 是网络等待。
// 命中缓存后同一张图只要 0.17ms。
const MOD_CACHE_MAX_ENTRIES = 512;
const MOD_CACHE_MAX_BYTES = 16 * 1024 * 1024;
// 单层并发上限：Workers 免费档每请求 50 次子请求、并发连接数也有限，
// 一口气 Promise.all 整个 BFS 层反而容易触发限流。
const PREFETCH_CONCURRENCY = 6;
// 出站抓取的头由 fingerprint.js 统一生成（按请求类型区分 Accept / Sec-Fetch-* /
// sec-ch-ua / Referer），不在这里各写一套。自报 quickjsbrowser/0.1 会被大量站点
// （含 Cloudflare 自己的 Bot 防护）直接 403——我们是在模拟浏览器，就该按浏览器报身份。
// 截图阶段的资源补抓并发。串行时每个资源一个 RTT，X 页面 50+ 资源直接吃掉
// 全部墙钟时间；并发后 50 个资源约 5~6 轮完成。
const RESOURCE_CONCURRENCY = 6;

function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 把内联 <script> 的体清空（保留标签与属性）。渲染器不执行 JS，脚本体只是要扫描的文本；
// 清了不影响画面，但能把 Discourse 这类「文档四分之三是 JS」的页面输入砍掉大半。
// 注意只动渲染输入，不动 JS 管线用的那份 HTML——那边要靠脚本体去 eval。
function stripScriptBodies(html) {
  if (!html || html.indexOf('<script') < 0) return html;
  return html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
}

// ---- 资源过滤：按「对画面有没有用」筛，而不是按数量砍 ----
// blitz 不执行 JS，所以为渲染去抓 .js 是 100% 的无用功——脚本永远改变不了这张图。
// 资源发现可能包含 script preload；它们不参与静态绘图。
// 留下影响像素的样式表、字体和图片。
//
// 埋点/统计类同理：它们不改画面，只消耗出站次数和 CPU。
const DROP_HOST = [
  /(^|\.)cloudflareinsights\.com$/i, /(^|\.)google-analytics\.com$/i, /(^|\.)googletagmanager\.com$/i,
  /(^|\.)doubleclick\.net$/i, /(^|\.)hotjar\.com$/i, /(^|\.)sentry\.io$/i, /(^|\.)bugsnag\.com$/i,
  /(^|\.)amplitude\.com$/i, /(^|\.)mixpanel\.com$/i, /(^|\.)segment\.(io|com)$/i,
];
const DROP_PATH = [/\/beacon(\.min)?\.js$/i, /\/gtag\//i, /\/gtm\.js$/i, /\/analytics(\.min)?\.js$/i];

/** 这个 URL 值得为「画一张图」去抓吗？ */
export function worthFetchingForRender(u) {
  let p;
  try { p = new URL(u); } catch (e) { return false; }
  if (DROP_HOST.some((re) => re.test(p.hostname))) return false;
  if (DROP_PATH.some((re) => re.test(p.pathname))) return false;
  // 脚本一律不抓：渲染器不执行它，抓回来只是多一次出站请求。
  // 兜底去 jsdelivr 拼出来的垃圾地址（/npm/xxx/+esm）也在这里一并被排除。
  if (guessType(u) === 'script') return false;
  return true;
}

// ---- 站点级限制 ----
// 资源受限的站点逐个配置，一套参数打不了天下。maxResources = 每张图最多补抓多少个子资源
// （不填 = 不限，交给 worthFetchingForRender 按用途筛）。
//
// linux.do 是主人指定的样本，公认的资源黑洞：开页就发几十个 JS 包。关掉 JS 执行是因为
// 它的多 MB 应用模块超出受控执行预算。默认静态；显式开启 JS 时按统一预算尝试，
// 超限会给出原因并回退，不再进入昂贵的编译/模块求值。
const SITE_LIMITS = [
  { host: 'linux.do', js: false },
];

function siteLimitsFor(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { return null; }
  return SITE_LIMITS.find((s) => host === s.host || host.endsWith('.' + s.host)) || null;
}

export class QjsSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.engine = null;
    this.log = [];
    this.url = 'about:blank';
    this.storage = { local: {}, session: {} };
    this.cookie = '';
    // 模块源码缓存：url → {text, kind}；null 值 = 已确认取不到（负缓存，
    // 避免每次导航都去撞同一个死链）
    this.modCache = new Map();
    this.modCacheBytes = 0;
    this.modCacheHits = 0;
    this.modCacheFetches = 0;
    // CDP 面（cdp.js 协议适配层使用）：连接集合、新文档早期脚本、事件外发钩子
    this.cdpConns = new Set();
    this.cdpEarlyScripts = null;
  }

  /** console/exception 任务转发给所有 CDP 连接（Runtime.consoleAPICalled 等） */
  cdpEmitTask(t) {
    for (const c of this.cdpConns) {
      try { c.onSessionTask(t); } catch (e) { /* 单连接失败不致命 */ }
    }
  }

  ensure() {
    if (this.engine) return;
    this.engine = new QjsEngine();
    const b = new Uint8Array(65536);
    crypto.getRandomValues(b);
    this.dispatch({ kind: 'random', b64: toB64(b) });
    this.dispatch({ kind: 'storage', local: this.storage.local, session: this.storage.session });
    this.dispatch({ kind: 'cookie', value: this.cookie });
    this.pushLoc();
  }

  dispatch(obj) {
    this.engine.callGlobal('__dispatch', JSON.stringify(obj));
  }

  pushLoc() { this.dispatch({ kind: 'loc', url: this.url }); }

  pushLog(text) {
    this.log.push(text);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
  }

  /** 任务泵：先抽干微任务再收任务（fetch_resolve 的 then 链靠微任务落地） */
  pump() {
    for (let round = 0; round < 16; round++) {
      this.engine.drainJobs();
      const tasks = this.engine.takeTasks();
      if (!tasks.length) break;
      for (const t of tasks) this.handleTask(t);
    }
    this.engine.drainJobs();
  }

  handleTask(t) {
    switch (t.kind) {
      case 'console':
        this.pushLog(`[${t.payload.level}] ${t.payload.text}`);
        this.cdpEmitTask(t);
        break;
      case 'page_error':
      case 'unhandled_rejection':
      case 'exception':
        this.pushLog('[exception] '+JSON.stringify(t.payload));
        this.cdpEmitTask({...t,kind:'exception'});
        break;
      case 'timer': {
        const delay = Math.min(Math.max(t.payload.delay || 0, 0), 60000);
        setTimeout(() => {
          if (!this.engine) return;
          this.dispatch({ kind: 'timer_fire', id: t.payload.id });
          this.pump();
        }, delay);
        break;
      }
      case 'fetch':
        this.ctx.waitUntil(this.hostFetch(t.payload));
        break;
      case 'navigate': {
        const target = /^https?:/i.test(t.payload.url)
          ? t.payload.url
          : new URL(t.payload.url, this.url === 'about:blank' ? 'https://session.local/' : this.url).href;
        this.url = target;
        this.pushLoc();
        this.pushLog(`[navigate] ${target}${t.payload.reload ? ' (reload)' : ''}`);
        // v1：仅切 URL；完整导航管线（抓 HTML→装载→脚本）属浏览器组件阶段
        break;
      }
      case 'history': {
        if (t.payload.url) {
          this.url = new URL(t.payload.url, this.url).href;
          this.pushLoc();
        }
        break;
      }
      case 'storage_set': {
        const m = this.storage[t.payload.which === 'session' ? 'session' : 'local'];
        if (t.payload.value == null) delete m[t.payload.key];
        else m[t.payload.key] = t.payload.value;
        break;
      }
      case 'storage_clear':
        this.storage[t.payload.which === 'session' ? 'session' : 'local'] = {};
        break;
      case 'cookie_set':
        this.cookie = t.payload.value;
        this.dispatch({ kind: 'cookie', value: this.cookie });
        break;
      case 'need_random': {
        const b = new Uint8Array(Math.min(t.payload.bytes || 4096, 65536));
        crypto.getRandomValues(b);
        this.dispatch({ kind: 'random', b64: toB64(b) });
        break;
      }
      case 'outbox_corrupt':
        this.pushLog(`[outbox_corrupt] ${t.payload.raw}`);
        break;
      case 'outbox_dropped':
        // 一次 eval 里产生的任务超过 outbox 上限（65536），超出部分被丢弃
        this.pushLog(`[outbox-dropped] ${t.payload.n} task(s) dropped`);
        break;
      default:
        this.pushLog(`[unknown-task] ${t.kind}`);
    }
  }

  async hostFetch(p) {
    try {
      // 页面脚本发起的 fetch：套上 Chrome 的同款默认头，页面自己给的头优先生效
      // （真实浏览器就是这样——UA/Accept/Sec-Fetch-* 由浏览器补，页面只能改部分）。
      const chrome = requestHeaders({ type: 'xhr', url: p.url, referer: this.url, mode: 'cors', origin: true });
      const reqHeaders = { ...chrome };
      for (const [k, v] of Object.entries(p.headers || {})) {
        // 页面显式给的头覆盖浏览器默认值；同名不同大小写按 HTTP 语义覆盖
        const key = Object.keys(reqHeaders).find((h) => h.toLowerCase() === k.toLowerCase());
        if (key) delete reqHeaders[key];
        reqHeaders[k] = v;
      }
      const r = await this.smartFetch(p.url, {
        method: p.method,
        headers: reqHeaders,
        body: p.method === 'GET' || p.method === 'HEAD' ? undefined : p.body,
        redirect: 'follow',
      });
      const ct = r.headers.get('content-type') || '';
      const isText = /^(text\/|application\/(json|javascript|xml))/i.test(ct) || ct.includes('+xml');
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      let resp;
      if (isText) {
        resp = { ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, headers, text: await r.text() };
      } else {
        resp = { ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, headers, base64: toB64(new Uint8Array(await r.arrayBuffer())) };
      }
      this.dispatch({ kind: 'fetch_resolve', id: p.id, resp });
      this.pump();
    } catch (e) {
      this.dispatch({ kind: 'fetch_resolve', id: p.id, error: String((e && e.message) || e) });
      this.pump();
    }
  }

  // ---- 模块图预取（JS 侧解析器与 C normalize_module 对齐：绝对URL/根相对/点段/裸→jsdelivr） ----
  resolveSpec(base, name) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(name)) {
      if (/^https?:/i.test(name)) return name;
      if (name.startsWith('npm:')) return `https://cdn.jsdelivr.net/npm/${name.slice(4)}/+esm`;
      return name;
    }
    if (name.startsWith('//')) return 'https:' + name;
    const baseAbs = this.url === 'about:blank' ? 'https://session.local/' : base;
    if (name.startsWith('/')) return new URL(name, new URL(baseAbs).origin).href;
    if (name.startsWith('./') || name.startsWith('../')) return new URL(name, baseAbs).href;
    // 裸说明符 → jsdelivr 单文件 ESM。不像包名的（压缩噪声）直接放弃，别去发注定 404 的请求。
    if (!BARE_OK.test(name)) return null;
    return `https://cdn.jsdelivr.net/npm/${name}/+esm`;
  }

  scanSpecs(src) {
    try { return moduleSpecifiers(src).filter(plausibleSpec); }
    catch (e) { this.pushLog('[module-parse] '+e.message); return []; }
  }

  async fetchModuleSource(url) {
    // 会话内二级缓存（含负缓存）：同一 URL 只真抓一次
    if (this.modCache.has(url)) {
      this.modCacheHits++;
      return this.modCache.get(url);
    }
    this.modCacheFetches++;
    let entry = null;
    try {
      // 模块图预取：Chrome 对 module script 发 sec-fetch-dest:script + mode:cors + Origin
      const r = await this.smartFetch(url, {
        headers: requestHeaders({ type: 'script', url, referer: this.url, mode: 'cors', origin: true }),
        redirect: 'follow',
      });
      if (r.ok) {
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        const text = await r.text();
        // JSON 模块（import ... with {type:'json'} 或 .json URL）：不判 ESM，
        // 注册时 kind=1，C 侧包成 export default
        const isJson = /\.json(\?|#|$)/.test(url) || /\bjson\b/.test(ct);
        if (!isJson && /javascript/.test(ct) && !/\b(export|import)\b/.test(text)) {
          // UMD/CJS 拒判（remoteagent 同款）：无 import/export 的 JS 不是 ESM
          entry = null;
        } else {
          entry = { text, kind: isJson ? 1 : 0 };
        }
      }
    } catch {
      entry = null;
    }
    this.cacheModule(url, entry);
    return entry;
  }

  cacheModule(url, entry) {
    if (this.modCache.size >= MOD_CACHE_MAX_ENTRIES ||
        this.modCacheBytes + (entry ? entry.text.length : 0) > MOD_CACHE_MAX_BYTES) {
      // 整表清空而不是 LRU：会话模块图天然有强时间局部性，整清最省事也够用
      this.modCache.clear();
      this.modCacheBytes = 0;
    }
    this.modCache.set(url, entry);
    if (entry) this.modCacheBytes += entry.text.length;
  }

  /** 把抓到的模块注册进 C 源码表（kind: 0=JS / 1=JSON） */
  registerModule(url, entry) {
    return this.engine.addModuleSource(url, entry.text, entry.kind);
  }

  /** BFS 抓齐 entry 的静态 import 闭包并注册进 C 源码表。
   *  层内并发：上一版每层逐个 await，整图耗时 = 层数 × 每模块 RTT；
   *  层内并发后 = 层数 × RTT（并发上限 PREFETCH_CONCURRENCY）。
   *  实测 60 模块 3 叉树、每请求 30ms 延迟：串行 1108ms → 并发 112ms（9.9×）。 */
  async prefetchGraph(entryUrl, entrySrc) {
    this.ensure();   // 注册要写 C 源码表，没有引擎就是空指针
    const seen = new Set([entryUrl]);
    let queue = [[entryUrl, entrySrc]];
    const h0 = this.modCacheHits, f0 = this.modCacheFetches;
    for (let depth = 0; queue.length && depth < 32; depth++) {
      // 先把本层所有未见的说明符收集齐（纯计算，无 IO）
      const want = [];
      for (const [url, src] of queue) {
        for (const spec of this.scanSpecs(src)) {
          const abs = this.resolveSpec(url, spec);
          if (!abs) continue;
          this.engine.addModuleResolution(url, spec, abs);
          if (seen.has(abs)) continue;
          seen.add(abs);
          want.push(abs);
        }
      }
      if (!want.length) break;
      const texts = await this.mapLimit(want, PREFETCH_CONCURRENCY,
        (u) => this.fetchModuleSource(u).catch(() => null));
      const next = [];
      for (let i = 0; i < want.length; i++) {
        const entry = texts[i];
        if (!entry) {
          this.pushLog(`[module-miss] ${want[i]}`);
          continue;
        }
        this.registerModule(want[i], entry);
        next.push([want[i], entry.text]);
      }
      queue = next;
    }
    return { fetches: this.modCacheFetches - f0, hits: this.modCacheHits - h0 };
  }

  /** 限并发 map：不用 Promise.all 整层齐射，避免撞 Workers 子请求/连接限制 */
  async mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        out[k] = await fn(items[k], k);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async evalCode({ code, url, type }) {
    this.ensure();
    const entryUrl = url || `https://session.local/eval-${Date.now()}.js`;
    this.url = entryUrl;
    this.pushLoc();
    const isModule = type ? type === 'module' : /(^|[;{}\n])\s*(import|export)\b/.test(code);
    if (!isModule) {
      // 脚本：走 callGlobal('eval') 拿完成值（间接 eval = 全局作用域，语义同浏览器 <script>）
      const r = this.engine.callGlobal('eval', code);
      this.pump();
      return { ok: !!r.ok, value: r.undef ? null : r.value ?? null, undef: !!r.undef, url: entryUrl, module: false, error: r.error };
    }
    const graph = await this.prefetchGraph(entryUrl, code);
    const rc = this.engine.eval(code, entryUrl, true);
    this.pump();
    return {
      ok: rc === 0, url: entryUrl, module: true,
      moduleFetches: graph.fetches, moduleCacheHits: graph.hits,
    };
  }

  addModules(sources) {
    this.ensure();
    let n = 0;
    for (const s of sources) {
      if (s && typeof s.url === 'string' && typeof s.src === 'string') {
        const kind = s.kind === 1 || /\.json(\?|#|$)/.test(s.url) ? 1 : 0;
        if (this.engine.addModuleSource(s.url, s.src, kind)) {
          n++;
          this.cacheModule(s.url, { text: s.src, kind });
        }
      }
    }
    return { added: n };
  }

  // ---- Blitz 渲染（isolate 生命周期单例：字体只注册一次） ----
  ensureBlitz() {
    return (this.blitzReady ??= (async () => {
      await initBlitz(blitzWasm);
      for (const [bytes, family] of [
        [fontSansReg, 'sans'], [fontSansBold, 'sans'],
        [fontMono, 'mono'], [fontSc, 'sc'], [fontJp, 'jp'],
      ]) add_font(new Uint8Array(bytes), family);
      for (const [g, fams] of GENERIC_LEAD) set_generic_lead(g, fams);
      return true;
    })());
  }

  /** x.com 推文页适配：布局放宽 + zoom（display 裁剪走 DOM 手术，不依赖类名） */
  static TWEET_FIT_CSS = `
main { width: 100% !important; max-width: 100% !important; }
main div[class*="max-w-[600px]"] { max-width: 100% !important; }
main div[class*="max-w-[602px]"] { max-width: 100% !important; }
div[class*="max-w-[1278px]"] { max-width: none !important; }
html { zoom: 1.6 !important; }
`;

  /** x.com 推文页 DOM 手术：删侧栏/顶栏/评论占位/底部登录墙（结构级，双变体通用） */
  static TWEET_SURGERY_JS = `
(() => {
  const main = document.querySelector('main');
  if (!main) return 'no-main';
  // 1. 沿祖先链删掉每一层里 main（或其祖先）之外的所有兄弟子树（左右栏、容器级噪音）
  let node = main;
  while (node.parentElement && node.parentElement !== document.body) {
    const p = node.parentElement;
    for (const el of [...p.children]) if (el !== node) el.remove();
    node = p;
  }
  // 2. body 顶层：删掉不在 main 祖先链上的 fixed/aside/登录墙兄弟（底部登录墙等）
  const chain = new Set();
  for (let n = main; n; n = n.parentElement) chain.add(n);
  for (const el of [...document.body.children]) {
    if (chain.has(el)) continue;
    const cls = el.getAttribute('class') || '';
    if (el.tagName === 'ASIDE' || /fixed|bottom-0/.test(cls) || /登录或注册|继续前往/.test(el.textContent || '')) el.remove();
  }
  // 3. main 内：顶栏（sticky）删，h1 sr-only 保留，推文列容器保留
  for (const el of [...main.children]) {
    if (el.tagName === 'H1') continue;
    const cls = el.getAttribute('class') || '';
    if (/sticky/.test(cls)) { el.remove(); continue; }
    // 4. 推文列容器内的兄弟：推文卡（第一个 outline-blue-500）之后的全删（评论骨架等）
    const col = /max-w-\\[600px\\]/.test(cls) ? el : null;
    if (col) {
      const card = col.querySelector('div[class*="outline-blue-500"]');
      if (card) for (const sib of [...card.parentElement.children]) if (sib !== card) sib.remove();
      for (const sib of [...main.children]) if (sib !== el && sib.tagName !== 'H1' && !/sticky/.test(sib.getAttribute('class') || '')) sib.remove();
    }
  }
  // 5. 注入布局 CSS
  const s = document.createElement('style');
  s.setAttribute('data-qjb-fit', '');
  s.textContent = ${JSON.stringify(QjsSession.TWEET_FIT_CSS)};
  document.head.appendChild(s);
  return 'ok';
})()`;


  /** 渲染 + missed_resources 闭环回收（CSS/图片/@import 多轮）；trim = 裁掉底部整行空白 */
  async paint(rawHtml, baseUrl, w, h, trim = false, opts = {}) {
    // Workers clocks advance at I/O boundaries. These markers describe resource
    // progress; synchronous rendering CPU must be checked in platform telemetry.
    const T = Date.now();
    const mark = (label) => { this.pushLog(`[paint-ms] ${label} +${Date.now() - T}ms (共 ${Date.now() - T}ms)`); };
    await this.ensureBlitz();
    mark('ensureBlitz');
    // blitz 不执行 JS，script 体对它只是白白要扫过去的文本。linux.do 的文档 343KB 里
    // 266KB 是内联 JS（33 个 script 标签），占四分之三——裁掉它，渲染输入直接瘦一半以上。
    const html = stripScriptBodies(rawHtml);
    clear_resources();
    let rgba = render_png_rgba_no_js(html, baseUrl, w, h);
    mark(`首轮渲染 (输入 ${(html.length / 1024).toFixed(0)}KB)`);
    // 资源补抓：并发 + 去重。串行抓 50 个资源 = 50 个 RTT，是截图耗时的主因；
    // 且前一轮抓失败的 URL 会在下一轮被再次请求，纯属浪费。
    // maxResources 是站点级闸门：每次出站请求都要付 CPU（连接建立算在同进程里），
    // 像 linux.do 那样一次要补 87 个资源，直接把自己送进 CPU 上限。
    const budget = opts.maxResources == null ? Infinity : opts.maxResources;
    let spent = 0;
    const tried = new Set();
    const resourceController=new AbortController();
    const resourceTimer=setTimeout(()=>resourceController.abort(),2000);
    this.renderResourcesIncomplete=false;this.renderResourceFailures=0;
    try {
    for (let pass = 0; pass < 3 && spent < budget; pass++) {
      let missed;
      try { missed = missed_resources(); } catch (e) { break; }
      if (!missed || !missed.length) break;
      let todo = missed.filter((u) => !tried.has(u) && worthFetchingForRender(u));
      for (const u of missed) tried.add(u);
      if (!todo.length) { this.pushLog(`[resources] pass ${pass + 1}: 无新增，停止`); break; }
      const room = budget - spent;
      if (todo.length > room) {
        this.pushLog(`[resources] 站点限额：本轮 ${todo.length} 个只抓前 ${room} 个（maxResources=${budget}）`);
        todo = todo.slice(0, room);
      }
      spent += todo.length;
      this.pushLog(`[resources] pass ${pass + 1}: ${todo.length} 新增待抓（共 ${missed.length} missed）`);
      let added = 0;
      await this.mapLimit(todo, RESOURCE_CONCURRENCY, async (u) => {
        if(resourceController.signal.aborted)return;
        try {
          // 资源补抓：按扩展名判类型（css/image/font/js 的头各不相同），Referer 用文档 URL
          const rr = await this.smartFetch(u, {
            redirect: 'follow',
            headers: requestHeaders({ type: guessType(u), url: u, referer: baseUrl, mode: 'no-cors' }),
            signal:resourceController.signal,
          }, { allowRelay: false });
          if (rr.ok) { add_resource(u, new Uint8Array(await rr.arrayBuffer())); added++; }
          else this.renderResourceFailures++;
        } catch (e) { this.renderResourceFailures++; }
      });
      // 全军覆没时重渲染毫无意义（画面不会变化），直接进入收尾，省一次全量渲染。
      mark(`pass${pass + 1} 抓 ${todo.length} 个资源`);
      if (!added) { this.pushLog(`[resources] pass ${pass + 1}: 无新增成功，跳过重渲染`); break; }
      rgba = render_png_rgba_no_js(html, baseUrl, w, h);
      mark(`pass${pass + 1} 重渲染 (抓了 ${todo.length} 个)`);
    }
    } finally {clearTimeout(resourceTimer);}
    if(resourceController.signal.aborted){this.renderResourcesIncomplete=true;this.pushLog('[resource-budget] 2000ms network window exhausted');}
    let buf = new Uint8Array(rgba);
    if (trim) {
      // 内容检测裁剪：跳过透明像素（空白区是透明黑），剩余亮度<210 算内容；内容外保留 40px 边距
      const TH = 210, MARGIN = 40;
      const rowHasContent = (row) => {
        for (let x = 0; x < w; x += 2) {
          const o = row * w * 4 + x * 4;
          if (buf[o + 3] !== 0 && (buf[o] + buf[o + 1] + buf[o + 2]) / 3 < TH) return true;
        }
        return false;
      };
      const colHasContent = (x, maxRow) => {
        for (let y = 0; y < maxRow; y += 2) {
          const o = y * w * 4 + x * 4;
          if (buf[o + 3] !== 0 && (buf[o] + buf[o + 1] + buf[o + 2]) / 3 < TH) return true;
        }
        return false;
      };
      let lastRow = 0, lastCol = 0;
      for (let y = h - 1; y >= 0; y -= 2) { if (rowHasContent(y)) { lastRow = y; break; } }
      for (let x = w - 1; x >= 0; x -= 2) { if (colHasContent(x, Math.min(lastRow + MARGIN, h))) { lastCol = x; break; } }
      // 内容顶到视口下沿 = 还有内容没渲染出来（长推文常见）。裁剪会把它悄悄切掉，
      // 调用方拿到的就是一张残图却毫无察觉，故显式告警，提示调大 h 重拍。
      if (lastRow >= h - 2) {
        this.pushLog(`[trim-warn] 内容触底（lastRow=${lastRow}/${h}），疑似被截断，请增大 h 重拍`);
      }
      const outH = Math.min(h, lastRow + MARGIN);
      const outW = Math.min(w, lastCol + MARGIN);
      this.pushLog(`[trim] ${w}x${h} -> ${outW}x${outH}`);
      const out = new Uint8Array(outW * outH * 4);
      for (let y = 0; y < outH; y++) {
        out.set(buf.subarray(y * w * 4, y * w * 4 + outW * 4), y * outW * 4);
      }
      buf = out;
      w = outW;
      h = outH;
      mark(`trim -> ${outW}x${outH}`);
    }
    const png = await encodePNG(buf, w, h);
    mark(`encodePNG ${w}x${h}`);
    if(this.pageStatus)this.pageStatus.resources=this.renderResourcesIncomplete?'limited':this.renderResourceFailures?'partial':'loaded';
    return png;
  }

  /** 页面脚本管线：抽脚本 → 预取 → DOM 建立 → 经典脚本 → 模块 → settle → 序列化 */
  async runPageScripts(html, baseUrl, { serialize = true, executeScripts, viewport } = {}) {
    const lim=siteLimitsFor(baseUrl);
    const enabled=executeScripts ?? lim?.js!==false;
    // A new document gets a fresh VM: old globals, pending jobs and module
    // records must not survive navigation or an aborted page application.
    if(this.engine){this.engine.dispose();this.engine=null;}
    this.ensure();this.url=baseUrl;this.pushLoc();if(viewport)this.dispatch({kind:'viewport',...viewport});
    this.dispatch({kind:'load_dom',html,baseUrl});
    const early=()=>{
      for(const item of this.cdpEarlyScripts||[]){
        const r=this.engine.callGlobal('__run_classic',item.src);
        if(r.value)this.pushLog('[early-script-error] '+r.value);
        this.pump();
      }
    };
    early();
    const manifest=this.engine.callGlobal('__page_manifest').value;
    if(!manifest)throw new Error('DOM manifest failed');
    if(enabled){
      // On failure rebuild the original DOM and trusted automation in a clean VM.
      try{this.pageStatus=await new PageScripts(this,baseUrl,manifest).run();}
      catch(e){this.pageStatus={mode:'bounded',status:'degraded',errors:[{reason:'pipeline',detail:e.message}]};}
      if(this.pageStatus.status==='degraded'){
        // A preflight refusal has not executed page code or changed its DOM.
        // Keep it intact instead of reinitializing Wasm and repeating automation.
        if(this.pageStatus.executed!==0){
          this.engine.dispose();this.engine=null;this.ensure();this.pushLoc();
          if(viewport)this.dispatch({kind:'viewport',...viewport});this.dispatch({kind:'load_dom',html,baseUrl});early();
        }
        this.dispatch({kind:'domready'});this.pump();
      }
    }else{
      this.pageStatus={mode:'fast',status:'static',executed:0,requests:0,errors:[]};
      this.dispatch({kind:'domready'});this.pump();
    }
    this.pageStatus.rendering=manifest.hasFallback && this.pageStatus.status!=='executed'?'fallback':this.pageStatus.status==='executed'?'scripted':'static';
    this.pushLog('[page-status] '+JSON.stringify(this.pageStatus));
    if(serialize)return this.engine.callGlobal('__dom_html').value||html;
  }

  /**
   * 出站抓取统一入口：直连优先，只有挨了反爬耳光才换反代 IP 的出口重试。
   *
   * 为什么需要它：Worker 的 fetch() 出口永远是 CF 机房 IP，Bot Management 一认一个准
   * （linux.do 403 挑战页、HN 419），而 cloudflare:sockets 明令禁止连 CF 自己的地址段，
   * 所以 Worker 内部没法自救。反代 IP 是中转站——TCP 连到它、TLS 的 SNI 写目标域名，
   * 它按 SNI 转发，目标站看到的是反代的 IP（实测 HN 419 → 200）。
   *
   * **只给主文档开反代**（allowRelay 默认 true，只有截图/导航这类顶层抓取该用）。
   * 反代一次要先跑一遍完整的手搓 TLS（纯 JS 的 BigInt x25519 + HKDF + AES），
   * 纯 CPU 开销；子资源动辄几十上百个、又大多在 CDN 上根本不需要换出口，
   * 给它们开反代等于把 CPU 烧光——实测 linux.do 87 个子资源那条路径直接把
   * DO 的 30 秒 CPU 上限撞满（outcome=exceededCpu，返回 500/1101）。
   *
   * 只在「被拦」的状态码上走反代：正常站点一次直连就够，不给它们额外加一个 RTT。
   * 反代也救不回来时把直连的原始响应还给调用方——错误信息应该反映真实的第一现场。
   */
  async smartFetch(url, init = {}, { allowRelay = true } = {}) {
    const r = await fetch(url, init);
    const relay = this.env && this.env.RELAY_IP;
    if (!allowRelay || !relay || r.ok || !BLOCKED_STATUS.has(r.status)) return r;
    try {
      const alt = await relayFetch(relay, url, {
        method: init.method || 'GET',
        headers: init.headers || {},
        body: typeof init.body === 'string' ? init.body : null,
        redirect: init.redirect === 'manual' ? 'manual' : 'follow',
        signal:init.signal,
      });
      if (alt.ok) {
        this.pushLog(`[relay] ${r.status} → ${alt.status} ${url}`);
        return alt;
      }
      this.pushLog(`[relay] 反代没救回来：${r.status} → ${alt.status} ${url}`);
    } catch (e) {
      if(init.signal?.aborted)throw e;
      this.pushLog(`[relay-error] ${String((e && e.message) || e)} <- ${url}`);
    }
    return r;
  }

  async fetchDocument(url) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(new Error('document network budget exceeded (2500ms)')),2500);
    try{
      const r=await this.smartFetch(url,{redirect:'follow',signal:controller.signal,headers:requestHeaders({type:'document',url})});
      if(!r.ok){r.body?.cancel().catch(()=>{});throw new Error(`fetch failed: HTTP ${r.status}`+(r.headers.get('cf-mitigated')?' (cf-mitigated: challenge)':''));}
      const reader=r.body?.getReader(),parts=[];let bytes=0;
      if(reader){
        try{for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>1024*1024)throw new Error('document exceeds 1 MiB input budget');parts.push(p.value);}}
        catch(e){reader.cancel().catch(()=>{});throw e;}
      }
      const body=new Uint8Array(bytes);let offset=0;for(const p of parts){body.set(p,offset);offset+=p.length;}
      return {html:new TextDecoder().decode(body),finalUrl:r.url||url};
    }catch(e){
      this.pageStatus={status:'failed',stage:'document',reason:controller.signal.aborted?'document-timeout':'document-fetch',detail:e.message,url};
      this.pushLog('[document-error] '+JSON.stringify(this.pageStatus));throw e;
    }finally{clearTimeout(timer);}
  }

  /** 截图主流程 */
  async shot({ url, w, h, js, translate, fit }) {
    const lim = siteLimitsFor(url);
    const {html,finalUrl}=await this.fetchDocument(url);
    let finalHtml = html;
    let usedEngineDom = false;
    // 页面脚本可能读 screen/innerWidth 做分支，视口必须先于脚本派发（否则读到默认值）。
    if(!js){this.ensure();this.dispatch({kind:'viewport',w,h});}
    if (js) {
      try { finalHtml = await this.runPageScripts(html, finalUrl, {executeScripts:true,viewport:{w,h}}); usedEngineDom = true; }
      catch (e) { this.pushLog('[js-pipeline-error] ' + String((e && e.message) || e)); }
    }
    if (fit === 'tweet' || translate) {
      // 统一走 DOM：fit 需要手术，translate 需要改文本；js 管线已建 DOM 则复用
      if (!usedEngineDom) {
        this.ensure();
        this.url = finalUrl;
        this.pushLoc();
        this.dispatch({ kind: 'load_dom', html: finalHtml, baseUrl: finalUrl });
        this.dispatch({ kind: 'domready' });
        usedEngineDom = true;
      }
    }
    if (fit === 'tweet') {
      // DOM 手术（删侧栏/顶栏/评论占位/底墙）+ 注入布局 CSS，然后序列化
      const rc = this.engine.callGlobal('__run_classic', QjsSession.TWEET_SURGERY_JS);
      if (rc && rc.value) this.pushLog('[fit-surgery] ' + rc.value);
      this.pump();
      if (!translate) {
        const s = this.engine.callGlobal('__dom_html');
        if (s.ok && s.value) finalHtml = s.value;
      }
    }
    if (translate) {
      try {
        const t = await this.translateInDom(translate);
        if (t) finalHtml = t;
      } catch (e) { this.pushLog('[translate-error] ' + String((e && e.message) || e)); }
    }
    const png = await this.paint(finalHtml, finalUrl, w, h, fit === 'tweet',
      { maxResources: lim ? lim.maxResources : undefined });
    if(!js)this.pageStatus={mode:'fast',status:'static',rendering:/<noscript[^>]*data-path=/i.test(html)?'fallback':'static',executed:0,requests:0,errors:[]};
    this.pageStatus.resources=this.renderResourcesIncomplete?'limited':this.renderResourceFailures?'partial':'loaded';
    return { png, finalUrl, bytes: html.length, jsInfo:this.pageStatus };
  }

  /**
   * 内置翻译器：在已装载的 DOM 上提取正文容器 → DeepLX 翻译 → textContent 直接替换原文。
   * 返回序列化后的 HTML（失败抛错，由调用方降级为未翻译渲染）。
   */
  async translateInDom(lang) {
    const endpoint = this.env && this.env.DEEPLX_URL;
    if (!endpoint) throw new Error('DEEPLX_URL not configured');
    const script = `globalThis.__qqb_tr = 'running';
globalThis.__qqb_tr_get = () => globalThis.__qqb_tr;
(async () => {
  const set = (v) => { globalThis.__qqb_tr = v; };
  const emsg = (e) => String((e && (e.message || e.stack)) || e);
  try {
    console.log('[tr] step:pick');
    const pick = () => {
      const sel = document.querySelector('[data-testid="tweetText"]')
        || document.querySelector('div[dir="auto"][class*="whitespace-pre-wrap"]');
      if (sel && (sel.textContent || '').trim()) return sel;
      let best = null, bestLen = 0;
      for (const el of document.querySelectorAll('div, p, section, article')) {
        const t = el.textContent || '';
        if (t.length < 300) continue;
        let childMax = 0;
        for (const c of el.children) childMax = Math.max(childMax, (c.textContent || '').length);
        if (childMax > t.length * 0.8) continue;
        if (t.length > bestLen) { best = el; bestLen = t.length; }
      }
      return best;
    };
    const target = pick();
    if (!target) { set('err:no-target'); return; }
    const text = (target.textContent || '').slice(0, 20000);
    console.log('[tr] step:fetch len=' + text.length);
    if (!text.trim()) { set('err:empty'); return; }
    const r = await fetch(${JSON.stringify(endpoint)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, source_lang: 'auto', target_lang: ${JSON.stringify(lang)} }),
    });
    console.log('[tr] step:api status=' + r.status);
    const j = await r.json();
    if (!j || !j.data) { set('err:api:' + JSON.stringify(j).slice(0, 120)); return; }
    target.textContent = j.data;
    console.log('[tr] step:done');
    set('ok:' + text.length + '->' + j.data.length);
  } catch (e) { set('err:' + emsg(e)); }
})();`;
    const err = this.engine.callGlobal('__run_classic', script);
    if (err && err.value) throw new Error('translate script: ' + err.value);
    const deadline = Date.now() + 20000;
    for (;;) {
      this.pump();
      const s = this.engine.callGlobal('__qqb_tr_get');
      if (s && s.ok && typeof s.value === 'string' && s.value !== 'running') {
        this.pushLog('[translate] ' + s.value);
        if (!s.value.startsWith('ok')) throw new Error('translate: ' + s.value);
        break;
      }
      if (Date.now() > deadline) throw new Error('translate: timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
    const out = this.engine.callGlobal('__dom_html');
    return out.ok && out.value ? out.value : null;
  }

  reset() {
    if (this.engine) this.engine.dispose();
    this.engine = null;
    this.log = [];
    this.url = 'about:blank';
    this.storage = { local: {}, session: {} };
    this.cookie = '';
    this.modCache.clear();
    this.modCacheBytes = 0;
    this.modCacheHits = 0;
    this.modCacheFetches = 0;
    return { ok: true };
  }

  async fetch(request) {
    const u = new URL(request.url);
    const path = u.pathname.replace(/^\/s\/[^/]+/, '') || '/';
    try {
      // CDP WebSocket 端点：一连接 = 一个 CDP 客户端（普通 accept，不用 hibernation，
      // hibernation 重跑 constructor 会丢引擎实例）。消息经 per-connection 串行队列处理。
      if (path === '/cdp') {
        const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
        if (upgrade !== 'websocket') {
          return Response.json({ error: 'expected Upgrade: websocket' }, { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        // CDP 一连上就建引擎。puppeteer 会先走 Target.createTarget 顺带触发，
        // 但 DrissionPage 直接开 tab 就 Runtime.evaluate，引擎还是 null → callGlobal 崩。
        this.ensure();
        const conn = new CdpConnection(this, server);
        server.addEventListener('message', (ev) => {
          try { conn.onMessage(String(ev.data)); } catch (e) { /* 保活 */ }
        });
        server.addEventListener('close', () => conn.close());
        server.addEventListener('error', () => conn.close());
        return new Response(null, { status: 101, webSocket: client });
      }
      if (request.method === 'POST' && path === '/eval') {
        const body = await request.json();
        return Response.json(await this.evalCode(body));
      }
      if (request.method === 'POST' && path === '/modules') {
        const body = await request.json();
        return Response.json(this.addModules(body.sources || []));
      }
      if (request.method === 'POST' && path === '/shot') {
        const body = await request.json();
        const translate = body.translate
          ? (typeof body.translate === 'string' && body.translate.trim() ? body.translate.trim().toUpperCase() : 'ZH')
          : null;
        const { png, finalUrl, bytes, jsInfo } = await this.shot({ url: body.url, w: Math.min(body.w || 1280, 1920), h: Math.min(body.h || 900, 4096), js: !!body.js, translate, fit: body.fit });
        const resp = new Response(png, { headers: { 'content-type': 'image/png', 'x-final-url': finalUrl, 'x-html-bytes': String(bytes) } });
        if (jsInfo) { resp.headers.set('x-browser-status',jsInfo.rendering+':'+jsInfo.status); resp.headers.set('x-js-info',JSON.stringify({mode:jsInfo.mode,status:jsInfo.status,reason:jsInfo.errors?.[0]?.reason,requests:jsInfo.requests,executed:jsInfo.executed,resources:jsInfo.resources})); }
        return resp;
      }
      if (request.method === 'POST' && path === '/reset') {
        return Response.json(this.reset());
      }
      if (request.method === 'GET' && path === '/state') {
        return Response.json({
          url: this.url, storage: this.storage, cookie: this.cookie, live: !!this.engine, page:this.pageStatus||null,
          modCache: { entries: this.modCache.size, bytes: this.modCacheBytes, hits: this.modCacheHits, fetches: this.modCacheFetches },
        });
      }
      if (request.method === 'GET' && path === '/log') {
        return Response.json({ log: this.log });
      }
      return Response.json({ error: 'do-404', path }, { status: 404 });
    } catch (e) {
      return Response.json({ error: String((e && e.message) || e), log: this.log.slice(-8) }, { status: 500 });
    }
  }
}
