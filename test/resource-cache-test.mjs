import assert from 'node:assert/strict';
import {ResourceCache} from '../src/resource-cache.js';
import {QjsSession} from '../src/session.js';
const cache=new ResourceCache(32,2);let calls=0;
const load=async(headers={})=>{calls++;return new Response('abc',{headers:{'cache-control':'max-age=60',...headers}});};
const get=(url='https://test/a',init={},headers={})=>cache.fetch(url,init,()=>load(headers));
await get();assert.equal(await (await get()).text(),'abc');assert.equal(calls,1);
await Promise.all([get('https://test/b'),get('https://test/b')]);assert.equal(calls,2);
await get('https://test/a',{headers:{referer:'https://test/topic-b'}});assert.equal(calls,2);
await get('https://test/a?q=1');assert.equal(calls,3);
await get('https://test/a',{headers:{authorization:'other'}});assert.equal(calls,4);assert.ok(cache.stats().entries<=2);assert.ok(!cache.entries.has(cache.key('https://test/b',{})));
for(const headers of [{'cache-control':'no-cache'},{'cache-control':'no-store'},{'cache-control':'max-age=0'},{'set-cookie':'a=b'},{vary:'*'},{vary:'Referer'}]){cache.clear();await get(undefined,{},headers);await get(undefined,{},headers);assert.equal(cache.stats().entries,0);}
cache.clear();await assert.rejects(()=>cache.fetch('https://test/a',{},async()=>{throw new Error('download failed')}));await get();assert.equal(cache.stats().entries,1);
cache.entries.values().next().value.until=0;const n=calls;await get();assert.equal(calls,n+1);
cache.clear();await get(undefined,{method:'POST'});assert.equal(cache.stats().entries,0);
const s=new QjsSession({waitUntil(){}},{});let network=0;
s.smartFetch=async url=>{network++;return new Response(`globalThis.runs=(globalThis.runs||0)+1;document.body.setAttribute('data-page',location.pathname);`,{headers:{'content-type':'text/javascript','cache-control':'max-age=600'}});};
for(const path of ['a','b','a']){await s.runPageScripts('<html><head><script src="/common.js"></script></head><body></body></html>','https://test/'+path,{resourceBatch:1});assert.equal(s.engine.callGlobal('eval','runs').value,1);assert.equal(s.engine.callGlobal('eval','document.body.getAttribute("data-page")').value,'/'+path);}
assert.equal(network,1);assert.equal(s.resourceCache.stats().hits,2);
s.reset();assert.equal(s.resourceCache.stats().entries,0);
console.log('PASS cache freshness, variants, credentials, query strings, eviction, failure retry, concurrent fetches, cross-navigation A/B/A and fresh globals');
