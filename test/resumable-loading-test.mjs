import assert from 'node:assert/strict';
import http from 'node:http';
import {QjsSession} from '../src/session.js';
import {CdpConnection} from '../src/cdp.js';
const hits=new Map();
const server=http.createServer((req,res)=>{
 hits.set(req.url,(hits.get(req.url)||0)+1);
 if(req.url.startsWith('/style')){res.setHeader('content-type','text/css');res.end('body{margin:0}#out{width:123px;height:20px;background:green}');}
 else if(req.url.startsWith('/script')){res.setHeader('content-type','application/javascript');res.end(`globalThis.order??=[];order.push(${Number(new URL(req.url,'http://x').searchParams.get('i'))});document.querySelector('#out').textContent=String(order.length);`);}
 else if(req.url==='/module.js')res.end(`import {n} from './dep.js';globalThis.moduleReady=n;`);
 else if(req.url==='/dep.js')res.end('export const n=42;');
 else res.end('not found');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const s=new QjsSession({waitUntil(){}},{}),frames=[],c=new CdpConnection(s,{send(raw){frames.push(JSON.parse(raw));}});let seq=0;
const command=async(method,params={})=>{const id=++seq;c.onMessage(JSON.stringify({id,method,params}));await c.chain;await c.sendChain;const f=frames.find(f=>f.id===id);assert.ok(!f.error,JSON.stringify(f));return f.result;};
const value=code=>s.engine.callGlobal('eval',code).value;
try{
 await command('Page.enable');
 const html=`<html><head>${Array.from({length:45},(_,i)=>`<link rel="stylesheet" href="${base}/style?i=${i}">`).join('')}${Array.from({length:43},(_,i)=>`<script src="${base}/script?i=${i}"></script>`).join('')}</head><body><div id="out">waiting</div></body></html>`;
 const nav=await command('Page.navigate',{url:'data:text/html,'+encodeURIComponent(html),resourceBatch:40});
 const id=nav.loading.id;
 assert.equal(nav.loading.status,'pending');assert.equal(nav.loading.cachedResources,40);assert.equal(nav.loading.remainingResources,5);
 assert.equal(value('typeof order'),'undefined');assert.equal(value('document.readyState'),'loading');
 assert.equal(frames.filter(f=>f.method==='Page.loadEventFired').length,0);
 const engine=s.engine;
 await command('Page.captureScreenshot');assert.equal(hits.size,40,'screenshot must retain exhausted batch');
 const second=await command('Browser.continueLoading',{id,requests:40});
 assert.equal(second.status,'pending');assert.equal(second.stage,'scripts');assert.equal(second.cachedResources,45);assert.equal(second.cachedScripts,35);assert.equal(value('typeof order'),'undefined');
 const response=await s.fetch(new Request('https://do.local/s/test/continue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,requests:40})}));
 const third=await response.json();assert.equal(third.status,'complete',JSON.stringify(third));assert.equal(third.page.status,'executed');assert.equal(s.engine,engine);
 assert.deepEqual(value('order'),Array.from({length:43},(_,i)=>i));assert.equal(value(`document.querySelector('#out').textContent`),'43');assert.equal(value(`document.querySelector('#out').getBoundingClientRect().width`),123);
 await c.sendChain;assert.equal(frames.filter(f=>f.method==='Page.loadEventFired').length,1);
 assert.equal(hits.size,88);assert.ok([...hits.values()].every(n=>n===1),'completed resources must never download twice');
 await command('Browser.continueLoading',{id});assert.equal(value('order.length'),43,'completed continuation cannot replay scripts');
 await command('Page.navigate',{url:'about:blank'});
 await assert.rejects(()=>s.continueLoading({id}),/stale/);
 console.log('PASS 88 resources over 40/40/8 batches; memory and DOM retained, no duplicate fetch or script execution, no premature load event, HTTP and CDP continuation');
 await s.runPageScripts(`<html><head><script type="module" src="${base}/module.js"></script></head><body></body></html>`,base,{executeScripts:true,resourceBatch:1});
 assert.equal(s.pageStatus.status,'pending');assert.equal(value('typeof moduleReady'),'undefined');
 const moduleId=s.pageLoad.id;
 await Promise.all([1,2].map(()=>s.fetch(new Request('https://do.local/s/test/continue',{method:'POST',body:JSON.stringify({id:moduleId,requests:1})}))));assert.equal(s.pageStatus.status,'executed',JSON.stringify(s.pageStatus));assert.equal(value('moduleReady'),42);
 assert.equal(hits.get('/module.js'),1);assert.equal(hits.get('/dep.js'),1);
 s.reset();await assert.rejects(()=>s.continueLoading({id}),/lost/);
 console.log('PASS module graph resumes between entry and dependency; reset rejects stale continuation');
}finally{c.close();s.engine?.dispose();server.closeAllConnections();server.close();}
