import { ModuleResolver, moduleSpecifiers } from './module-resolver.js';
import { requestHeaders } from './fingerprint.js';

export const PAGE_LIMITS = Object.freeze({ sourceBytes: 48*1024, totalBytes: 128*1024, requests: 8, networkMs: 900, interrupts: 150, tasks: 64, rounds: 12 });
const encoder = new TextEncoder();
const size = (s) => encoder.encode(s).length;

export class PageScripts {
  constructor(session, base, manifest) {
    this.s = session; this.base = base; this.manifest = manifest;
    this.resourceBase=new URL(manifest.baseHref||base,base).href;
    this.resolver = new ModuleResolver(this.resourceBase, manifest.maps);
    this.controller = new AbortController();
    this.requests = 0; this.bytes = 0; this.executed = 0; this.tasks = 0;
    this.errors = []; this.sources = new Map(); this.nodes = new Map(); this.timers = []; this.fetches = [];
  }
  error(reason, url = this.base, detail = '') {
    if (this.errors.length >= 12) return;
    const record = { reason, url, ...(detail && typeof detail==='object'?{error:detail}:{detail:String(detail).slice(0,1200)}) };
    this.errors.push(record);
    this.s.pushLog('[page-error] ' + JSON.stringify(record));
  }
  countSource(text, url) {
    const n = size(text);
    if (n > PAGE_LIMITS.sourceBytes || this.bytes+n > PAGE_LIMITS.totalBytes) {
      this.error('source-budget', url, `${n} bytes; limit ${PAGE_LIMITS.sourceBytes}, total ${PAGE_LIMITS.totalBytes}`); return false;
    }
    this.bytes += n; return true;
  }
  async request(url, init = {}, limit = PAGE_LIMITS.sourceBytes) {
    if (this.controller.signal.aborted || this.requests >= PAGE_LIMITS.requests) throw new Error('request/time budget exhausted');
    if (!/^https?:\/\//i.test(url)) throw new Error('unsupported resource scheme');
    this.requests++;
    const r = await this.s.smartFetch(url, { ...init, signal: this.controller.signal, redirect:'follow' }, { allowRelay:false });
    if (!r.ok) { r.body?.cancel().catch(()=>{}); throw new Error(`HTTP ${r.status}`); }
    if (+r.headers.get('content-length') > limit) { r.body?.cancel().catch(()=>{}); throw new Error('source size budget exceeded before download'); }
    const reader = r.body?.getReader(); let n=0; const parts=[];
    if (reader) {
      try {
        for (;;) {
          if (this.controller.signal.aborted) throw new Error('network budget exhausted');
          const {done,value} = await reader.read(); if (done) break;
          n += value.length;
          if (n>limit) throw new Error('response size budget exceeded');
          parts.push(value);
        }
      } catch(e) { reader.cancel().catch(()=>{}); throw e; }
    }
    const bytes = new Uint8Array(n);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
    return { r, text:new TextDecoder().decode(bytes) };
  }
  source(url, module) {
    const key = `${module ? 'm':'s'}:${url}`;
    if (this.sources.has(key)) return this.sources.get(key);
    const pending = (async()=>{
      try {
        const cached = module && this.s.modCache.get(url);
        const text = cached?.text ?? (await this.request(url, {headers:requestHeaders({type:'script',url,referer:this.base,mode:module?'cors':'no-cors',origin:!!module})})).text;
        if (!this.countSource(text,url)) return null;
        if(module) this.s.cacheModule(url,{text,kind:0});
        return text;
      } catch(e) { this.error('script-fetch',url,e.message); return null; }
    })();
    this.sources.set(key,pending);return pending;
  }
  async graph(url, text, depth=0, ancestors=new Set()) {
    if(ancestors.has(url)) return true;
    if(this.nodes.has(url)) return this.nodes.get(url);
    const pending=(async()=>{
      if(depth>=8){this.error('module-depth',url);return false;}
      if(text==null) text=await this.source(url,true);
      if(text==null) return false;
      let imports;
      try{imports=moduleSpecifiers(text);}catch(e){this.error('module-parse',url,e.message);return false;}
      if(imports.length>32){this.error('module-count',url);return false;}
      const branch=new Set(ancestors);branch.add(url);
      let ok=true;
      // Walk in source order: pending siblings must never deadlock on cyclic graphs.
      for(const spec of imports){
        const abs=this.resolver.resolve(url,spec);
        if(!abs){this.error('unmapped-import',url,spec);ok=false;continue;}
        if(!this.s.engine.addModuleResolution(url,spec,abs)){this.error('resolution-budget',url);ok=false;continue;}
        if(!await this.graph(abs,null,depth+1,branch))ok=false;
      }
      if(ok && !this.s.registerModule(url,{text,kind:0})) {this.error('module-register',url);ok=false;}
      return ok;
    })();
    this.nodes.set(url,pending);return pending;
  }
  drain() {
    this.s.engine.drainJobs(128);
    for(const t of this.s.engine.takeTasks()) {
      if(++this.tasks>PAGE_LIMITS.tasks){this.error('task-budget');break;}
      if(t.kind==='navigate')this.error('unsupported-navigation',t.payload.url);
      else if(t.kind==='timer') this.timers.push(t.payload);
      else if(t.kind==='fetch') this.fetches.push(t.payload);
      else if(t.kind==='page_error'||t.kind==='exception'||t.kind==='unhandled_rejection') this.error(t.kind,t.payload.url||this.base,t.payload);
      else this.s.handleTask(t);
    }
    if(this.s.engine.scopeExhausted())this.error('execution-budget');
  }
  async settle() {
    for(let round=0;round<PAGE_LIMITS.rounds && !this.errors.length;round++){
      this.drain();
      const fetches=this.fetches.splice(0),timers=this.timers.splice(0);
      if(!fetches.length&&!timers.length&&!this.s.engine.jobPending())return;
      for(const f of fetches){
        try{
          const url=new URL(f.url,this.base).href;
          const {r,text}=await this.request(url,{method:f.method,headers:f.headers,body:f.method==='GET'||f.method==='HEAD'?undefined:f.body});
          this.s.dispatch({kind:'fetch_resolve',id:f.id,resp:{ok:r.ok,status:r.status,statusText:r.statusText,url:r.url||url,headers:Object.fromEntries(r.headers),text}});
        }catch(e){this.error('page-fetch',f.url,e.message);this.s.dispatch({kind:'fetch_resolve',id:f.id,error:e.message});}
      }
      for(const t of timers){
        if(t.delay>32||t.interval){this.error('deferred-timer',this.base,`${t.delay}ms${t.interval?' interval':''}`);continue;}
        if(t.delay)await new Promise((r)=>setTimeout(r,t.delay));
        this.s.dispatch({kind:'timer_fire',id:t.id});
      }
    }
    this.drain();
    if(this.s.engine.jobPending()||this.timers.length||this.fetches.length)this.error('settle-budget');
  }
  async run() {
    const timer=setTimeout(()=>this.controller.abort(),PAGE_LIMITS.networkMs);
    const scripts=this.manifest.scripts.slice(0,32);
    if(this.manifest.scripts.length>32)this.error('script-count');
    const required=new Set(scripts.filter(s=>s.src).map(s=>new URL(s.src,this.resourceBase).href)).size;
    if(required>PAGE_LIMITS.requests)this.error('request-budget',this.base,`${required} script URLs exceed ${PAGE_LIMITS.requests}`);
    const prepared=new Map();
    try{
      if(this.errors.length)return {mode:'bounded',status:'degraded',executed:0,requests:0,sourceBytes:0,limits:PAGE_LIMITS,errors:this.errors};
      await this.s.mapLimit(scripts,4,async(script)=>{
        const url=script.src?new URL(script.src,this.resourceBase).href:`${this.resourceBase}#inline-${script.index}`;
        const text=script.src?await this.source(url,script.module):this.countSource(script.code,url)?script.code:null;
        prepared.set(script,{url,text});
      });
      // Any required module that cannot load makes execution non-transactional;
      // decline it before partially running the application's classic scripts.
      for(const script of scripts.filter((s)=>s.module)){
        const p=prepared.get(script);
        if(p?.text!=null&&!await this.graph(p.url,p.text))this.error('module-unavailable',p.url);
      }
      if(!this.errors.length){
        this.s.engine.callGlobal('eval','globalThis.__page_active=true');
        this.s.engine.beginScope(PAGE_LIMITS.interrupts,PAGE_LIMITS.sourceBytes,PAGE_LIMITS.totalBytes);
        try{
          for(const script of scripts.filter((s)=>!s.module)){
            const p=prepared.get(script);if(p?.text==null)continue;
            const r=this.s.engine.callGlobal('__run_page_script',JSON.stringify({code:p.text,url:p.url,index:script.index}));
            this.executed++;
            if(!r.ok||r.value?.error)this.error('classic-script',p.url,r.value?.error||r.error);
            this.drain();if(this.errors.length)break;
          }
          for(const script of scripts.filter((s)=>s.module)){
            if(this.errors.length)break;const p=prepared.get(script);if(p?.text==null)continue;
            const code=`import(${JSON.stringify(p.url)}).catch(e=>__report_page_error(e,${JSON.stringify(p.url)}));`;
            if(this.s.engine.eval(code,this.base,false))this.error('module-eval',p.url);
            this.executed++;this.drain();
          }
          if(!this.errors.length){this.s.dispatch({kind:'domready'});await this.settle();}
        }finally{this.s.engine.endScope();this.s.engine.callGlobal('eval','globalThis.__page_active=false');}
      }
    }finally{clearTimeout(timer);this.controller.abort();}
    return {mode:'bounded',status:this.errors.length?'degraded':this.executed?'executed':'static',executed:this.executed,requests:this.requests,sourceBytes:this.bytes,limits:PAGE_LIMITS,errors:this.errors};
  }
}
