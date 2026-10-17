// cdp.js — 标准 CDP（Chrome DevTools Protocol）端点：DO 内 WS + 状态机。
// 目标：未经修改的 puppeteer-core / chrome-remote-interface 经公网 wss 直连驱动。
// 能力映射（全部复用 session.js 现成实现，本文件只做协议适配）：
//   Page.navigate         → hostFetch HTML → runPageScripts → load 事件序列
//   Runtime.evaluate      → __cdp 助手包 async IIFE 间接 eval（Promise 自动 settle）
//   Runtime.callFunctionOn→ 同上，functionDeclaration 直接调用 + 参数内联
//   Page.captureScreenshot→ __dom_html() → paint() → base64
//   console/exception     → outbox 任务 → Runtime.consoleAPICalled / exceptionThrown
// 未知方法一律回 {result:{}} 不卡握手（puppeteer 25.x 握手序列见 wasmbrowser README「CDP 方法集」）。

import { requestHeaders, BROWSER_UA, CHROME_FULL, CHROME_MAJOR } from './fingerprint.js';

const TARGET_ID = 'page-1';
const FRAME_ID = 'frame-1';
const BROWSER_CONTEXT_ID = 'bc-1';
const EVAL_TIMEOUT_MS = 8000;

function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return '://'; }
}

export class CdpConnection {
  /** @param session QjsSession 实例（引擎宿主） @param ws server 端 WebSocket */
  constructor(session, ws) {
    this.session = session;
    this.ws = ws;
    this.session.cdpConns.add(this);
    // flatten 客户端标记：发过带 sessionId 的帧 → 事件原样带 sessionId；
    // 裸会话客户端（CRI）→ 事件剥掉 sessionId（否则它按会话路由会丢弃）
    this.clientFlatten = false;
    this.sessionSid = null; // attachedToTarget 时分配
    this.pageEnabled = false;
    this.runtimeEnabled = false;
    this.lifecycleEnabled = false;
    this.metrics = { width: 1024, height: 768 };
    this.navSeq = 0;
    this.scriptExecutionDisabled = null;
    this.ctxSeq = 0;
    this.contextId = 0;
    this.earlyScriptSeq = 0;
    this.exceptionSeq = 0;
    // 发送串行链 + 2ms 错峰：响应与事件同一同步批次 back-to-back send 会被合并进同一
    // TCP 段，实测 puppeteer 25.x 的 ws 解析在这种合并段上会丢第二帧（见 wasmbrowser）
    this.sendChain = Promise.resolve();
    // per-connection 串行处理队列：CDP 消息一条处理完再下一条
    this.chain = Promise.resolve();
    this.closed = false;
    // 响应帧之后再发的事件回调（Chrome 语义：响应先于事件）
    this.afterRespond = [];
  }

  // ---------- WS 生命周期 ----------
  onMessage(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch (e) {
      this.#send({ id: null, error: { code: -32700, message: 'parse error: ' + (e?.message || e) } });
      return;
    }
    if (frame && frame.sessionId !== undefined) this.clientFlatten = true;
    this.chain = this.chain.then(() => this.session.withOperation(()=>this.#handleFrame(frame))).catch((e) => {
      if (frame && frame.id != null) {
        this.#send({ id: frame.id, error: { code: -32000, message: String((e && e.message) || e) } });
      }
    });
  }

  requestNavigation() {
    this.chain=this.chain.then(()=>this.session.withOperation(async()=>{
      for(let n=0;this.session.pendingNavigation&&n<8;n++){
        const url=this.session.pendingNavigation;this.session.pendingNavigation=null;
        const result=await this.#navigate({url});
        if(result.errorText)throw new Error(result.errorText);
      }
      const callbacks=this.afterRespond.splice(0);for(const cb of callbacks)cb();
    })).catch(e=>{this.session.pushLog('[navigation-error] '+e.message);});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.cdpConns.delete(this);
  }

