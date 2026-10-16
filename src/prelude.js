// prelude.js — 注入 QuickJS VM 的宿主面（字符串，engine.js 在 qjs_new 后立即 eval）。
// 设计同 wasmbrowser 的 js.rs setup 段 + remoteagent 的 SHIMS，但跑在 QuickJS 里：
// 页面只见标准浏览器全局；与宿主的全部通信走两条窄通道：
//   VM→宿主：__hostEnqueue(kind, payloadJson)（C 侧 outbox，发后即忘）
//   宿主→VM：__dispatch(blob)（blob = JSON.stringify({kind, ...})，C 侧 call_global 直通字符串）
// 注意：本文件是 VM 内代码，不能用 QuickJS 没有的 Web API（无 URL、无 TextEncoder）。
//
// 指纹（navigator / screen / window.chrome / plugins …）**全部来自 fingerprint.js**，
// 与出站 HTTP 头同源。这不是洁癖：反爬检测的核心手段是「跨接口对不上」——
// 请求头说 Chrome 151 + macOS，JS 里 navigator.platform 却是 Linux、userAgentData.brands
// 与 sec-ch-ua 不一致、window.chrome 不存在（无头特征），任何一条都能单独判定为机器人。
// 参考实现 Chromix 的 P0 校验就是逐字段比对 HTTP 头与 JS 值（见 fingerprint.js 头注释）。
import {
  BROWSER_UA, NAVIGATOR_PLATFORM, CH_PLATFORM, LANGUAGES, HARDWARE_CONCURRENCY,
  DEVICE_MEMORY, UA_DATA_BRANDS, CHROME_FULL, CHROME_MAJOR,
} from './fingerprint.js';

