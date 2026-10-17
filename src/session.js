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
import { ResourceCache } from './resource-cache.js';
import { normalizeProxy, publicProxy } from './net/proxy.js';

import initBlitz, { add_font, set_generic_lead, add_resource, clear_resources,
  missed_resources, render_png_rgba_no_js, last_panic, layout_query } from './vendor/pkg/kitesurf_clone.js';
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
let activeResourceSession=null;

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

export class QjsSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.engine = null;
    this.log = [];
    this.url = 'about:blank';
    this.storage = { local: {}, session: {} };
    this.cookie = '';
    this.proxy = null;this.resourceCache=new ResourceCache();this.directOrigins=new Map();this.routeStats={relay:0,direct:0,fallback:0};
    this.pendingNavigation = null;
    this.pageLoad=null;this.loadBatchRemaining=null;this.operation=Promise.resolve();
    this.renderFailed=new Set();this.renderAssets=new Map();
    this.viewport={w:1024,h:768};
    this.layoutReads=0;this.pendingDynamicImports=[];this.hostTimers=new Set();this.hostFetches=new Set();
    // 模块源码缓存：url → {text, kind}；null 值 = 已确认取不到（负缓存，
    // 避免每次导航都去撞同一个死链）
    this.modCache = new Map();
    this.modCacheBytes = 0;
    this.modCacheHits = 0;
    this.modCacheFetches = 0;
    // CDP 面（cdp.js 协议适配层使用）：连接集合、新文档早期脚本、事件外发钩子
    this.cdpConns = new Set();
    this.cdpEarlyScripts = null;this.navigationEntries=[];this.navigationIndex=-1;this.nextNavigationId=1;this.pendingHistoryIndex=null;
  }

  withOperation(fn) {
    const next=this.operation.then(fn);this.operation=next.catch(()=>{});return next;
  }

  beginLoadBatch(requests=32) {
    if(!Number.isInteger(requests)||requests<1||requests>40)throw new Error('requests must be an integer from 1 to 40');
    this.loadBatchRemaining=requests;
  }

  async fetchLoadingResource(url,init) {
    return this.resourceCache.fetch(url,init,async()=>{
    if(this.loadBatchRemaining===0){const e=new Error('resource batch exhausted');e.loadingPending=true;throw e;}
    if(this.loadBatchRemaining!=null)this.loadBatchRemaining--;
    try{return await this.smartFetch(url,init);}
    catch(e){
      if(/Too many subrequests/i.test(e.message)){this.loadBatchRemaining=0;e.loadingPending=true;}
      throw e;
    }
    });
  }

  loadingState() {
    const job=this.pageLoad;
    return {id:job?.id||null,status:job?.pending?'pending':job?(this.pageStatus?.status==='degraded'?'failed':'complete'):'idle',stage:job?.stage||null,
      cachedResources:this.renderAssets.size,cachedScripts:job?.pipeline?[...job.pipeline.prepared.values()].filter(p=>p.text!=null).length:0,
      remainingScripts:job?.manifest?.scripts.filter(script=>job.enabled&&job.pipeline?.prepared.get(script)?.text==null).length||0,
      remainingResources:this.renderPending?.length||0,failedResources:this.renderFailed.size,
      page:this.pageStatus||null};
  }

  async continueLoading({id,requests=32}={}) {
    if(!this.pageLoad||id!==this.pageLoad.id)throw new Error('load session lost or stale load id; navigate again');
    if(!this.pageLoad.pending)return this.loadingState();
    this.beginLoadBatch(requests);await this.advancePageLoad();return this.loadingState();
  }

  /** console/exception 任务转发给所有 CDP 连接（Runtime.consoleAPICalled 等） */
  cdpEmitTask(t) {
    for (const c of this.cdpConns) {
      try { c.onSessionTask(t); } catch (e) { /* 单连接失败不致命 */ }
    }
  }

  ensure(instance=null) {
    if (this.engine) return;
    this.engine = new QjsEngine({layout:request=>this.syncLayout(request),instance});
    const b = new Uint8Array(65536);
    crypto.getRandomValues(b);
    this.dispatch({ kind: 'random', b64: toB64(b) });
    this.dispatch({ kind: 'storage', local: this.storage.local, session: this.storage.session });
    this.dispatch({ kind: 'cookie', value: this.cookie });
    this.pushLoc();this.pushHistory();
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
        const engine=this.engine;
        const timer=setTimeout(() => {
          this.hostTimers.delete(timer);
          if (!this.engine || this.engine!==engine) return;
          this.dispatch({ kind: 'timer_fire', id: t.payload.id });
          this.pump();
        }, delay);this.hostTimers.add(timer);
        break;
      }
      case 'fetch':
        this.ctx.waitUntil(this.hostFetch(t.payload));
        break;
      case 'dynamic_import': {
        this.pendingDynamicImports.push({payload:t.payload,engine:this.engine});
        this.ctx.waitUntil(this.withOperation(()=>this.advanceDynamicImports()));
        break;
      }
      case 'navigate': {
        this.pendingNavigation=new URL(t.payload.url,this.url==='about:blank'?'https://session.local/':this.url).href;
        const conn=this.cdpConns.values().next().value;conn?.requestNavigation();
        break;
      }
      case 'history': {
        this.url=t.payload.url?new URL(t.payload.url,this.url).href:this.url;
        this.recordNavigation(this.url,{replace:t.payload.mode==='replace',forcePush:t.payload.mode==='push'});
        this.navigationEntries[this.navigationIndex].state=t.payload.state==null?null:JSON.parse(t.payload.state);
        this.pushLoc();this.pushHistory();break;
      }
      case 'history_go': {
        const index=this.navigationIndex+Number(t.payload.delta||0);
        if(index>=0&&index<this.navigationEntries.length){this.pendingHistoryIndex=index;this.pendingNavigation=this.navigationEntries[index].url;this.cdpConns.values().next().value?.requestNavigation();}
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
    const engine=this.engine,controller=new AbortController();this.hostFetches.add(controller);
    try {
      const target=new URL(p.url,this.url).href;
      // 页面脚本发起的 fetch：套上 Chrome 的同款默认头，页面自己给的头优先生效
      // （真实浏览器就是这样——UA/Accept/Sec-Fetch-* 由浏览器补，页面只能改部分）。
      const chrome = requestHeaders({ type: 'xhr', url: target, referer: this.url, mode: 'cors', origin: true });
      const reqHeaders = { ...chrome };
      for (const [k, v] of Object.entries(p.headers || {})) {
        // 页面显式给的头覆盖浏览器默认值；同名不同大小写按 HTTP 语义覆盖
        const key = Object.keys(reqHeaders).find((h) => h.toLowerCase() === k.toLowerCase());
        if (key) delete reqHeaders[key];
        reqHeaders[k] = v;
      }
      const r = await this.smartFetch(target, {
        method: p.method,
        headers: reqHeaders,
        body: p.method === 'GET' || p.method === 'HEAD' ? undefined : p.body,
        redirect: 'follow',signal:controller.signal,
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
      if(this.engine!==engine)return;
      this.dispatch({ kind: 'fetch_resolve', id: p.id, resp });
      this.pump();
    } catch (e) {
      if(this.engine!==engine)return;
      this.dispatch({ kind: 'fetch_resolve', id: p.id, error: String((e && e.message) || e) });
      this.pump();
    }finally{this.hostFetches.delete(controller);}
  }

  cancelDocumentWork(){for(const timer of this.hostTimers)clearTimeout(timer);this.hostTimers.clear();for(const controller of this.hostFetches)controller.abort();this.hostFetches.clear();}

  recordNavigation(url,{index,replace=false,forcePush=false}={}) {
    if(Number.isInteger(index)&&this.navigationEntries[index]){this.navigationIndex=index;return;}
    const current=this.navigationEntries[this.navigationIndex];
    if(current&&(replace||(!forcePush&&current.url===url))){current.url=url;return;}
    this.navigationEntries.splice(this.navigationIndex+1);
    this.navigationEntries.push({id:this.nextNavigationId++,url,userTypedURL:url,title:'',transitionType:'link',state:null});
    if(this.navigationEntries.length>128)this.navigationEntries.shift();this.navigationIndex=this.navigationEntries.length-1;
  }

  pushHistory(){if(this.engine)this.dispatch({kind:'history_sync',state:this.navigationEntries[this.navigationIndex]?.state??null,length:this.navigationEntries.length||1});}

  async advanceDynamicImports() {
    const pending=this.pendingDynamicImports.splice(0).filter(p=>p.engine===this.engine);
    if(!pending.length||!this.pageLoad?.pipeline)return;
    this.pageLoad.pipeline.dynamicImports.push(...pending.map(p=>p.payload));this.pageLoad.pending=true;this.pageLoad.stage='scripts';
    this.beginLoadBatch(32);await this.advancePageLoad();
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
      this.blitzInitialized=true;
      return true;
    })());
  }

  activateResources() {
    if(activeResourceSession===this)return;
    clear_resources();
    for(const [url,bytes] of this.renderAssets)add_resource(url,bytes);
    activeResourceSession=this;
  }

  syncLayout(request) {
    if(!this.blitzInitialized)throw new Error('layout renderer is not ready');
    if(++this.layoutReads>2048)throw new Error('layout read budget exceeded');
    this.activateResources();
    return layout_query(stripScriptBodies(request.html),this.url,this.viewport.w,this.viewport.h,request.selector||'',request.property||'',request.x||0,request.y||0);
  }

  async prepareLayout(html,base,w=this.viewport.w,h=this.viewport.h) {
    await this.ensureBlitz();
    this.viewport={w,h};this.activateResources();
    this.renderResourcesIncomplete=false;this.renderResourceFailures=this.renderFailed.size;
    this.renderPending=[];
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000),tried=new Set();
    try {
      for(let pass=0;pass<4;pass++){
        this.activateResources();
        layout_query(stripScriptBodies(html),base,w,h,'','',0,0);
        const todo=missed_resources().filter(u=>!tried.has(u)&&!this.renderAssets.has(u)&&!this.renderFailed.has(u)&&worthFetchingForRender(u));
        if(!todo.length)break;
        for(const u of todo)tried.add(u);
        await this.mapLimit(todo,RESOURCE_CONCURRENCY,async(u)=>{
          try {
            const r=await this.fetchLoadingResource(u,{redirect:'follow',signal:controller.signal,headers:requestHeaders({type:guessType(u),url:u,referer:base})});
            if(!r.ok){r.body?.cancel().catch(()=>{});this.renderResourceFailures++;this.renderFailed.add(u);return;}
            const limit=4*1024*1024;if(+r.headers.get('content-length')>limit)throw new Error('render asset too large');
            const reader=r.body?.getReader(),chunks=[];let n=0;
            try{if(reader)for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>limit)throw new Error('render asset too large');chunks.push(r.value);}}catch(e){reader?.cancel().catch(()=>{});throw e;}
            const bytes=new Uint8Array(n);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
            let total=0;for(const b of this.renderAssets.values())total+=b.length;if(total+n>16*1024*1024)throw new Error('render asset memory budget exceeded');
            this.renderAssets.set(u,bytes);this.activateResources();add_resource(u,bytes);
          }catch(e){if(e.loadingPending||controller.signal.aborted){this.renderResourcesIncomplete=true;}else{this.renderResourceFailures++;this.renderFailed.add(u);}}
        });
        if(controller.signal.aborted||this.loadBatchRemaining===0){this.renderResourcesIncomplete=true;break;}
      }
    }finally{clearTimeout(timer);}
    this.activateResources();
    layout_query(stripScriptBodies(html),base,w,h,'','',0,0);
    this.renderPending=missed_resources().filter(u=>worthFetchingForRender(u)&&!this.renderAssets.has(u)&&!this.renderFailed.has(u));
    if(this.renderPending.length)this.renderResourcesIncomplete=true;
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
    await this.prepareLayout(html,baseUrl,w,h);
    this.activateResources();
    const rgba=render_png_rgba_no_js(html,baseUrl,w,h);
    mark('render');
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
  async runPageScripts(html, baseUrl, { serialize = true, executeScripts, viewport, resourceBatch = 32, historyIndex, replaceHistory=false } = {}) {
    this.beginLoadBatch(resourceBatch);
    this.cancelDocumentWork();this.pendingNavigation=null;this.pageLoad=null;
    const enabled=executeScripts ?? true;this.recordNavigation(baseUrl,{index:historyIndex,replace:replaceHistory});
    // A new document gets a fresh VM: old globals, pending jobs and module
    // records must not survive navigation or an aborted page application.
    const reusableInstance=this.engine?.instance;
    if(this.engine){this.engine.dispose();this.engine=null;}
    const previousUrl=this.url;this.ensure(reusableInstance);this.engine.callGlobal('eval',`globalThis.__document_referrer=${JSON.stringify(previousUrl==='about:blank'?'':new URL(previousUrl).origin===new URL(baseUrl).origin?previousUrl:new URL(previousUrl).origin+'/')}`);this.url=baseUrl;this.pushLoc();this.layoutReads=0;this.renderAssets.clear();this.renderFailed.clear();activeResourceSession=null;if(viewport){this.viewport=viewport;this.dispatch({kind:'viewport',...viewport});}
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
    if(enabled)this.engine.callGlobal('eval',`for(const n of document.querySelectorAll('noscript'))n.remove()`);
    const layoutHtml=this.engine.callGlobal('__dom_html').value||html;
    this.pageLoad={id:crypto.randomUUID(),html,layoutHtml,baseUrl,viewport,enabled,manifest,early,stage:'resources',pending:true,pipeline:null};
    await this.advancePageLoad();
    if(serialize)return this.engine.callGlobal('__dom_html').value||html;
  }

  async advancePageLoad() {
    const job=this.pageLoad;
    const {html,baseUrl,viewport,enabled,manifest,early}=job;
    if(job.stage==='resources'){
      await this.prepareLayout(job.layoutHtml,baseUrl);
      if(this.renderPending.length){
        this.pageStatus={mode:'bounded',status:'pending',rendering:'partial',executed:0,errors:[]};return;
      }
      job.stage='scripts';
    }
    if(enabled){
      // Preserve ordinary page exceptions and mutations; isolate runaway jobs only.
      try{this.pageStatus=await (job.pipeline??=new PageScripts(this,baseUrl,manifest)).run();}
      catch(e){this.pageStatus={mode:'bounded',status:'degraded',errors:[{reason:'pipeline',detail:e.message}]};}
      if(this.pageStatus.status==='pending'){this.pageStatus.rendering='partial';return;}
      if(this.pageStatus.status==='degraded'){
        // Only an exhausted execution scope needs a fresh VM to drop runaway jobs.
        if(job.pipeline?.executionAborted){
          const reusableInstance=this.engine.instance;this.engine.dispose();this.engine=null;this.ensure(reusableInstance);this.pushLoc();
          if(viewport)this.dispatch({kind:'viewport',...viewport});this.dispatch({kind:'load_dom',html,baseUrl});early();job.pipeline.domReady=false;
        }
        if(!job.pipeline?.domReady){this.dispatch({kind:'domready'});this.pump();}
      }
    }else{
      this.pageStatus={mode:'fast',status:'static',executed:0,requests:0,errors:[]};
      this.dispatch({kind:'domready'});this.pump();
    }
    if(enabled)this.engine.callGlobal('eval',`for(const n of document.querySelectorAll('noscript'))n.remove()`);
    this.pageStatus.rendering=enabled?(this.pageStatus.status==='executed'?'scripted':this.pageStatus.executed?'partial':'uninitialized'):(manifest.hasFallback?'fallback':'static');
    job.pending=false;job.stage='complete';this.loadBatchRemaining=null;
    const entry=this.navigationEntries[this.navigationIndex];if(entry)entry.title=this.engine.callGlobal('eval','document.title').value||'';
    this.pushLog('[page-status] '+JSON.stringify(this.pageStatus));
    if(!job.lifecycleComplete){job.lifecycleComplete=true;for(const c of this.cdpConns)c.onLoadingComplete?.();}
  }

  /** SNI routing is decided independently at each redirect target. */
  async smartFetch(url, init = {}) {
    if(!this.proxy || this.proxy.type!=='sni')return this.fetchRoute(url,init);
    let target=new URL(url),options={...init},method=(init.method||'GET').toUpperCase();
    for(let hop=0;;hop++){
      const r=await this.fetchRoute(target.href,{...options,method,redirect:'manual'});
      const location=r.headers.get('location'),redirect=[301,302,303,307,308].includes(r.status)&&location;
      if(!redirect||init.redirect==='manual')return r;
      r.body?.cancel().catch(()=>{});
      if(init.redirect==='error')throw new Error('redirect disallowed');
      if(hop>=5)throw new Error('too many redirects');
      const next=new URL(location,target),headers=new Headers(options.headers);
      if(next.origin!==target.origin){headers.delete('authorization');headers.delete('cookie');}
      if((r.status===303&&method!=='HEAD')||([301,302].includes(r.status)&&method==='POST')){method='GET';options.body=undefined;headers.delete('content-type');headers.delete('content-length');}
      options.headers=headers;target=next;
    }
  }

  async fetchRoute(url, init = {}) {
    const target=new URL(url),origin=target.origin;
    const safe=['GET','HEAD'].includes((init.method||'GET').toUpperCase());
    const direct=async()=>{this.routeStats.direct++;const r=await fetch(url,init);this.pushLog(`[route] direct ${target.origin} ${r.status}`);return r;};
    if(!this.proxy)return direct();
    if(this.proxy.type==='sni'&&safe&&this.directOrigins.get(origin)>Date.now())return direct();
    try{
      this.routeStats.relay++;
      const r=await relayFetch(this.proxy,url,init);
      this.pushLog(`[route] ${this.proxy.type} ${origin} ${r.status}`);
      return r;
    }catch(e){
      if(this.proxy.type!=='sni'||!safe||init.signal?.aborted||/Too many subrequests/i.test(e.message))throw e;
      this.routeStats.fallback++;this.pushLog(`[route] fallback ${origin}: ${e.message}`);
      try{const r=await direct();if(r.ok){if(this.directOrigins.size>=128)this.directOrigins.delete(this.directOrigins.keys().next().value);this.directOrigins.set(origin,Date.now()+300000);}return r;}
      catch(d){throw new Error(`SNI relay: ${e.message}; direct: ${d.message}`);}
    }
  }

  configureProxy(input) {
    const next=normalizeProxy(input);
    if(JSON.stringify(next)===JSON.stringify(this.proxy))return publicProxy(this.proxy);
    if(this.engine && this.url!=='about:blank')throw new Error('configure proxy before navigation; use a fresh session to change it');
    if(this.proxy && JSON.stringify(this.proxy)!==JSON.stringify(next))throw new Error('session proxy is already configured; use a fresh session');
    this.proxy=next;
    return publicProxy(this.proxy);
  }

  async fetchDocument(url) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(new Error('document network budget exceeded (10000ms)')),10000);
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
    const png = await this.paint(finalHtml, finalUrl, w, h, fit === 'tweet');
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
    this.cancelDocumentWork();
    if (this.engine) this.engine.dispose();
    this.engine = null;
    this.log = [];
    this.url = 'about:blank';
    this.storage = { local: {}, session: {} };
    this.cookie = '';
    this.proxy = null;this.resourceCache.clear();this.directOrigins.clear();this.routeStats={relay:0,direct:0,fallback:0};
    this.pendingNavigation = null;
    this.pageLoad=null;this.pageStatus=null;this.loadBatchRemaining=null;this.renderPending=[];this.renderFailed.clear();
    this.renderAssets=new Map();if(activeResourceSession===this)clear_resources();activeResourceSession=null;
    this.viewport={w:1024,h:768};
    this.layoutReads=0;
    this.navigationEntries=[];this.navigationIndex=-1;this.pendingHistoryIndex=null;this.pendingDynamicImports=[];
    this.modCache.clear();
    this.modCacheBytes = 0;
    this.modCacheHits = 0;
    this.modCacheFetches = 0;
    return { ok: true };
  }

  async fetch(request) {
    return this.withOperation(()=>this.handleRequest(request));
  }

  async handleRequest(request) {
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
        if(u.searchParams.has('proxy'))this.configureProxy(u.searchParams.get('proxy'));
        else if(u.searchParams.has('proxy_ip')||u.searchParams.has('proxy_port'))this.configureProxy({ip:u.searchParams.get('proxy_ip'),port:Number(u.searchParams.get('proxy_port'))});
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
      if(request.method==='POST'&&path==='/continue'){
        const body=await request.json();return Response.json(await this.continueLoading(body));
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
        const { png, finalUrl, bytes, jsInfo } = await this.shot({ url: body.url, w: Math.min(body.w || 1024, 1920), h: Math.min(body.h || 768, 4096), js: !!body.js, translate, fit: body.fit });
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
          durableObjectId:this.ctx.id?.toString()||null,engineMemory:this.engine?.memoryStats()||null,
          proxy:publicProxy(this.proxy),loading:this.loadingState(),resourceCache:this.resourceCache.stats(),routes:this.routeStats,
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
