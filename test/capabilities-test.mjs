import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {relayFetch} from '../src/net/relay.js';
import {QjsSession} from '../src/session.js';
import {ModuleResolver,moduleSpecifiers} from '../src/module-resolver.js';
import {PAGE_LIMITS} from '../src/page-scripts.js';
const make=()=>new QjsSession({waitUntil(){}},{});
const evaluate=(s,code)=>{const r=s.engine.callGlobal('eval',code);assert.ok(r.ok,JSON.stringify(r));return r.value;};
const page=(scripts)=>`<!doctype html><html><head>${scripts}</head><body><p id="out">original</p></body></html>`;
const opts={executeScripts:true};

const resolver=new ModuleResolver('https://unit.test/',[JSON.stringify({imports:{'lib/':'./lib/','blocked':null},scopes:{'./lib/':{'dep':'./scoped.js'}}})]);
assert.equal(resolver.resolve('https://unit.test/main.js','lib/a.js'),'https://unit.test/lib/a.js');
assert.equal(resolver.resolve('https://unit.test/lib/a.js','dep'),'https://unit.test/scoped.js');
assert.equal(resolver.resolve('https://unit.test/main.js','unmapped'),null);
assert.equal(resolver.resolve('https://unit.test/main.js','blocked'),null);
assert.equal(resolver.resolve('https://unit.test/main.js','lib/../escape.js'),null);
assert.deepEqual(moduleSpecifiers(`const x='import("fake")'; /* import 'comment' */ export {x} from './real.js'; import('./dynamic.js');`),['./real.js','./dynamic.js']);
console.log('PASS import maps, scoped resolution and lexical dependency discovery');

const mapped=make(),urls=[];
const sources={
 '/main.js':`import {value} from 'lib/a.js'; document.querySelector('#out').textContent=value;`,
 '/lib/a.js':`export {value} from 'dep';`,
 '/scoped.js':`export const value='hydrated';`,
};
mapped.smartFetch=async(url)=>{urls.push(url);return new Response(sources[new URL(url).pathname]||'',{status:sources[new URL(url).pathname]?200:404});};
await mapped.runPageScripts(page(`<script type="importmap">${JSON.stringify({imports:{'lib/':'./lib/'},scopes:{'./lib/':{'dep':'./scoped.js'}}})}</script><script type="module" src="/main.js"></script>`),'https://unit.test/',opts);
assert.equal(mapped.pageStatus.status,'executed',JSON.stringify(mapped.pageStatus));
assert.equal(evaluate(mapped,`document.querySelector('#out').textContent`),'hydrated');
assert.equal(urls.length,3);
assert.ok(urls.every((u)=>u.startsWith('https://unit.test/')));
mapped.engine.dispose();
console.log('PASS real QuickJS module linking uses the same scoped aliases as prefetch');

const observed=make();
await observed.runPageScripts(page(`<script>globalThis.seen=0;const observer=new MutationObserver(records=>{seen+=records.length;observer.disconnect()});observer.observe(document.body,{childList:true,subtree:true});document.querySelector('#out').textContent='changed';globalThis.currentScriptWorks=!!document.currentScript;globalThis.inputWorks=document.createElement('input') instanceof HTMLInputElement;setTimeout(()=>{globalThis.timerWorks=true},0);</script>`),'https://unit.test/',opts);
assert.equal(observed.pageStatus.status,'executed',JSON.stringify(observed.pageStatus));
assert.ok(evaluate(observed,'seen')>0);
assert.equal(evaluate(observed,'currentScriptWorks'),true);
assert.equal(evaluate(observed,'inputWorks'),true);
assert.equal(evaluate(observed,'timerWorks'),true);
assert.equal(evaluate(observed,'document.readyState'),'complete');
observed.engine.dispose();
console.log('PASS genuine DOM observers, element identity, currentScript and bounded timers');

