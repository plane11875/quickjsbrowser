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
    if(globalThis.__layout_reset)globalThis.__layout_reset();
    for(const key of ['URL','documentURI'])Object.defineProperty(doc,key,{get:()=>baseUrl,configurable:true});
    Object.defineProperty(doc,'baseURI',{get:()=>new URL(doc.querySelector('base[href]')?.getAttribute('href')||baseUrl,baseUrl).href,configurable:true});
    Object.defineProperty(doc,'location',{get:()=>globalThis.location,configurable:true});
    Object.defineProperty(doc,'cookie',{get:()=>globalThis.__get_document_cookie(),set:v=>globalThis.__set_document_cookie(v),configurable:true});
    for (const k of ['Node', 'Element', 'HTMLElement', 'SVGElement', 'DocumentFragment',
      'CharacterData', 'Text', 'Comment', 'ShadowRoot', 'Document', 'Event', 'CustomEvent', 'EventTarget',
      ...Object.keys(L).filter(k => /^HTML.*Element$/.test(k))]) {
      if (parsed[k]) { try { globalThis[k] = parsed[k]; } catch (e) {} }
    }
    globalThis.MutationObserver = parsed.MutationObserver;
    Object.defineProperty(doc, 'readyState', { value:'loading', writable:true, configurable:true });
    if(globalThis.__layout_install)globalThis.__layout_install();
    if(globalThis.__input_install)globalThis.__input_install();
    return true;
  };

  globalThis.__page_manifest = () => {
    const scripts=[],maps=[];
    const all=Array.from(doc.querySelectorAll('script'));
    for(let index=0;index<all.length;index++) {
      const node=all[index];if(node.closest('noscript,template'))continue;
      const type=(node.getAttribute('type')||'').trim().toLowerCase();
      if(type==='importmap'){maps.push(node.textContent);continue;}
      if(type && !['module','text/javascript','application/javascript'].includes(type))continue;
      scripts.push({index,src:node.getAttribute('src'),code:node.textContent,module:type==='module'});
    }
    return {scripts,maps,baseHref:doc.querySelector('base[href]')?.getAttribute('href'),hasFallback:!!doc.querySelector('noscript #main-outlet, noscript main, noscript article')};
  };
  const errorInfo=(e,url)=>({name:String(e&&e.name||'Error'),message:String(e&&e.message||e),stack:String(e&&e.stack||'').slice(0,1800),url});
  globalThis.__report_page_error=(e,url)=>__hostEnqueue('page_error',JSON.stringify(errorInfo(e,url)));
  globalThis.__run_page_script=(payload)=>{
    const p=JSON.parse(payload);
    Object.defineProperty(doc,'currentScript',{value:doc.querySelectorAll('script')[p.index]||null,configurable:true});
    try{(0,eval)(p.code);return {ok:true};}
    catch(e){return {error:errorInfo(e,p.url)};}
    finally{Object.defineProperty(doc,'currentScript',{value:null,configurable:true});}
  };

  // 页面经典脚本：间接 eval = 全局作用域（var/function 互相可见，同浏览器 <script>）
  globalThis.__run_classic = (code) => {
    try { (0, eval)(code); return ''; }
    catch (e) { return (String(e && e.name || 'Error') + ': ' + String(e && e.message || e) + '\n' + String(e && e.stack || '')).slice(0, 1800); }
  };

  globalThis.__dom_html = () => {
    try { return doc ? doc.documentElement.outerHTML : ''; } catch (e) { return ''; }
  };

  globalThis.__dom_ready = () => {
    if (!doc) return false;
    try {
      const E = L.Event;
      doc.readyState='interactive';
      doc.dispatchEvent(new E('readystatechange'));
      doc.dispatchEvent(new E('DOMContentLoaded'));
      const win = globalThis;
      win.dispatchEvent(new E('DOMContentLoaded'));
      doc.readyState='complete';
      doc.dispatchEvent(new E('readystatechange'));
      win.dispatchEvent(new E('load'));
      return true;
    } catch (e) { globalThis.__report_page_error(e,baseUrl); return false; }
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