  // ---------- 发送（串行链 + 2ms 错峰） ----------
  #send(frame) {
    this.sendChain = this.sendChain.then(async () => {
      await new Promise((r) => setTimeout(r, 2));
      try { this.ws.send(JSON.stringify(frame)); } catch (e) { /* 已关闭则忽略 */ }
    });
  }

  #result(id, result) {
    if (id == null) return;
    this.#send({ id, result: result === undefined ? {} : result });
  }

  #error(id, code, message) {
    if (id == null) return;
    this.#send({ id, error: { code, message } });
  }

  /**
   * 事件发送。isSessionEvent=true 表示属于 page 会话的事件（Runtime/Page 域）：
   * flatten 客户端（发过带 sessionId 的帧）要求顶层带 sessionId 才能路由进会话；
   * 裸会话客户端（CRI）剥掉。Browser/Target 级事件（targetCreated、attachedToTarget）
   * 永不带顶层 sessionId——flatten 的 attachedToTarget 的 sessionId 只能在 params 里，
   * 否则 puppeteer 的 Connection 会把它吞进会话，浏览器级 TargetManager 收不到，
   * target 永远注册不上（实测 newPage 30s 超时的根因）。
   */
  emit(method, params, isSessionEvent = false) {
    const f = { method, params };
    if (isSessionEvent && this.clientFlatten && this.sessionSid) f.sessionId = this.sessionSid;
    this.#send(f);
  }

  // ---------- 会话任务（console/exception）转发 ----------
  onSessionTask(t) {
    if (!this.runtimeEnabled) return;
    if (t.kind === 'console') {
      this.emit('Runtime.consoleAPICalled', {
        type: t.payload.level || 'log',
        args: [{ type: 'string', value: String(t.payload.text ?? '') }],
        executionContextId: this.contextId,
        timestamp: Date.now(),
        stackTrace: { callFrames: [] },
      }, true);
    } else if (t.kind === 'exception') {
      const msg = String(t.payload.message || 'unknown exception');
      this.emit('Runtime.exceptionThrown', {
        timestamp: Date.now(),
        exceptionDetails: {
          exceptionId: ++this.exceptionSeq,
          text: 'Uncaught',
          lineNumber: 0,
          columnNumber: 0,
          exception: { type: 'string', value: msg, description: msg },
        },
      }, true);
    }
  }

  // ---------- 帧处理 ----------
  async #handleFrame(frame) {
    const { id, method } = frame;
    if (!method) return; // 客户端响应帧，忽略
    const params = frame.params || {};
    try {
      // Browser.close 特殊：先回包再断连
      if (method === 'Browser.close') {
        this.#result(id, {});this.session.reset();
        setTimeout(() => { try { this.ws.close(1000, 'Browser.close'); } catch (e) { /* ignore */ } }, 50);
        return;
      }
      this.session.layoutReads=0;
      const handler = this.#handlers[method];
      if(!handler && /^(Input|DOM)\./.test(method))throw new Error('unsupported CDP method: '+method);
      const result = handler ? await handler.call(this, params, frame) : {};
      for(let n=0;this.session.pendingNavigation&&n<8;n++){const url=this.session.pendingNavigation;this.session.pendingNavigation=null;const nav=await this.#navigate({url});if(nav.errorText)throw new Error('navigation failed: '+nav.errorText);}
      if(this.session.pendingNavigation)throw new Error('navigation chain limit exceeded');
      this.#result(id, result);
      // 响应已排队，现在才把挂起的事件排进发送链（顺序：响应 → 事件）
      if (this.afterRespond.length) {
        const fns = this.afterRespond.splice(0);
        for (const f of fns) { try { f(); } catch (e) { /* 忽略 */ } }
      }
    } catch (e) {
      this.#error(id, -32000, method + ' failed: ' + String((e && e.message) || e));
    }
  }

  // ---------- target / frame 元数据 ----------
  targetInfo(attached, targetId = TARGET_ID) {
    return {
      targetId,
      type: 'page',
      title: '',
      url: this.session.url || 'about:blank',
      attached: !!attached,
      canAccessOpener: false,
      browserContextId: BROWSER_CONTEXT_ID,
    };
  }

  frameJson(loaderId) {
    return {
      id: FRAME_ID,
      loaderId: loaderId || this.loaderId || '',
      url: this.session.url || 'about:blank',
      securityOrigin: originOf(this.session.url || ''),
      mimeType: 'text/html',
    };
  }

  nextContext(isDefault) {
    this.contextId = ++this.ctxSeq;
    return this.contextId;
  }

  emitContextDestroyedAndCleared() {
    if (!this.runtimeEnabled || !this.contextId) return;
    this.emit('Runtime.executionContextDestroyed', { executionContextId: this.contextId }, true);
    this.emit('Runtime.executionContextsCleared', {}, true);
  }

  emitContextCreated(isDefault) {
    if (!this.runtimeEnabled) return;
    const ctxId = this.nextContext(isDefault);
    this.emit('Runtime.executionContextCreated', {
      context: {
        id: ctxId,
        origin: originOf(this.session.url || ''),
        name: '',
        uniqueId: 'ctx-' + ctxId,
        auxData: { frameId: FRAME_ID, isDefault: !!isDefault },
      },
    }, true);
  }

  // ---------- 求值核心 ----------
  async #evalWrapped(code) {
    // 包成 async IIFE 间接 eval：完成值 = 代码完成值；Promise 经 await 自动 settle；
    // var/函数声明落 globalThis（间接 eval = 全局作用域，多次 evaluate 状态互通）
    const wrapper =
      '__cdp_begin();(async()=>{try{var __v=await((0,eval)(' +
      JSON.stringify(code) +
      '));__cdp_ok(__cdp_json(__v));}catch(__e){__cdp_fail(String(__e&&(__e.message||__e)));}})();';
    const eng = this.session.engine;
    eng.callGlobal('eval', wrapper);
    const deadline = Date.now() + EVAL_TIMEOUT_MS;
    for (;;) {
      this.session.pump();
      if(this.session.pendingDynamicImports?.length)await this.session.advanceDynamicImports();
      const g = eng.callGlobal('__cdp_get');
      let res;
      try { res = JSON.parse(g.value || '{"done":false}'); } catch (e) { res = { done: false }; }
      if (res.done) return res;
      if (Date.now() > deadline) return { done: true, ok: false, error: 'evaluation timed out' };
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  #unserializableToLiteral(u) {
    switch (u) {
      case 'undefined': return 'undefined';
      case 'NaN': return 'NaN';
      case 'Infinity': return 'Infinity';
      case '-Infinity': return '-Infinity';
      case '-0': return '-0';
      default: return 'undefined';
    }
  }

  #toRemoteObject(jsonStr) {
    if (jsonStr === '\u0000__undef__') return { type: 'undefined' };
    if (typeof jsonStr === 'string' && jsonStr.startsWith('\u0000__num__')) {
      const u = jsonStr.slice(8);
      return { type: 'number', unserializableValue: u, description: u };
    }
    let v;
    try { v = JSON.parse(jsonStr); } catch (e) {
      return { type: 'string', value: String(jsonStr), description: String(jsonStr) };
    }
    switch (typeof v) {
      case 'string': return { type: 'string', value: v, description: v };
      case 'number': return { type: 'number', value: v, description: String(v) };
      case 'boolean': return { type: 'boolean', value: v };
      default: {
        if (v === null) return { type: 'object', subtype: 'null', className: 'null', value: null, description: 'null' };
        if (Array.isArray(v)) return { type: 'object', className: 'Array', description: 'Array(' + v.length + ')', value: v };
        return { type: 'object', className: 'Object', description: 'Object', value: v };
      }
    }
  }

  // ---------- 导航管线 ----------
  async #navigate(params) {
    const S = this.session;
    S.ensure();this.waitingForLoad=false;
    const url = String(params.url || 'about:blank');
    const loaderId = 'ld-' + (++this.navSeq).toString(36) + '-' + Date.now().toString(36);
    this.loaderId = loaderId;
    let html;
    let finalUrl = url;
    try {
      if (url === 'about:blank') {
        html = '<!DOCTYPE html><html><head></head><body></body></html>';
      } else if (/^data:text\/html/i.test(url)) {
        const idx = url.indexOf(',');
        html = idx >= 0 ? decodeURIComponent(url.slice(idx + 1)) : '';
        finalUrl = url;
      } else {
        // 顶层导航同样伪装成 Chrome：原先这里发
        // 'Mozilla/5.0 (quickjsbrowser/0.1; ...)'，等于在请求里自报「我是 QuickJS 浏览器」。
        // 也必须走 smartFetch：CDP 这条路原先漏了反代兜底，于是 Page.navigate 到
        // linux.do 拿到 403 挑战页 → 只返回 errorText 不抛错 → captureScreenshot
        // 截出一张空白图（实测 6.6KB），比报错还难查。
        const document=await S.fetchDocument(url);
        finalUrl=document.finalUrl;html=document.html;
      }
    } catch (e) {
      return { errorText: 'net::ERR_FAILED: '+String(e.message||e), frameId: FRAME_ID };
    }
    this.emit('Page.frameStartedLoading', { frameId: FRAME_ID }, true);
    // 页面脚本可能读 screen/innerWidth：视口信息要先于脚本派发（puppeteer 会先
    // Emulation.setDeviceMetricsOverride，故这里用当次 metrics）。
    S.dispatch({ kind: 'viewport', w: this.metrics.width || 1024, h: this.metrics.height || 768 });
    try {
      await S.runPageScripts(html, finalUrl, { serialize: false, executeScripts:this.scriptExecutionDisabled===null?undefined:!this.scriptExecutionDisabled, viewport:{w:this.metrics.width||1024,h:this.metrics.height||768},resourceBatch:params.resourceBatch??32,historyIndex:params.historyIndex??S.pendingHistoryIndex });
      S.pendingHistoryIndex=null;
    } catch (e) {
      S.pushLog('[cdp-nav-error] ' + String((e && e.message) || e));
      return {errorText:'document initialization failed: '+String(e.message||e),frameId:FRAME_ID};
    }
    // 响应先回，再发事件序列（与 Chrome 一致：navigate 响应 → 生命周期事件）
    const loaderIdFinal = loaderId;
    this.afterRespond.push(() => {
      this.emitContextDestroyedAndCleared();
      this.emit('Page.frameNavigated', { frame: this.frameJson(loaderIdFinal) }, true);
      this.emitContextCreated(true);
      if(S.pageLoad?.pending){this.waitingForLoad=true;this.emit('Browser.loadingProgress',S.loadingState(),true);return;}
      if (this.lifecycleEnabled) {
        for (const name of ['init', 'DOMContentLoaded', 'load', 'networkIdle']) {
          this.emit('Page.lifecycleEvent', { frameId: FRAME_ID, loaderId: loaderIdFinal, name, timestamp: Date.now() }, true);
        }
      }
      this.emit('Page.loadEventFired', { frameId: FRAME_ID, loaderId: loaderIdFinal, timestamp: Date.now() }, true);
      this.emit('Page.frameStoppedLoading', { frameId: FRAME_ID }, true);
    });
    return { frameId: FRAME_ID, loaderId, loading:S.loadingState() };
  }

  onLoadingComplete() {
    if(!this.waitingForLoad)return;
    this.waitingForLoad=false;
    this.emit('Browser.loadingProgress',this.session.loadingState(),true);
    if(this.lifecycleEnabled)for(const name of ['DOMContentLoaded','load','networkIdle'])this.emit('Page.lifecycleEvent',{frameId:FRAME_ID,loaderId:this.loaderId,name,timestamp:Date.now()},true);
    this.emit('Page.loadEventFired',{timestamp:Date.now()},true);
    this.emit('Page.frameStoppedLoading',{frameId:FRAME_ID},true);
  }

  // ---------- 方法表 ----------
  #handlers = {
    'Input.dispatchMouseEvent':async function(params){
      if(!['mouseMoved','mousePressed','mouseReleased'].includes(params.type))throw new Error('unsupported mouse event');
      if(!Number.isFinite(params.x)||!Number.isFinite(params.y))throw new Error('mouse coordinates required');
      const S=this.session;S.ensure();
      const html=S.engine.callGlobal('__dom_html').value;
      await S.prepareLayout(html,S.url,this.metrics.width,this.metrics.height);
      const r=S.engine.callGlobal('__input_mouse',JSON.stringify(params));if(!r.ok)throw new Error(r.error||'input dispatch failed');S.pump();return {};
    },
    'Browser.getLoadingState':function(){return this.session.loadingState();},
    'Browser.continueLoading':async function(params){return this.session.continueLoading(params);},
    'Browser.setProxy':function(params){return {proxy:this.session.configureProxy(params.proxy??params.server??((params.ip||params.host)?params:null))};},
    // ---- Browser ----
    'Browser.getVersion': () => ({
      protocolVersion: '1.3',
      // 与 fingerprint.js 的 persona 同源：puppeteer 会把这个 UA 当 browser.userAgent()，
      // 也和页面 JS 侧 navigator.userAgent 一致 —— 三处报不同的身份就是自曝。
      product: `Chrome/${CHROME_FULL}`,
      revision: '@1f2c9e4a7b3d5c8e0a6f4b2d9c7e5a3f1b8d6c40',
      userAgent: BROWSER_UA,
      jsVersion: `${CHROME_MAJOR / 10}.0`,
    }),
    'Browser.getWindowForTarget': () => ({ windowId: 1 }),
    'Browser.getWindowBounds': () => ({
      windowBounds: { left: 0, top: 0, width: 1280, height: 900, windowState: 'normal' },
    }),

    // ---- Target（puppeteer 握手面） ----
    'Target.getBrowserContexts': () => ({ browserContextIds: [] }),
    // DrissionPage 5.x 的握手：先试 getBrowserContexts，响应里没有
    // defaultBrowserContextId 就退回 getTargets，并直接读 targetInfos[0].browserContextId。
    // 缺这个方法会走「未知方法回 {}」的兜底，导致它 KeyError 连不上。
    'Target.getTargets': function () {
      return { targetInfos: [this.targetInfo(false)] };
    },
    'Target.setDiscoverTargets': function () {
      this.afterRespond.push(() => this.emit('Target.targetCreated', { targetInfo: this.targetInfo(false) }));
      return {};
    },
    'Target.setAutoAttach': function (params, frame) {
      // 仅浏览器级 setAutoAttach（无顶层 sessionId）触发对已有 page target 的 attach。
      // 会话级 setAutoAttach（puppeteer 在 attachedToTarget 后会在新会话上再发一次）
      // 只attach 子 target——我们没有，回 {} 即可；否则会互相触发 attachedToTarget
      // → puppeteer 再发 setAutoAttach → 无限循环打爆连接（实测 36k+ 帧）。
      if (frame.sessionId !== undefined) return {};
      this.sessionSid = this.sessionSid || 's-page-1';
      const sid = this.sessionSid;
      this.afterRespond.push(() => {
        this.emit('Target.attachedToTarget', {
          sessionId: sid,
          targetInfo: this.targetInfo(true),
          waitingForDebugger: true,
        });
      });
      return {};
    },
    'Target.attachToTarget': function (params) {
      this.sessionSid = this.sessionSid || 's-page-1';
      const sid = this.sessionSid;
      this.afterRespond.push(() => {
        this.emit('Target.attachedToTarget', { sessionId: sid, targetInfo: this.targetInfo(true), waitingForDebugger: false });
      });
      return { sessionId: sid };
    },
    'Target.getTargetInfo': function (params) {
      return { targetInfo: this.targetInfo(true, params.targetId || TARGET_ID) };
    },
    'Target.createTarget': function (params) {
      // 单 DO = 单 page 引擎：新 target 复用同一页面，但 targetId/sessionId 必须全新
      //（puppeteer newPage 等 targetId 匹配的新 target 挂上来；复用旧 id 会撞 target 表）
      const targetId = 'page-' + Date.now().toString(36) + '-' + (++this.navSeq);
      this.sessionSid = 's-' + targetId;
      const sid = this.sessionSid;
      const info = this.targetInfo.bind(this);
      this.afterRespond.push(() => {
        this.emit('Target.targetCreated', { targetInfo: info(false, targetId) });
        this.emit('Target.attachedToTarget', { sessionId: sid, targetInfo: info(true, targetId), waitingForDebugger: true });
      });
      return { targetId };
    },
    'Target.closeTarget': () => ({}),
    'Target.activateTarget': () => ({}),
    'Target.exposeDevToolsProtocol': () => ({}),

    // ---- Runtime ----
    'Runtime.enable': function () {
      this.runtimeEnabled = true;
      this.afterRespond.push(() => this.emitContextCreated(true));
      return {};
    },
    'Runtime.disable': function () { this.runtimeEnabled = false; return {}; },
    'Runtime.runIfWaitingForDebugger': () => ({}),
    'Runtime.addBinding': () => ({}),
    'Runtime.discardConsoleEntries': () => ({}),
    'Runtime.setMaxCallStackSizeToCapture': () => ({}),
    'Runtime.evaluate': async function (params) {
      if (params.objectId) throw new Error('objectId handles not supported');
      const res = await this.#evalWrapped(String(params.expression ?? ''));
      if (!res.ok) {
        return {
          result: { type: 'object', subtype: 'error', className: 'Error', description: res.error, value: res.error },
          exceptionDetails: {
            exceptionId: ++this.exceptionSeq,
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
            exception: { type: 'string', value: res.error, description: res.error },
          },
        };
      }
      return { result: this.#toRemoteObject(res.json) };
    },
    'Runtime.callFunctionOn': async function (params) {
      if (params.objectId) throw new Error('objectId handles not supported');
      const fn = String(params.functionDeclaration || '');
      if (!fn) throw new Error('functionDeclaration required');
      const args = (params.arguments || []).map((a) => {
        if (a.objectId) throw new Error('objectId handles not supported');
        if (a.unserializableValue !== undefined) return this.#unserializableToLiteral(a.unserializableValue);
        return JSON.stringify(a.value);
      });
      const code = '(' + fn + ')(' + args.join(',') + ')';
      const res = await this.#evalWrapped(code);
      if (!res.ok) {
        return {
          result: { type: 'object', subtype: 'error', className: 'Error', description: res.error },
          exceptionDetails: {
            exceptionId: ++this.exceptionSeq,
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
            exception: { type: 'string', value: res.error, description: res.error },
          },
        };
      }
      return { result: this.#toRemoteObject(res.json) };
    },
    'Runtime.getProperties': () => ({ result: [], internalProperties: [] }),
    'Runtime.globalLexicalScopeNames': () => ({ names: [] }),

    // ---- Page ----
    'Page.enable': function () {
      this.pageEnabled = true;
      this.afterRespond.push(() => this.emit('Page.frameNavigated', { frame: this.frameJson() }, true));
      return {};
    },
    'Page.disable': function () { this.pageEnabled = false; return {}; },
    'Page.getFrameTree': function () {
      return { frameTree: { frame: this.frameJson(), childFrames: [] } };
    },
    'Page.setLifecycleEventsEnabled': function (params) {
      this.lifecycleEnabled = !!params.enabled;
      return {};
    },
    'Emulation.setScriptExecutionDisabled': function (params) {
      this.scriptExecutionDisabled=!!params.value;return {};
    },
    'Page.navigate': function (params) { return this.#navigate(params); },
    'Page.getNavigationHistory': function(){return {currentIndex:this.session.navigationIndex,entries:this.session.navigationEntries.map(({state,...entry})=>entry)};},
    'Page.navigateToHistoryEntry': async function(params){const index=this.session.navigationEntries.findIndex(e=>e.id===params.entryId);if(index<0)throw new Error('Unknown history entry');const nav=await this.#navigate({url:this.session.navigationEntries[index].url,historyIndex:index});if(nav.errorText)throw new Error(nav.errorText);return {};},
    'Page.addScriptToEvaluateOnNewDocument': function (params) {
      const S = this.session;
      if (!S.cdpEarlyScripts) S.cdpEarlyScripts = [];
      const identifier = 'es-' + (++this.earlyScriptSeq);
      S.cdpEarlyScripts.push({ id: identifier, src: String(params.source || '') });
      return { identifier };
    },
    'Page.removeScriptToEvaluateOnNewDocument': function (params) {
      const S = this.session;
      if (S.cdpEarlyScripts) S.cdpEarlyScripts = S.cdpEarlyScripts.filter((s) => s.id !== params.identifier);
      return {};
    },
    'Page.createIsolatedWorld': function () {
      const ctxId = this.nextContext(false);
      this.afterRespond.push(() => {
        this.emit('Runtime.executionContextCreated', {
          context: {
            id: ctxId, origin: originOf(this.session.url || ''), name: 'utility-world',
            uniqueId: 'ctx-' + ctxId, auxData: { frameId: FRAME_ID, isDefault: false },
          },
        }, true);
      });
      return { executionContextId: ctxId };
    },
    'Page.captureScreenshot': async function () {
      const S = this.session;
      S.ensure();
      const g = S.engine.callGlobal('__dom_html');
      const html = g.ok && g.value ? g.value : '<html><head></head><body></body></html>';
      const w = Math.min(this.metrics.width || 1024, 1920);
      const h = Math.min(this.metrics.height || 768, 4096);
      const png = await S.paint(html, S.url || 'about:blank', w, h);
      return { data: toB64(png) };
    },
    'Page.getLayoutMetrics': function () {
      const w = this.metrics.width, h = this.metrics.height;
      const vv = { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: w, clientHeight: h, scale: 1, zoom: 1 };
      return {
        layoutViewport: { pageX: 0, pageY: 0, clientWidth: w, clientHeight: h },
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: w, clientHeight: h },
        visualViewport: vv,
        cssVisualViewport: vv,
        contentSize: { x: 0, y: 0, width: w, height: h },
        cssContentSize: { x: 0, y: 0, width: w, height: h },
      };
    },
    'Page.setDocumentContent': () => ({}),
    'Page.bringToFront': () => ({}),
    'Page.setBypassCSP': () => ({}),
    'Page.setInterceptFileChooserDialog': () => ({}),
    'Page.setDeviceMetricsOverride': function (params) { return this.#handlers['Emulation.setDeviceMetricsOverride'].call(this, params); },
    'Page.startScreencast': () => ({}),
    'Page.stopScreencast': () => ({}),
    'Page.handleJavaScriptDialog': () => ({}),

    // ---- Emulation ----
    'Emulation.setDeviceMetricsOverride': function (params) {
      if (Number(params.width) > 0) this.metrics.width = Number(params.width);
      if (Number(params.height) > 0) this.metrics.height = Number(params.height);
      this.session.viewport={w:this.metrics.width,h:this.metrics.height};
      if(this.session.engine)this.session.dispatch({kind:'viewport',...this.session.viewport});
      return {};
    },
    'Emulation.clearDeviceMetricsOverride': function () {
      this.metrics = { width: 1024, height: 768 };
      this.session.viewport={w:1024,h:768};
      if(this.session.engine)this.session.dispatch({kind:'viewport',...this.session.viewport});
      return {};
    },
    'Emulation.setUserAgentOverride': () => ({}),
    'Emulation.setFocusEmulationEnabled': () => ({}),
    'Emulation.setLocaleOverride': () => ({}),
    'Emulation.setTimezoneOverride': () => ({}),

    // ---- Network / Log / Performance / Audits / 其它常开域 ----
    'Network.enable': () => ({}),
    'Network.disable': () => ({}),
    'Network.setUserAgentOverride': () => ({}),
    'Network.setCacheDisabled': () => ({}),
    'Network.setBypassServiceWorker': () => ({}),
    'Network.emulateNetworkConditions': () => ({}),
    'Log.enable': () => ({}),
    'Log.disable': () => ({}),
    'Log.startViolationsReport': () => ({}),
    'Performance.enable': () => ({}),
    'Performance.disable': () => ({}),
    'Performance.getMetrics': () => ({ metrics: [{ name: 'JSHeapUsedSize', value: 0 }, { name: 'Documents', value: 1 }] }),
    'Audits.enable': () => ({}),
    'Audits.disable': () => ({}),
    'HeapProfiler.enable': () => ({}),
    'HeapProfiler.disable': () => ({}),
    'Console.enable': () => ({}),
    'Console.disable': () => ({}),
    'Debugger.enable': () => ({ debuggerId: 'dbg-quickjsbrowser-1' }),
    'Debugger.disable': () => ({}),
    'Debugger.setAsyncCallStackDepth': () => ({}),
    'Debugger.setMaxCallStackSizeToCapture': () => ({}),
    'Debugger.setBreakpointsActive': () => ({}),
    'DOM.enable': () => ({}),
    'DOM.disable': () => ({}),
    'DOM.getFlattenedDocument': () => ({ nodes: [] }),
    'CSS.enable': () => ({}),
    'CSS.disable': () => ({}),
    'Overlay.enable': () => ({}),
    'Overlay.disable': () => ({}),
    'Tracing.start': () => ({}),
    'Tracing.end': () => ({}),
  };
}