for(const [name,code,expected] of [
 ['exception',`document.body.innerHTML='<p>partial</p>'; throw new TypeError('missingCapability');`,'missingCapability'],
 ['rejection',`Promise.reject(new Error('rejectedCapability'))`,'rejectedCapability'],
 ['loop',`while(true){}`,'budget'],
 ['microtasks',`const again=()=>Promise.resolve().then(again);again();`,'budget'],
]){
 const s=make(),t=performance.now();
 await s.runPageScripts(page(`<script>${code}</script>`),'https://unit.test/',opts);
 assert.equal(s.pageStatus.status,'degraded',JSON.stringify(s.pageStatus));
 assert.ok(JSON.stringify(s.pageStatus.errors).includes(expected),JSON.stringify(s.pageStatus));
 if(name==='exception')assert.equal(evaluate(s,`document.body.textContent`),'partial');
 else assert.equal(evaluate(s,`document.querySelector('#out').textContent`),'original');
 assert.equal(s.engine.jobPending(),false);
 assert.equal(evaluate(s,'20+22'),42);
 assert.ok(performance.now()-t<10000,name+' exceeded CPU regression gate');
 s.engine.dispose();
}
console.log('PASS ordinary exceptions preserve page mutations; runaway execution remains bounded');

const optionalFailure=make();
optionalFailure.smartFetch=async()=>new Response('unavailable',{status:503});
await optionalFailure.runPageScripts(page(`<script src="/optional.js"></script><script>document.querySelector('#out').textContent='app continued';document.addEventListener('DOMContentLoaded',()=>{globalThis.readyCalls=(globalThis.readyCalls||0)+1});setTimeout(()=>{globalThis.timerAfterFailure=true},0);</script><script>throw new Error('ordinary exception')</script><script>globalThis.afterException=true;</script>`),'https://unit.test/',opts);
assert.equal(optionalFailure.pageStatus.status,'degraded');
assert.equal(evaluate(optionalFailure,`document.querySelector('#out').textContent`),'app continued');
assert.equal(evaluate(optionalFailure,'afterException'),true);assert.equal(evaluate(optionalFailure,'timerAfterFailure'),true);assert.equal(evaluate(optionalFailure,'readyCalls'),1);
assert.ok(optionalFailure.pageStatus.errors.some(e=>e.reason==='script-fetch'));
optionalFailure.engine.dispose();
console.log('PASS missing third-party scripts and ordinary exceptions preserve app execution, timers and one DOMContentLoaded');

const noscript=make();let noscriptFetches=0;
noscript.smartFetch=async()=>{noscriptFetches++;throw new Error('noscript resource must not load');};
await noscript.runPageScripts(page(`<noscript><img src="/fallback.png"><p>fallback-only</p></noscript><script>globalThis.scriptPageActive=true</script>`),'https://linux.do/t/topic/1',opts);
assert.equal(noscript.pageStatus.status,'executed');assert.equal(noscriptFetches,0);assert.equal(evaluate(noscript,'scriptPageActive'),true);assert.equal(evaluate(noscript,`document.querySelectorAll('noscript').length`),0);
noscript.engine.dispose();console.log('PASS script-enabled pages do not fetch or render noscript fallback resources');

const giant=make();
giant.cdpEarlyScripts=[{src:'console.log("trusted-automation-once")'}];
const largeSource='/*'+'x'.repeat(3825007)+'*/globalThis.largeModuleRan=true;export const ok=42;';
giant.smartFetch=async()=>new Response(largeSource);
await giant.runPageScripts(page('<script type="module" src="/giant.js"></script>'),'https://unit.test/',opts);
assert.equal(giant.pageStatus.status,'executed',JSON.stringify(giant.pageStatus));
assert.equal(evaluate(giant,'largeModuleRan'),true);
assert.equal(giant.log.filter(line=>line.includes('trusted-automation-once')).length,1);
assert.equal(giant.pageStatus.sourceBytes,new TextEncoder().encode(largeSource).length);
giant.engine.dispose();
console.log('PASS multi-megabyte modules reach real QuickJS compilation and execution');
const oversized=make();
oversized.smartFetch=async()=>new Response('',{headers:{'content-length':String(PAGE_LIMITS.totalBytes+1)}});
await oversized.runPageScripts(page('<script src="/oversized.js"></script>'),'https://unit.test/',opts);
assert.equal(oversized.pageStatus.status,'degraded');assert.equal(oversized.pageStatus.executed,0);
assert.ok(JSON.stringify(oversized.pageStatus.errors).includes('size budget'));
oversized.engine.dispose();
console.log('PASS total source memory bound still rejects oversized responses before download');

