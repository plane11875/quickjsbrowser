// wire.js — VM 内 DOM 接线（在 linkedom.iife.js 之后注入）。
// load_dom 建 DOM，__run_classic 跑页面经典脚本，__dom_html 序列化回宿主。

export const DOM_WIRE = String.raw`
(() => {
  const L = globalThis.__linkedom;
  let doc = null;
  let baseUrl = 'about:blank';

  globalThis.__load_dom = (html, base) => {
    baseUrl = String(base || 'about:blank');
    const parsed = L.parseHTML(String(html));
    doc = parsed.document;
    globalThis.document = doc;
    for (const k of ['Node', 'Element', 'HTMLElement', 'SVGElement', 'DocumentFragment',
      'CharacterData', 'Text', 'Comment', 'ShadowRoot', 'Document']) {
      if (parsed[k]) { try { globalThis[k] = parsed[k]; } catch (e) {} }
    }
    return true;
  };

  // 页面经典脚本：间接 eval = 全局作用域（var/function 互相可见，同浏览器 <script>）
  globalThis.__run_classic = (code) => {
    try { (0, eval)(code); return ''; }
    catch (e) { return String((e && e.stack) || e).slice(0, 500); }
  };

  globalThis.__dom_html = () => {
    try { return doc ? doc.documentElement.outerHTML : ''; } catch (e) { return ''; }
  };

  globalThis.__dom_ready = () => {
    if (!doc) return false;
    try {
      const E = L.Event;
      doc.dispatchEvent(new E('DOMContentLoaded'));
      const win = globalThis;
      for (const t of ['DOMContentLoaded', 'load']) {
        try { win.dispatchEvent(new E(t)); } catch (e) {}
      }
      return true;
    } catch (e) { return false; }
  };

  globalThis.__dom_url = (u) => { baseUrl = String(u || baseUrl); };

  // ---- CDP Runtime.evaluate / callFunctionOn 求值助手 ----
  // 宿主把代码包成 async IIFE 间接 eval：Promise 自动 settle（await）、
  // 完成值经 __cdp_json 序列化进 __cdpRes，宿主 drainJobs 后轮询 __cdp_get。
  globalThis.__cdp_begin = () => { globalThis.__cdpRes = { done: false }; return 1; };
  globalThis.__cdp_ok = (json) => { globalThis.__cdpRes = { done: true, ok: true, json: json }; return 1; };
  globalThis.__cdp_fail = (msg) => { globalThis.__cdpRes = { done: true, ok: false, error: String(msg) }; return 1; };
  globalThis.__cdp_get = () => JSON.stringify(globalThis.__cdpRes || { done: false });
  globalThis.__cdp_json = (v) => {
    try {
      if (v === undefined) return '\u0000__undef__';
      if (typeof v === 'number') {
        if (v !== v) return '\u0000__num__NaN';
        if (v === Infinity) return '\u0000__num__Infinity';
        if (v === -Infinity) return '\u0000__num__-Infinity';
        if (v === 0 && (1 / v) < 0) return '\u0000__num__-0';
      }
      return JSON.stringify(v);
    } catch (e) {
      try { return JSON.stringify(String(v)); } catch (e2) { return '"[unserializable]"'; }
    }
  };
})();
`;