// 静态字面量在宿主侧算好再注入：一是避免在 VM 里手抄常量导致两处漂移，
// 二是 JSON.stringify 保证引号/反斜杠转义正确（UA 里有括号和斜杠）。
const NAV_LITERAL = JSON.stringify({
  userAgent: BROWSER_UA,
  // 真实 Chrome 的 appVersion = UA 去掉开头的 "Mozilla/"（实测）
  appVersion: BROWSER_UA.replace(/^Mozilla\//, ''),
  appCodeName: 'Mozilla',
  appName: 'Netscape',
  product: 'Gecko',
  productSub: '20030107',
  vendor: 'Google Inc.',
  vendorSub: '',
  platform: NAVIGATOR_PLATFORM,
  language: LANGUAGES[0],
  languages: LANGUAGES,
  // deviceMemory 真实 Chrome 上限就是 8，超过一律报 8
  hardwareConcurrency: HARDWARE_CONCURRENCY,
  deviceMemory: DEVICE_MEMORY,
  maxTouchPoints: 0,
  cookieEnabled: true,
  onLine: true,
  webdriver: false,
  pdfViewerEnabled: true,
  doNotTrack: null,
  globalPrivacyControl: false,
});
// navigator.userAgentData 的 JS 值必须与出站 sec-ch-ua 完全一致（Chromix 的 P0 校验项）
const UADATA_LITERAL = JSON.stringify({ brands: UA_DATA_BRANDS, mobile: false, platform: CH_PLATFORM });
// fullVersionList 用完整版本号，GREASE 那条按规范补成 x.0.0.0（Chromium 源码即如此）
const UADATA_FULL_LITERAL = JSON.stringify(UA_DATA_BRANDS.map((b) => ({
  brand: b.brand,
  version: b.version.length <= 2 ? `${b.version}.0.0.0` : CHROME_FULL,
})));

export const PRELUDE = String.raw`
(() => {
  'use strict';
  const enqueue = (kind, payload) =>
    __hostEnqueue(kind, payload === undefined ? undefined : JSON.stringify(payload));

  // ---- base64（QuickJS 核心无 atob/btoa；linkedom 等库探测 atob 优先） ----
  const B64CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  globalThis.btoa = (s) => {
    const C = B64CH;
    let o = '';
    s = String(s);
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN, c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
      o += C[a >> 2] + C[((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4)] + (isNaN(b) ? '=' : C[((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6)]) + (isNaN(c) ? '=' : C[c & 63]);
    }
    return o;
  };
  globalThis.atob = (s) => {
    const B = {};
    for (let i = 0; i < 64; i++) B[B64CH[i]] = i;
    s = String(s).replace(/=+$/, '');
    let o = '', bv = 0, bc = 0;
    for (const ch of s) {
      bv = (bv << 6) | (B[ch] || 0);
      bc += 6;
      if (bc >= 8) { bc -= 8; o += String.fromCharCode((bv >> bc) & 255); }
    }
    return o;
  };

  // ---- console（转发 Runtime 语义的 console 事件给宿主） ----
  const fmt = (a) => a.map((x) => {
    try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
  }).join(' ');
  globalThis.console = {
    log: (...a) => enqueue('console', { level: 'log', text: fmt(a) }),
    info: (...a) => enqueue('console', { level: 'info', text: fmt(a) }),
    warn: (...a) => enqueue('console', { level: 'warning', text: fmt(a) }),
    error: (...a) => enqueue('console', { level: 'error', text: fmt(a) }),
    debug: (...a) => enqueue('console', { level: 'debug', text: fmt(a) }),
    trace: (...a) => enqueue('console', { level: 'debug', text: fmt(a) }),
  };

  // ---- 定时器：VM 侧登记 + 出队排期，到期宿主回喂 timer_fire ----
  let tid = 0;
  const timers = new Map();
  const armTimer = (fn, ms, interval) => {
    const id = ++tid;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { fn, delay, interval: !!interval });
    enqueue('timer', { id, delay, interval: !!interval });
    return id;
  };
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (typeof fn !== 'function') return 0;
    return armTimer(() => fn(...rest), ms, false);
  };
  globalThis.setInterval = (fn, ms, ...rest) => {
    if (typeof fn !== 'function') return 0;
    return armTimer(() => fn(...rest), ms, true);
  };
  globalThis.clearTimeout = (id) => { timers.delete(Number(id)); };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.requestAnimationFrame = (fn) => (typeof fn === 'function' ? armTimer(fn, 16, false) : 0);
  globalThis.cancelAnimationFrame = (id) => { timers.delete(Number(id)); };

  // ---- fetch：Promise + 出队代抓，落定靠 fetch_resolve ----
  let fid = 0;
  const pendingFetch = new Map();
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const opts = init || {};
    const id = ++fid;
    const signal = opts.signal || (input && input.signal);
    if (signal && signal.aborted) {
      return Promise.reject(signal.reason || new TypeError('The operation was aborted'));
    }
    return new Promise((resolve, reject) => {
      pendingFetch.set(id, { resolve, reject });
      enqueue('fetch', {
        id,
        url,
        method: (opts.method || 'GET').toUpperCase(),
        headers: opts.headers || {},
        body: opts.body != null ? String(opts.body) : null,
      });
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => {
          if (pendingFetch.delete(id)) reject(signal.reason || new TypeError('The operation was aborted'));
        });
      }
    });
  };
  const mkResp = (r) => {
    const body = r.text != null ? r.text : null;
    const bin = r.base64 != null ? r.base64 : null;
    return {
      ok: !!r.ok, status: r.status || 0, statusText: r.statusText || '',
      url: r.url || '', headers: r.headers || {},
      text: () => Promise.resolve(body != null ? body : ''),
      json: () => Promise.resolve(body != null ? JSON.parse(body) : null),
      arrayBuffer: () => {
        if (bin == null) return Promise.resolve(new ArrayBuffer(0));
        const s = atob(bin); const u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return Promise.resolve(u.buffer);
      },
    };
  };

  // ---- location / history / navigator ----
  let locUrl = 'about:blank';
  // URL 类在本文件后面才定义（浏览器别名段之前），故运行时惰性取。
  const URLCls = () => globalThis.URL;
  const part = (k) => {
    // 优先走标准 URL 解析（覆盖百分号编码 / 端口默认化 / 非 http 协议等
    // 正则扛不住的边界）；about:blank 等不能被 URL 解析的退回旧正则。
    const U = URLCls();
    if (U && U.canParse(locUrl)) {
      try {
        const u = new U(locUrl);
        switch (k) {
          case 'href': return u.href;
          case 'protocol': return u.protocol;
          case 'host': return u.hostname + (u.port ? ':' + u.port : '');
          case 'hostname': return u.hostname;
          case 'port': return u.port || '';
          case 'origin': return u.origin;
          case 'pathname': return u.pathname;
          case 'search': return u.search;
          case 'hash': return u.hash;
          default: return '';
        }
      } catch (e) { /* 落到正则 */ }
    }
    const m = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)?(\?[^#]*)?(#.*)?/.exec(locUrl) || [];
    const origin = m[1] && m[2] ? m[1] + '://' + m[2] : '';
    switch (k) {
      case 'href': return locUrl;
      case 'protocol': return (m[1] || 'about') + ':';
      case 'host': return m[2] || '';
      case 'hostname': return (m[2] || '').split(':')[0];
      case 'port': return ((m[2] || '').split(':')[1]) || '';
      case 'origin': return origin || 'null';
      case 'pathname': return m[3] != null ? m[3] : (m[1] === 'about' ? 'blank' : '/');
      case 'search': return m[4] || '';
      case 'hash': return m[5] || '';
      default: return '';
    }
  };
  const loc = {};
  Object.defineProperty(loc, 'href', {
    get: () => part('href'),
    set: (v) => { enqueue('navigate', { url: String(v) }); },
    configurable: true,
  });
  for (const k of ['origin', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'protocol']) {
    Object.defineProperty(loc, k, { get: () => part(k), configurable: true });
  }
  loc.reload = () => enqueue('navigate', { url: locUrl, reload: true });
  loc.assign = (u) => enqueue('navigate', { url: String(u) });
  loc.replace = (u) => enqueue('navigate', { url: String(u), replace: true });
  Object.defineProperty(globalThis, 'location', { value: loc, configurable: true, writable: true });

  // ---- navigator ----
  // 值全部来自 fingerprint.js 注入的字面量（与出站请求头同源，见文件头注释）。
  // 用 class 而不是裸对象：页面会读 navigator.constructor.name / navigator instanceof Navigator，
  // 裸对象这两项直接暴露"这是手搓的"。
  class Navigator {}
  globalThis.Navigator = Navigator;
  globalThis.navigator = Object.assign(new Navigator(), ${NAV_LITERAL});
  navigator.javaEnabled = () => false;
  navigator.sendBeacon = () => true;      // 真浏览器返回 true（已排队）；没有它部分埋点脚本会抛
  navigator.getGamepads = () => [];
  navigator.vibrate = () => false;        // 桌面 Chrome 有这个函数（空操作）
  navigator.getBattery = () => Promise.resolve({
    charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1,
    onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null,
    addEventListener() {}, removeEventListener() {},
  });
  navigator.registerProtocolHandler = () => {};
  navigator.unregisterProtocolHandler = () => {};
  navigator.requestMIDIAccess = () => Promise.reject(new Error('NotSupportedError'));
  navigator.getInstalledRelatedApps = () => Promise.resolve([]);
  navigator.canLoadAdAuctionFencedFrame = () => false;
  navigator.clearAppBadge = () => Promise.resolve();
  navigator.setAppBadge = () => Promise.resolve();
  // 桌面 Chrome 常见的能力对象：检测脚本大量做 typeof 存在性判断。
  // 形状尽量贴真实实现，取不到真值的一律给"合理的空/默认值"而不是 undefined。
  navigator.clipboard = {
    readText: () => Promise.reject(new Error('NotAllowedError')),
    writeText: () => Promise.resolve(),
    read: () => Promise.reject(new Error('NotAllowedError')),
    write: () => Promise.resolve(),
  };
  navigator.locks = {
    request: (_n, o, cb) => {
      // 真签名允许 request(name, callback)
      const fn = typeof o === 'function' ? o : cb;
      if (typeof fn !== 'function') return Promise.reject(new TypeError('callback required'));
      return Promise.resolve(fn({ name: _n, mode: 'exclusive' }));
    },
    query: () => Promise.resolve({ held: [], pending: [] }),
  };
  navigator.serviceWorker = { controller: null, ready: new Promise(() => {}), register: () => Promise.reject(new Error('NotSupportedError')), addEventListener() {}, getRegistrations: () => Promise.resolve([]) };
  navigator.scheduling = { isInputPending: () => false };
  navigator.userActivation = { isActive: false, hasBeenActive: false };
  navigator.credentials = {
    get: () => Promise.resolve(null), store: () => Promise.resolve(null),
    create: () => Promise.resolve(null), preventSilentAccess: () => Promise.resolve(),
  };
  navigator.geolocation = {
    getCurrentPosition: (_ok, err) => { if (typeof err === 'function') err({ code: 1, message: 'User denied Geolocation' }); },
    watchPosition: () => 0, clearWatch: () => {},
  };
  navigator.mediaCapabilities = {
    decodingInfo: () => Promise.resolve({ supported: false, smooth: false, powerEfficient: false }),
    encodingInfo: () => Promise.resolve({ supported: false, smooth: false, powerEfficient: false }),
  };
  navigator.mediaDevices = {
    enumerateDevices: () => Promise.resolve([]),
    getUserMedia: () => Promise.reject(new Error('NotAllowedError')),
    addEventListener() {}, removeEventListener() {}, getSupportedConstraints: () => ({}),
  };
  navigator.mediaSession = { metadata: null, playbackState: 'none', setActionHandler() {}, setPositionState() {} };
  navigator.keyboard = { getLayoutMap: () => Promise.resolve(new Map()), lock: () => Promise.resolve(), unlock() {} };
  navigator.storageBuckets = { keys: () => Promise.resolve([]), open: () => Promise.reject(new Error('NotSupportedError')) };
  navigator.userAgentData = Object.assign(${UADATA_LITERAL}, {
    toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
    // 高熵值只有站点带 Accept-CH 主动要才会发；这里按 persona 的稳定值回答，
    // 保证「同一次会话反复问结果一致」（随机化反而会被判定为伪装）。
    getHighEntropyValues: (hints) => {
      const all = {
        architecture: 'x86', bitness: '64', model: '', platformVersion: '15.7.0',
        uaFullVersion: ${JSON.stringify(CHROME_FULL)},
        fullVersionList: ${UADATA_FULL_LITERAL},
        wow64: false,
      };
      const out = { brands: this.brands, mobile: this.mobile, platform: this.platform };
      for (const h of Array.isArray(hints) ? hints : []) if (h in all) out[h] = all[h];
      return Promise.resolve(out);
    },
  });

  // ---- navigator.plugins / mimeTypes ----
  // 实测真 Chrome 固定 5 个 PDF 插件（同名 internal-pdf-viewer）和 2 个 MIME 类型，
  // 且插件长度由 Chrome 版本决定、与操作系统无关。空数组是经典无头特征。
  class MimeType {
    constructor(type, suffixes, description, enabledPlugin) {
      this.type = type; this.suffixes = suffixes; this.description = description; this.enabledPlugin = enabledPlugin;
    }
  }
  class Plugin {
    constructor(name, filename, description, mimeTypes) {
      this.name = name; this.filename = filename; this.description = description;
      mimeTypes.forEach((m, i) => { this[i] = m; });
      this.length = mimeTypes.length;
    }
    item(i) { return this[i] || null; }
    namedItem(n) { for (let i = 0; i < this.length; i++) if (this[i].type === n) return this[i]; return null; }
  }
  class PluginArray {
    constructor(plugins) {
      plugins.forEach((p, i) => { this[i] = p; });
      this.length = plugins.length;
    }
    item(i) { return this[i] || null; }
    namedItem(n) { for (let i = 0; i < this.length; i++) if (this[i].name === n) return this[i]; return null; }
    refresh() {}
  }
  class MimeTypeArray {
    constructor(mimes) {
      mimes.forEach((m, i) => { this[i] = m; });
      this.length = mimes.length;
    }
    item(i) { return this[i] || null; }
    namedItem(n) { for (let i = 0; i < this.length; i++) if (this[i].type === n) return this[i]; return null; }
  }
  // 先建 MimeType 占位（enabledPlugin 反向指回 Plugin，两边都要存在）
  const pdfPlugin = new Plugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', []);
  const pdfMimes = [new MimeType('application/pdf', 'pdf', 'Portable Document Format', pdfPlugin)];
  pdfMimes.push(new MimeType('text/pdf', 'pdf', 'Portable Document Format', pdfPlugin));
  for (const m of pdfMimes) pdfPlugin[pdfPlugin.length++] = m;
  globalThis.navigator.mimeTypes = new MimeTypeArray(pdfMimes);
  globalThis.navigator.plugins = new PluginArray([
    pdfPlugin,
    new Plugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', pdfMimes),
    new Plugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', pdfMimes),
    new Plugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', pdfMimes),
    new Plugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format', pdfMimes),
  ]);
  globalThis.PluginArray = PluginArray;
  globalThis.MimeTypeArray = MimeTypeArray;
  globalThis.Plugin = Plugin;
  globalThis.MimeType = MimeType;

  // ---- navigator.connection ----
  // 桌面 Chrome 有 effectiveType/rtt/downlink/saveData，**没有** type（type 只在
  // ChromeOS/Android 上存在）——加了反而是破绽。实测原型链确认。
  globalThis.navigator.connection = {
    onchange: null, effectiveType: '4g', rtt: 50, downlink: 10, saveData: false,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  };

  // ---- navigator.permissions ----
  // state 取值照实测真 Chrome 抄（不同 name 的真实状态不一样，一律 'prompt' 也是破绽）。
  const PERM_STATE = {
    geolocation: 'prompt', notifications: 'prompt', camera: 'prompt', microphone: 'prompt',
    'clipboard-read': 'prompt', 'clipboard-write': 'granted', 'background-sync': 'granted',
    'persistent-storage': 'prompt', 'screen-wake-lock': 'granted', accelerometer: 'granted',
    gyroscope: 'granted', magnetometer: 'granted', 'payment-handler': 'granted',
    'storage-access': 'granted', 'local-fonts': 'prompt', 'idle-detection': 'prompt',
    midi: 'prompt', 'periodic-background-sync': 'denied',
  };
  globalThis.navigator.permissions = {
    query(desc) {
      const name = desc && desc.name;
      const state = PERM_STATE[name];
      if (name === 'push') { const e = new Error('push is not supported'); e.name = 'NotSupportedError'; return Promise.reject(e); }
      // 真 Chrome 对未知权限名抛 TypeError（不是 Promise 拒绝），照抄
      if (!state) throw new TypeError("Failed to execute 'query' on 'Permissions': '" + name + "' is not a valid permission name.");
      return Promise.resolve({
        name, state, onchange: null,
        addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
      });
    },
    addEventListener() {}, removeEventListener() {},
  };

  // ---- navigator.storage ----
  globalThis.navigator.storage = {
    estimate: () => Promise.resolve({ quota: 268435456000, usage: 0, usageDetails: {} }),
    persist: () => Promise.resolve(false),
    persisted: () => Promise.resolve(false),
    getDirectory: () => Promise.resolve({ name: '', kind: 'directory' }),
  };

  // ---- 视口 / 屏幕 ----
  // 由宿主按本次截图/渲染的视口派发（shot() 里 dispatch({kind:'viewport'})）。
  // 屏幕尺寸必须与渲染视口自洽：innerWidth == 屏幕宽、outerHeight > innerHeight
  // （真实窗口有浏览器边框），否则「屏幕 1920 但视口 1280 且窗口 1280」这类不闭合会被挑出来。
  const vp = { w: 1280, h: 900, dpr: 2 };
  const CHROME_H = 74;   // 标题栏 + 工具栏高度（macOS 上的典型值）
  const defGetter = (obj, k, get) => Object.defineProperty(obj, k, { get, enumerable: true, configurable: true });
  class Screen {}
  const scr = new Screen();
  Object.defineProperties(scr, {
    width: { get: () => vp.w, enumerable: true, configurable: true },
    height: { get: () => vp.h + CHROME_H, enumerable: true, configurable: true },
    availWidth: { get: () => vp.w, enumerable: true, configurable: true },
    availHeight: { get: () => vp.h + CHROME_H, enumerable: true, configurable: true },
    availLeft: { get: () => 0, enumerable: true, configurable: true },
    availTop: { get: () => 0, enumerable: true, configurable: true },
    colorDepth: { get: () => 24, enumerable: true, configurable: true },
    pixelDepth: { get: () => 24, enumerable: true, configurable: true },
    isExtended: { get: () => false, enumerable: true, configurable: true },
    orientation: {
      get: () => ({ type: 'landscape-primary', angle: 0, onchange: null, lock: () => Promise.resolve(), unlock() {} }),
      enumerable: true, configurable: true,
    },
    onchange: { get: () => null, set: () => {}, enumerable: true, configurable: true },
  });
  globalThis.screen = scr;
  globalThis.Screen = Screen;
  defGetter(globalThis, 'innerWidth', () => vp.w);
  defGetter(globalThis, 'innerHeight', () => vp.h);
  defGetter(globalThis, 'outerWidth', () => vp.w);
  defGetter(globalThis, 'outerHeight', () => vp.h + CHROME_H);
  defGetter(globalThis, 'devicePixelRatio', () => vp.dpr);
  defGetter(globalThis, 'screenX', () => 0);
  defGetter(globalThis, 'screenY', () => 0);
  defGetter(globalThis, 'screenLeft', () => 0);
  defGetter(globalThis, 'screenTop', () => 0);
  defGetter(globalThis, 'scrollX', () => 0);
  defGetter(globalThis, 'scrollY', () => 0);
  defGetter(globalThis, 'pageXOffset', () => 0);
  defGetter(globalThis, 'pageYOffset', () => 0);
  Object.defineProperty(globalThis, 'visualViewport', {
    value: {
      width: 0, height: 0, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1,
      onresize: null, onscroll: null, addEventListener() {}, removeEventListener() {},
    },
    enumerable: true, configurable: true, writable: true,
  });
  ;(() => {
    const vv = globalThis.visualViewport;
    defGetter(vv, 'width', () => vp.w);
    defGetter(vv, 'height', () => vp.h);
  })();
  globalThis.scrollTo = () => {};
  globalThis.scrollBy = () => {};
  globalThis.scroll = () => {};
  globalThis.moveTo = () => {};
  globalThis.moveBy = () => {};
  globalThis.resizeTo = () => {};
  globalThis.resizeBy = () => {};

  // ---- window.chrome ----
  // 无头/非 Chromium 内核最经典的一条破绽就是 window.chrome 不存在。
  // 实测真 Chrome 的 chrome 对象恰好三个键：app / csi / loadTimes
  // （chrome.runtime 只在装了扩展时才有，默认是 undefined——别乱加）。
  globalThis.chrome = {
    app: {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: () => null,
      getIsInstalled: () => false,
      runningState: () => 'cannot_run',
    },
    // 实测 loadTimes() 返回 13 个键，照抄
    loadTimes: () => ({
      requestTime: performance.timeOrigin / 1000,
      startLoadTime: performance.timeOrigin / 1000,
      commitLoadTime: performance.timeOrigin / 1000,
      finishDocumentLoadTime: performance.timeOrigin / 1000,
      finishLoadTime: performance.timeOrigin / 1000,
      firstPaintTime: performance.timeOrigin / 1000,
      firstPaintAfterLoadTime: 0,
      navigationType: 'Other',
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
      npnNegotiatedProtocol: 'h2',
      wasAlternateProtocolAvailable: false,
      connectionInfo: 'h2',
    }),
    csi: () => ({
      startE: performance.timeOrigin,
      onloadT: Math.round(performance.timeOrigin + performance.now()),
      pageT: performance.now(),
      tran: 15,
    }),
  };

  // ---- Function.prototype.toString 的 native 伪装在文件末尾统一做 ----
  // （必须等所有全局桩函数都定义完，否则 getComputedStyle / matchMedia 这些
  //   后面才定义的会漏登记，toString 直接暴露 JS 源码）

  let histState = null;
  globalThis.history = {
    pushState: (s, _t, u) => { histState = s === undefined ? null : s; enqueue('history', { mode: 'push', url: u == null ? null : String(u), state: s === undefined ? null : JSON.stringify(s) }); },
    replaceState: (s, _t, u) => { histState = s === undefined ? null : s; enqueue('history', { mode: 'replace', url: u == null ? null : String(u), state: s === undefined ? null : JSON.stringify(s) }); },
    back: () => {}, forward: () => {}, go: () => {},
    get length() { return 1; },
    get state() { return histState; },
  };

  // ---- storage：VM 侧快照读写，变更出队给宿主持久化 ----
  let sLocal = {}, sSession = {};
  const mkStorage = (getMap, which) => ({
    getItem: (k) => { const m = getMap(); return Object.prototype.hasOwnProperty.call(m, String(k)) ? m[String(k)] : null; },
    setItem: (k, v) => { getMap()[String(k)] = String(v); enqueue('storage_set', { which, key: String(k), value: String(v) }); },
    removeItem: (k) => { delete getMap()[String(k)]; enqueue('storage_set', { which, key: String(k), value: null }); },
    clear: () => { const m = getMap(); for (const k of Object.keys(m)) delete m[k]; enqueue('storage_clear', { which }); },
    key: (i) => Object.keys(getMap())[Number(i)] || null,
    get length() { return Object.keys(getMap()).length; },
  });
  globalThis.localStorage = mkStorage(() => sLocal, 'local');
  globalThis.sessionStorage = mkStorage(() => sSession, 'session');

  // ---- crypto.getRandomValues：宿主预置随机池（b64），耗尽时降级 Math.random 并请求补充 ----
  // 池用「下标 + 懒重取」而不是每次 slice：slice 每次都整串拷贝（池 64KB 时
  // 一次调用就拷 64KB），页面高频调用 getRandomValues 时纯属白烧。
  let randPool = null;   // Uint8Array 形态的随机池
  let randPos = 0;       // 已消耗到哪
  const b64d = (s) => {
    const B = {};
    for (let i = 0; i < 64; i++) B[B64CH[i]] = i;
    s = s.replace(/=+$/, '');
    const o = new Uint8Array(Math.floor((s.length * 6) / 8));
    let bv = 0, bc = 0, n = 0;
    for (const ch of s) {
      bv = (bv << 6) | (B[ch] || 0);
      bc += 6;
      if (bc >= 8) { bc -= 8; o[n++] = (bv >> bc) & 255; }
    }
    return o.subarray(0, n);
  };
  globalThis.crypto = {
    getRandomValues(arr) {
      if (!arr || typeof arr.length !== 'number') return arr;
      let need = arr.length;
      let ri = 0;
      while (need > 0) {
        if (!randPool || randPos >= randPool.length) {
          // 池空了：向宿主要一批（宿主在 pump 里回喂 random 任务）
          enqueue('need_random', { bytes: 4096 });
          // 同步拿不到（宿主是异步回喂）→ 降级填充，保证调用不阻塞
          for (let i = 0; i < need; i++) arr[ri++] = (Math.random() * 256) | 0;
          return arr;
        }
        const take = Math.min(need, randPool.length - randPos);
        for (let i = 0; i < take; i++) arr[ri++] = randPool[randPos++];
        need -= take;
      }
      return arr;
    },
    // 浏览器里这两个在安全上下文才有；给出确定实现，好过 TypeError
    randomUUID() {
      const b = new Uint8Array(16);
      globalThis.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    },
  };

  // ---- 浏览器别名与占位类（Vue/React bundle 的 instanceof/typeof 探测路径） ----
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.Node = class Node {};
  Node.ELEMENT_NODE = 1; Node.TEXT_NODE = 3; Node.COMMENT_NODE = 8;
  Node.DOCUMENT_NODE = 9; Node.DOCUMENT_TYPE_NODE = 10; Node.DOCUMENT_FRAGMENT_NODE = 11;
  for (const c of ['Element', 'HTMLElement', 'HTMLHtmlElement', 'HTMLHeadElement', 'HTMLBodyElement',
    'HTMLDivElement', 'HTMLSpanElement', 'HTMLInputElement', 'HTMLAnchorElement', 'HTMLImageElement',
    'HTMLButtonElement', 'HTMLUListElement', 'HTMLLIElement', 'HTMLStyleElement', 'HTMLScriptElement',
    'HTMLIFrameElement', 'HTMLCanvasElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLFormElement',
    'HTMLLabelElement', 'SVGElement', 'MathMLElement', 'CharacterData', 'DocumentFragment', 'ShadowRoot',
    // 注意：不含 'Navigator' —— 上面 navigator 那节已把 Navigator 定义成真类，
    // 这里再赋一次 class {} 会把 navigator.constructor.name 打回 "Object" 一类的形状
    'Storage', 'Location', 'History']) {
    globalThis[c] = class {};
  }
  globalThis.Text = class Text extends globalThis.CharacterData {};
  globalThis.Comment = class Comment extends globalThis.CharacterData {};
  globalThis.MutationObserver = class MutationObserver { observe() {} disconnect() {} takeRecords() { return []; } };
  // 观测器占位：IntersectionObserver / ResizeObserver 被大量库直接调用（而非
  // feature-detect）。空实现即可让页面跑完，代价是这些回调不触发。
  globalThis.IntersectionObserver = class IntersectionObserver {
    constructor(cb) { this.cb = cb; }
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(cb) { this.cb = cb; }
    observe() {} unobserve() {} disconnect() {}
  };
  globalThis.PerformanceObserver = class PerformanceObserver {
    constructor(cb) { this.cb = cb; }
    observe() {} disconnect() {} takeRecords() { return []; }
  };
  // performance.now：宿主没给单调时钟，用引擎内单调计数器兜底（Date.now 是
  // 墙钟，系统校时会导致 delta 变负）。起点由派发时刻锚定。
  let perfBase = Date.now();
  let perfTicks = 0;
  globalThis.performance = {
    now: () => Date.now() - perfBase,
    timeOrigin: perfBase,
    mark: () => {}, measure: () => {}, clearMarks: () => {}, clearMeasures: () => {},
    getEntriesByType: () => [], getEntriesByName: () => [], clearResourceTimings: () => {},
    navigation: undefined,
  };
  // queueMicrotask：比 setTimeout(0) 更早，且不受定时器队列影响
  globalThis.queueMicrotask = (fn) => { if (typeof fn === 'function') { try { fn(); } catch (e) { console.error(String(e)); } } };
  globalThis.requestIdleCallback = (fn) => armTimer(
    typeof fn === 'function' ? (d) => fn({ didTimeout: false, timeRemaining: () => 0 }) : null, 1, false);
  globalThis.cancelIdleCallback = (id) => { timers.delete(Number(id)); };
  globalThis.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  // ---- URL / URLSearchParams ----
  // QuickJS 核心没有 URL（linkedom 也不提供）。但 URL 是页面脚本最高频的
  // 标准内置之一：拼 query、读 origin、解析相对路径、改 hash —— 缺了会直接
  // ReferenceError 打挂大量脚本和打包产物。按 WHATWG 的"够用子集"实现。
  const URL_UNSET = Symbol('unset');
  const SPECIAL = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:']);
  const DEFAULT_PORT = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
  const pctEncode = (s, extra) => {
    let out = '';
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      const safe = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
        || '*-._'.includes(ch) || extra.includes(ch);
      out += safe ? ch : '%' + c.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  };
  const decodePct = (s) => {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  };

  class URLSearchParams {
    constructor(init) {
      this._l = [];
      if (init == null || init === '') return;
      if (typeof init === 'string') {
        let s = init.charCodeAt(0) === 0x3f ? init.slice(1) : init;
        for (const pair of s.split('&')) {
          if (!pair) continue;
          const i = pair.indexOf('=');
          this._l.push([decodePct(i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '),
            decodePct(i < 0 ? '' : pair.slice(i + 1)).replace(/\+/g, ' ')]);
        }
      } else if (init instanceof URLSearchParams) {
        this._l = init._l.map((p) => p.slice());
      } else if (Array.isArray(init)) {
        for (const pair of init) this._l.push([String(pair[0]), String(pair[1])]);
      } else {
        for (const k of Object.keys(init)) this._l.push([String(k), String(init[k])]);
      }
    }
    append(k, v) { this._l.push([String(k), String(v)]); }
    set(k, v) {
      k = String(k);
      const i = this._l.findIndex((p) => p[0] === k);
      if (i < 0) { this._l.push([k, String(v)]); return; }
      this._l[i][1] = String(v);
      this._l = this._l.filter((p, j) => p[0] !== k || j === i);
    }
    delete(k) { k = String(k); this._l = this._l.filter((p) => p[0] !== k); }
    get(k) { k = String(k); const p = this._l.find((x) => x[0] === k); return p ? p[1] : null; }
    getAll(k) { k = String(k); return this._l.filter((p) => p[0] === k).map((p) => p[1]); }
    has(k) { k = String(k); return this._l.some((p) => p[0] === k); }
    get size() { return this._l.length; }
    sort() { this._l.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); }
    forEach(cb, thisArg) { for (const [k, v] of this._l) cb.call(thisArg, v, k, this); }
    *entries() { for (const p of this._l) yield [p[0], p[1]]; }
    *keys() { for (const p of this._l) yield p[0]; }
    *values() { for (const p of this._l) yield p[1]; }
    [Symbol.iterator]() { return this.entries(); }
    // application/x-www-form-urlencoded：空格编成 '+'，其余按 pct-encoding
    toString() {
      const enc = (s) => pctEncode(s, '').replace(/%20/g, '+');
      return this._l.map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
    }
  }
  globalThis.URLSearchParams = URLSearchParams;

  const ABS_RE = /^([a-z][a-z0-9+.-]*):(?:(\/\/)([^\/?#]*))?([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/i;
  const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  // 消解 . / .. 段（URL 路径语义：根相对 .. 不能越过根）
  const normPath = (p) => {
    const abs = p.startsWith('/');
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); continue; }
      out.push(seg);
    }
    let s = out.join('/');
    if (abs) s = '/' + s;
    if (p.endsWith('/') && !s.endsWith('/')) s += '/';
    return s;
  };
  class URL {
    constructor(input, base) {
      let s = String(input).trim();
      if (!HAS_SCHEME.test(s)) {
        if (base === undefined || base === null) {
          throw new TypeError('Invalid URL: ' + s);
        }
        s = URL._resolve(new URL(String(base)), s);
      }
      const m = ABS_RE.exec(s);
      if (!m) throw new TypeError('Invalid URL: ' + s);
      this.protocol = m[1].toLowerCase() + ':';
      if (m[2]) {
        let auth = m[3] || '';
        const at = auth.lastIndexOf('@');
        const cred = at < 0 ? '' : auth.slice(0, at);
        const hostport = at < 0 ? auth : auth.slice(at + 1);
        const ci = cred.indexOf(':');
        this.username = ci < 0 ? (cred ? decodePct(cred) : '') : decodePct(cred.slice(0, ci));
        this.password = ci < 0 ? '' : decodePct(cred.slice(ci + 1));
        const hi = hostport.lastIndexOf(':');
        // 只有 : 后全为数字才算端口（IPv6 字面量 [::1] 不算）
        this.hostname = hi >= 0 && /^\d*$/.test(hostport.slice(hi + 1))
          ? hostport.slice(0, hi).toLowerCase() : hostport.toLowerCase();
        this.port = hi >= 0 && /^\d*$/.test(hostport.slice(hi + 1)) ? hostport.slice(hi + 1) : '';
        if (this.port === DEFAULT_PORT[this.protocol]) this.port = '';
        this._absPath = true;
        this.pathname = normPath(m[4] || '/');
      } else {
        this.username = this.password = this.hostname = this.port = '';
        this._absPath = false;
        this.pathname = m[4] || '';
      }
      this.search = m[5] || '';
      this.hash = m[6] || '';
      this._sp = null;
    }
    static _resolve(base, ref) {
      if (ref.startsWith('//')) return base.protocol + ref;
      if (ref.startsWith('#')) return base.protocol + '//' + base._authority() + base.pathname + base.search + ref;
      if (ref.startsWith('?')) return base.protocol + '//' + base._authority() + base.pathname + ref;
      const i = ref.search(/[?#]/);
      const rp = i < 0 ? ref : ref.slice(0, i);
      const tail = i < 0 ? '' : ref.slice(i);
      const dir = base.pathname.replace(/[^/]*$/, '');
      const path = rp.startsWith('/') ? normPath(rp) : normPath(dir + rp);
      return base.protocol + '//' + base._authority() + path + tail;
    }
    _authority() {
      const auth = (this.username || this.password)
        ? this.username + (this.password ? ':' + this.password : '') + '@' : '';
      return auth + this.hostname + (this.port ? ':' + this.port : '');
    }
    get host() { return this.hostname + (this.port ? ':' + this.port : ''); }
    set host(v) {
      const h = String(v);
      const i = h.lastIndexOf(':');
      if (i >= 0 && /^\d*$/.test(h.slice(i + 1))) { this.hostname = h.slice(0, i); this.port = h.slice(i + 1); }
      else { this.hostname = h; this.port = ''; }
      if (this.port === DEFAULT_PORT[this.protocol]) this.port = '';
    }
    get searchParams() {
      // 活对象：改它再读 href 要能反映出来（页面常见 u.searchParams.set(...) 用法）
      if (!this._sp) {
        const self = this;
        this._sp = new URLSearchParams(this.search || '');
        const mark = () => { const s = this._sp.toString(); self.search = s ? '?' + s : ''; };
        for (const m of ['append', 'set', 'delete', 'sort']) {
          const orig = this._sp[m].bind(this._sp);
          this._sp[m] = (...a) => { const r = orig(...a); mark(); return r; };
        }
      }
      return this._sp;
    }
    get origin() {
      if (this._absPath) return this.protocol + '//' + this._authority();
      return 'null';
    }
    get href() { return this.toString(); }
    set href(v) {
      const u = new URL(String(v));
      for (const k of ['protocol', 'username', 'password', 'hostname', 'port', 'pathname', 'search', 'hash']) this[k] = u[k];
      this._absPath = u._absPath;
      this._sp = null;
    }
    toString() {
      let s = this.protocol;
      if (this._absPath) {
        s += '//' + this._authority() + (this.pathname || '/');
      } else if (this.hostname) {
        s += '//' + this._authority() + (this.pathname || '');
      } else {
        s += this.pathname;
      }
      return s + (this.search || '') + (this.hash || '');
    }
    toJSON() { return this.toString(); }
    static canParse(input, base) { try { new URL(input, base); return true; } catch (e) { return false; } }
    static parse(input, base) { try { return new URL(input, base); } catch (e) { return null; } }
  }
  globalThis.URL = URL;

  // ---- TextEncoder / TextDecoder ----
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s) {
      const str = s === undefined ? '' : String(s);
      const out = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
          const c2 = str.charCodeAt(i + 1);
          if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
    encodeInto(s, dst) {
      const src = this.encode(s);
      const n = Math.min(src.length, dst.length);
      dst.set(src.subarray(0, n));
      return { read: s.length, written: n };
    }
  }
  class TextDecoder {
    constructor(label = 'utf-8') { this.encoding = String(label).toLowerCase(); this.fatal = false; }
    decode(buf) {
      if (buf === undefined || buf === null) return '';
      const b = buf instanceof ArrayBuffer ? new Uint8Array(buf)
        : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        : new Uint8Array(0);
      let s = '', i = 0;
      while (i < b.length) {
        const c = b[i++];
        if (c < 0x80) { s += String.fromCharCode(c); continue; }
        let n, cp;
        if ((c & 0xe0) === 0xc0) { n = 1; cp = c & 0x1f; }
        else if ((c & 0xf0) === 0xe0) { n = 2; cp = c & 0x0f; }
        else if ((c & 0xf8) === 0xf0) { n = 3; cp = c & 0x07; }
        else { s += '�'; continue; }
        if (i + n > b.length) { s += '�'; break; }
        for (let k = 0; k < n; k++) cp = (cp << 6) | (b[i++] & 0x3f);
        if (cp > 0xffff) {
          cp -= 0x10000;
          s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else s += String.fromCharCode(cp);
      }
      return s;
    }
  }
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;

  // ---- AbortController / AbortSignal ----
  // fetch 的 signal 是页面取消请求的标准途径；缺了 AbortController 的代码
  // 直接 ReferenceError。signal 状态变化派发 abort 事件。
  class AbortSignal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      this._ls = [];
    }
    addEventListener(t, fn) { if (t === 'abort' && typeof fn === 'function') this._ls.push(fn); }
    removeEventListener(t, fn) { if (t === 'abort') { const i = this._ls.indexOf(fn); if (i >= 0) this._ls.splice(i, 1); } }
    throwIfAborted() {
      if (this.aborted) throw (this.reason || new Error('The operation was aborted'));
    }
    _fire(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason;
      const ev = { type: 'abort', target: this, currentTarget: this, defaultPrevented: false, preventDefault() {}, stopPropagation() {} };
      try { if (typeof this.onabort === 'function') this.onabort.call(this, ev); } catch (e) { /* ignore */ }
      for (const fn of [...this._ls]) { try { fn.call(this, ev); } catch (e) { /* ignore */ } }
    }
    static timeout(ms) {
      const c = new AbortController();
      armTimer(() => c.abort(new Error('signal timed out')), ms, false);
      return c.signal;
    }
    static abort() { const c = new AbortController(); c.abort(); return c.signal; }
  }
  class AbortController {
    constructor() {
      this.signal = new AbortSignal();
      const sig = this.signal;
      this.abort = (reason) => {
        sig._fire(reason === undefined ? new Error('The operation was aborted.') : reason);
      };
    }
  }
  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;

  globalThis.Event = class Event {
    constructor(type, opts) {
      this.type = String(type);
      const o = opts || {};
      this.detail = o.detail === undefined ? null : o.detail;
      this.bubbles = !!o.bubbles; this.cancelable = !!o.cancelable;
      this.defaultPrevented = false; this.target = null; this.currentTarget = null;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() {}
    stopImmediatePropagation() {}
  };
  globalThis.CustomEvent = class CustomEvent extends globalThis.Event {};

  // 事件子类：页面 dispatch / instanceof 判定用。linkedom 换上真正的 document
  // 后，这些仍是 prelude 造的类，所以放在这里一次性给全。
  for (const [nm, extra] of [
    ['UIEvent', ['view', 'detail', 'which']],
    ['MouseEvent', ['clientX', 'clientY', 'screenX', 'screenY', 'button', 'buttons', 'altKey', 'ctrlKey', 'shiftKey', 'metaKey', 'relatedTarget']],
    ['PointerEvent', ['pointerId', 'pointerType', 'isPrimary', 'pressure', 'clientX', 'clientY']],
    ['WheelEvent', ['deltaX', 'deltaY', 'deltaZ', 'deltaMode']],
    ['KeyboardEvent', ['key', 'code', 'location', 'repeat', 'altKey', 'ctrlKey', 'shiftKey', 'metaKey']],
    ['InputEvent', ['data', 'inputType', 'isComposing']],
    ['FocusEvent', ['relatedTarget']],
    ['Touch', []],
    ['TouchEvent', ['touches', 'targetTouches', 'changedTouches']],
    ['DragEvent', ['dataTransfer']],
    ['ClipboardEvent', ['clipboardData']],
  ]) {
    const fields = extra;
    const Base = globalThis.Event;
    globalThis[nm] = class extends Base {
      constructor(type, opts) {
        super(type, opts);
        const o = opts || {};
        for (const f of fields) {
          this[f] = f === 'view' || f === 'relatedTarget' ? (o[f] ?? null)
            : f === 'touches' || f === 'targetTouches' || f === 'changedTouches' || f === 'clipboardData' || f === 'dataTransfer' ? (o[f] ?? [])
            : (o[f] ?? (typeof f === 'string' && f === 'which' ? 0 : false));
        }
      }
    };
  }
  globalThis.ErrorEvent = class ErrorEvent extends globalThis.Event {
    constructor(type, opts) { super(type, opts); const o = opts || {}; this.message = o.message || ''; this.filename = o.filename || ''; this.lineno = o.lineno || 0; this.colno = o.colno || 0; this.error = o.error; }
  };
  globalThis.PopStateEvent = class PopStateEvent extends globalThis.Event {
    constructor(type, opts) { super(type, opts); this.state = (opts && 'state' in opts) ? opts.state : null; }
  };
  globalThis.HashChangeEvent = class HashChangeEvent extends globalThis.Event {
    constructor(type, opts) { super(type, opts); const o = opts || {}; this.newURL = o.newURL || ''; this.oldURL = o.oldURL || ''; }
  };
  globalThis.MessageEvent = class MessageEvent extends globalThis.Event {
    constructor(type, opts) { super(type, opts); const o = opts || {}; this.data = 'data' in o ? o.data : null; this.origin = o.origin || ''; this.source = o.source ?? null; this.ports = o.ports || []; }
  };
  globalThis.EventTarget = globalThis.EventTarget || class {};
  for (const nm of ['NodeList', 'HTMLCollection', 'DOMTokenList', 'NamedNodeMap', 'CSSStyleDeclaration', 'Attr', 'DOMRect', 'DOMRectReadOnly']) {
    if (typeof globalThis[nm] === 'undefined') globalThis[nm] = class {};
  }

  // matchMedia：媒体查询库（prefers-color-scheme / reduced-motion / print）几乎
  // 每个设计系统都会查；没有就直接 ReferenceError。这里只解析最常用的几个
  // 布尔条件，其余一律 false。
  globalThis.matchMedia = (query) => {
    const q = String(query || '');
    const has = (re) => re.test(q);
    const mql = {
      media: q,
      matches: has(/\bprefers-color-scheme\s*:\s*dark\b/) || has(/\bprefers-contrast\s*:\s*more\b/)
        || has(/\bhover\s*:\s*hover\b/) || has(/\bany-pointer\s*:\s*fine\b/),
      onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => true,
    };
    return mql;
  };

  // getComputedStyle：返回带 getPropertyValue 的普通对象。linkedom 不实现布局，
  // 真值给不了；但调用方大多只读几个属性做分支判断，缺函数比缺真值致命得多。
  globalThis.getComputedStyle = (el, pseudo) => {
    const inline = (el && el.style) || {};
    const base = {
      getPropertyValue: (name) => {
        const k = String(name).replace(/^-webkit-/, '');
        return inline[k] !== undefined ? inline[k] : '';
      },
      length: 0, parentRule: null, cssText: '',
    };
    return new Proxy(base, {
      get(t, k) {
        if (k in t) return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
        if (typeof k !== 'string') return undefined;
        return t.getPropertyValue(k);
      },
    });
  };

  // ---- 事件总线（window/document 级；元素级等 DOM 组件阶段） ----
  const listeners = new Map();
  const on = (key, type, fn) => {
    const k = key + '\u0000' + type;
    if (!listeners.has(k)) listeners.set(k, []);
    listeners.get(k).push(fn);
  };
  globalThis.addEventListener = (type, fn) => { if (typeof fn === 'function') on('win', String(type), fn); };
  globalThis.removeEventListener = (type, fn) => {
    const list = listeners.get('win\u0000' + String(type));
    if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
  };
  globalThis.dispatchEvent = (ev) => {
    const list = listeners.get('win\u0000' + String(ev && ev.type)) || [];
    for (const fn of [...list]) { try { fn(ev); } catch (e) { console.error(e && e.stack || String(e)); } }
    return true;
  };
  globalThis.document = {
    addEventListener: (type, fn) => { if (typeof fn === 'function') on('doc', String(type), fn); },
    removeEventListener: (type, fn) => {
      const list = listeners.get('doc\u0000' + String(type));
      if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
    },
    dispatchEvent: (ev) => {
      const list = listeners.get('doc\u0000' + String(ev && ev.type)) || [];
      for (const fn of [...list]) { try { fn(ev); } catch (e) { console.error(e && e.stack || String(e)); } }
      return true;
    },
    get cookie() { return docCookie; },
    set cookie(v) { enqueue('cookie_set', { value: String(v) }); },
  };
  let docCookie = '';

  // ---- Function.prototype.toString：抹掉 native 痕迹（必须放在最后）----
  // 页面/检测脚本会 Function.prototype.toString.call(fn) 找 [native code]。
  // 我们自己写的桩函数（fetch/getComputedStyle/matchMedia…）toString 出来是 JS 源码，
  // 与真浏览器一眼可分。这里登记一批"应当看起来是原生"的函数，统一回 native 形态。
  // 两个坑：
  //  1) 位置必须在文件末尾——所有全局桩都定义完了才能登记，否则后面才定义的
  //     getComputedStyle / matchMedia 会漏登记（本轮第一版就栽在这）。
  //  2) 名字要显式给：QuickJS 不给匿名函数做 name 推断（把箭头函数赋给
  //     globalThis.fetch，它的 name 是空串），靠 fn.name 会拼出
  //     'function () { [native code] }' 这种一眼假的字符串。
  const NATIVE_NAMES = new Map();
  const markNative = (fn, name) => {
    if (typeof fn === 'function') NATIVE_NAMES.set(fn, name || fn.name || '');
    return fn;
  };
  const origFnToString = Function.prototype.toString;
  Function.prototype.toString = function () {
    const nm = NATIVE_NAMES.get(this);
    if (nm !== undefined) return 'function ' + nm + '() { [native code] }';
    return origFnToString.call(this);
  };
  markNative(Function.prototype.toString, 'toString');
  for (const [name, fn] of [
    ['fetch', globalThis.fetch], ['btoa', globalThis.btoa], ['atob', globalThis.atob],
    ['setTimeout', globalThis.setTimeout], ['setInterval', globalThis.setInterval],
    ['clearTimeout', globalThis.clearTimeout], ['queueMicrotask', globalThis.queueMicrotask],
    ['getComputedStyle', globalThis.getComputedStyle], ['matchMedia', globalThis.matchMedia],
    ['structuredClone', globalThis.structuredClone], ['requestAnimationFrame', globalThis.requestAnimationFrame],
    ['requestIdleCallback', globalThis.requestIdleCallback], ['addEventListener', globalThis.addEventListener],
    ['removeEventListener', globalThis.removeEventListener], ['dispatchEvent', globalThis.dispatchEvent],
    ['scrollTo', globalThis.scrollTo], ['scrollBy', globalThis.scrollBy], ['moveTo', globalThis.moveTo],
    ['resizeTo', globalThis.resizeTo],
  ]) markNative(fn, name);
  // navigator / plugins / permissions 上的方法按属性名登记
  for (const k of Object.getOwnPropertyNames(globalThis.navigator)) markNative(globalThis.navigator[k], k);
  markNative(globalThis.navigator.permissions.query, 'query');
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(globalThis.navigator.plugins))) {
    markNative(globalThis.navigator.plugins[k], k);
  }

  // ---- 宿主→VM 统一入口 ----
  globalThis.__dispatch = (blob) => {
    const m = JSON.parse(blob);
    if (m.kind === 'load_dom' && globalThis.__load_dom) {
      globalThis.__load_dom(m.html, m.baseUrl);
      return undefined;
    }
    switch (m.kind) {
      case 'timer_fire': {
        const t = timers.get(m.id);
        if (!t) break;
        if (!t.interval) timers.delete(m.id);
        try { t.fn(); } catch (e) { console.error(e && e.stack || String(e)); }
        if (t.interval) enqueue('timer', { id: m.id, delay: t.delay, interval: true });
        break;
      }
      case 'fetch_resolve': {
        const p = pendingFetch.get(m.id);
        if (!p) break;
        pendingFetch.delete(m.id);
        if (m.error) p.reject(new TypeError(String(m.error)));
        else p.resolve(mkResp(m.resp));
        break;
      }
      case 'loc': { locUrl = String(m.url || 'about:blank'); break; }
      // 视口：宿主按本次渲染尺寸派发。screen/innerWidth 等 read 时现取，故中途改也生效。
      case 'viewport': {
        if (m.w > 0) vp.w = m.w | 0;
        if (m.h > 0) vp.h = m.h | 0;
        if (m.dpr > 0) vp.dpr = m.dpr;
        break;
      }
      case 'storage': { sLocal = m.local || {}; sSession = m.session || {}; break; }
      case 'random': {
        // 池只增不减：宿主每次回喂都是一批新随机数，追加即可
        const add = b64d(m.b64);
        if (randPool) {
          if (randPos > 0 && randPos >= randPool.length) { randPool = add; randPos = 0; }
          else {
            const merged = new Uint8Array((randPool.length - randPos) + add.length);
            merged.set(randPool.subarray(randPos), 0);
            merged.set(add, randPool.length - randPos);
            randPool = merged; randPos = 0;
          }
        } else { randPool = add; randPos = 0; }
        break;
      }
      case 'cookie': { docCookie = String(m.value || ''); break; }
      case 'domready': {
        if (globalThis.__dom_ready) { try { globalThis.__dom_ready(); } catch (e) {} }
        const ev = { type: 'DOMContentLoaded' };
        for (const fn of [...(listeners.get('doc\u0000DOMContentLoaded') || [])]) { try { fn(ev); } catch (e) { console.error(String(e)); } }
        const ld = { type: 'load' };
        for (const fn of [...(listeners.get('win\u0000DOMContentLoaded') || [])]) { try { fn(ld); } catch (e) { console.error(String(e)); } }
        for (const fn of [...(listeners.get('win\u0000load') || [])]) { try { fn(ld); } catch (e) { console.error(String(e)); } }
        break;
      }
      default: break;
    }
    return undefined;
  };
})();
`;
