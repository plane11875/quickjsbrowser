// Private, bounded DO memory cache. Store only complete, explicitly fresh GET
// responses; request headers partition identity, referrer and negotiated variants.
export class ResourceCache {
  constructor(maxBytes=32*1024*1024,maxEntries=512){this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.entries=new Map();this.pending=new Map();this.bytes=0;this.hits=0;this.hitBytes=0;this.misses=0;this.epoch=0;}
  stats(){return {entries:this.entries.size,bytes:this.bytes,hits:this.hits,hitBytes:this.hitBytes,misses:this.misses,inflight:this.pending.size};}
  clear(){this.epoch++;this.entries.clear();this.pending.clear();this.bytes=0;}
  key(url,init){const h=[...new Headers(init.headers)].filter(([k])=>k!=='referer').sort((a,b)=>a[0].localeCompare(b[0]));return JSON.stringify([new URL(url).href,h,init.credentials||'same-origin']);}
  remove(key){const old=this.entries.get(key);if(old){this.bytes-=old.body.byteLength;this.entries.delete(key);}}
  response(e){const r=new Response(e.body.slice(),{status:e.status,statusText:e.statusText,headers:e.headers});Object.defineProperty(r,'url',{value:e.url});return r;}
  async fetch(url,init={},load){
    const headers=new Headers(init.headers);
    if((init.method||'GET').toUpperCase()!=='GET'||init.body!=null||headers.has('range')||/no-cache|no-store/i.test(headers.get('cache-control')||'')||init.cache==='reload'||init.cache==='no-store')return load();
    if(init.signal?.aborted)throw init.signal.reason||new Error('aborted');
    const key=this.key(url,init),cached=this.entries.get(key);
    if(cached&&cached.until>Date.now()){this.entries.delete(key);this.entries.set(key,cached);this.hits++;this.hitBytes+=cached.body.byteLength;return this.response(cached);}
    this.remove(key);
    // A caller cancelling a shared transfer must not cancel another navigation.
    const shared=this.pending.get(key);
    if(shared){const e=await shared;if(init.signal?.aborted)throw init.signal.reason||new Error('aborted');if(e){this.hits++;this.hitBytes+=e.body.byteLength;return this.response(e);}}
    const epoch=this.epoch;
    let resolve;const promise=new Promise(r=>resolve=r);this.pending.set(key,promise);
    try{
      this.misses++;const r=await load();
      const cc=r.headers.get('cache-control')||'',date=Date.parse(r.headers.get('date')||'')||Date.now(),age=Math.max(Number(r.headers.get('age')||0)*1000,Date.now()-date),m=cc.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)/i);
      const ttl=m?Number(m[1])*1000:Date.parse(r.headers.get('expires')||'')-date;
      if(!r.ok||r.status!==200||(r.url&&new URL(r.url).href!==new URL(url).href)||/\b(no-store|no-cache)\b/i.test(cc)||r.headers.has('set-cookie')||r.headers.get('vary')?.split(',').some(v=>['*','referer'].includes(v.trim().toLowerCase()))||!(ttl>age)||Number(r.headers.get('content-length'))>this.maxBytes){resolve(null);return r;}
      const body=new Uint8Array(await r.arrayBuffer());
      const e={body,status:r.status,statusText:r.statusText,url:r.url||url,headers:[...r.headers],until:Date.now()+Math.min(ttl-age,86400000)};
      // Native fetch transparently decompresses; replay describes decoded bytes.
      e.headers=e.headers.filter(([k])=>!['content-encoding','content-length'].includes(k.toLowerCase()));
      if(body.byteLength<=this.maxBytes&&epoch===this.epoch){while(this.entries.size>=this.maxEntries||this.bytes+body.byteLength>this.maxBytes)this.remove(this.entries.keys().next().value);this.entries.set(key,e);this.bytes+=body.byteLength;}
      resolve(e);return this.response(e);
    }catch(e){resolve(null);throw e;}finally{if(this.pending.get(key)===promise)this.pending.delete(key);}
  }
}