const data=make();
const dataHtml=page(`<script type="application/json" id="data-preloaded">${JSON.stringify({value:'preserved',padding:'x'.repeat(200000)})}</script><script>document.querySelector('#out').textContent=JSON.parse(document.querySelector('#data-preloaded').textContent).value</script>`);
await data.runPageScripts(dataHtml,'https://unit.test/',opts);
assert.equal(data.pageStatus.status,'executed',JSON.stringify(data.pageStatus));
assert.equal(evaluate(data,`document.querySelector('#out').textContent`),'preserved');
assert.ok(data.pageStatus.sourceBytes<1000);
data.engine.dispose();
console.log('PASS large JSON bootstrap data is preserved and excluded from JS source budget');

const fetchPage=make();fetchPage.smartFetch=async()=>new Response('{"value":"fetched"}',{headers:{'content-type':'application/json'}});
await fetchPage.runPageScripts(page(`<script>fetch('/data').then(r=>r.json()).then(x=>{document.querySelector('#out').textContent=x.value})</script>`),'https://unit.test/',opts);
assert.equal(fetchPage.pageStatus.status,'executed',JSON.stringify(fetchPage.pageStatus));
assert.equal(evaluate(fetchPage,`document.querySelector('#out').textContent`),'fetched');fetchPage.engine.dispose();
console.log('PASS bounded page fetch resolves promises and updates the DOM');

const server=http.createServer(()=>{});
await new Promise((r)=>server.listen(0,'127.0.0.1',r));
const slow=make();let begin=performance.now();
try{
 await assert.rejects(()=>slow.fetchDocument(`http://127.0.0.1:${server.address().port}/`));
 assert.equal(slow.pageStatus.reason,'document-timeout');
 assert.ok(performance.now()-begin<11500);
 const scripts=make();begin=performance.now();
 await scripts.runPageScripts(page(`<script src="http://127.0.0.1:${server.address().port}/hang.js"></script>`),'https://unit.test/',opts);
 assert.equal(scripts.pageStatus.status,'degraded');
 assert.ok(performance.now()-begin<PAGE_LIMITS.networkMs+1500);
 scripts.engine.dispose();
}finally{server.closeAllConnections();server.close();}
console.log('PASS document and script network deadlines cancel hanging connections');

const sockets=new Set();
const stalled=net.createServer((sock)=>{sockets.add(sock);sock.on('close',()=>sockets.delete(sock));});
await new Promise(r=>stalled.listen(0,'127.0.0.1',r));
try{
 const t=performance.now();
 await assert.rejects(()=>relayFetch('127.0.0.1:'+stalled.address().port,'https://example.com/',{signal:AbortSignal.timeout(80)}));
 assert.ok(performance.now()-t<1500);
}finally{for(const sock of sockets)sock.destroy();stalled.close();}
console.log('PASS relay cancellation closes stalled TCP/TLS work');

const guarded=make();guarded.ensure();
guarded.engine.addModuleSource('https://guard.test/large.js',"export const value='"+'x'.repeat(80)+"';");
guarded.engine.beginScope(150,32,64);
guarded.engine.eval("import('https://guard.test/large.js').catch(e=>{globalThis.guardError=e.message})",'https://guard.test/main.js',false);
guarded.engine.drainJobs();guarded.engine.endScope();
assert.ok(evaluate(guarded,'guardError').includes('source budget'));
guarded.engine.beginScope(1,49152,131072);
let tripped=false;
for(let i=0;i<100;i++){guarded.engine.callGlobal('eval','for(let j=0;j<100;j++){}');if(guarded.engine.scopeExhausted()){tripped=true;break;}}
guarded.engine.endScope();
assert.ok(tripped,'successive VM calls must share one instruction budget');
assert.equal(evaluate(guarded,'6*7'),42);guarded.engine.dispose();
console.log('PASS native compile guard and cumulative cross-call instruction budget');
