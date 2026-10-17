// Real website capture; exit 2 when the application did not complete, even if a PNG was produced.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const secrets={QJSB_KEY:process.env.QJSB_KEY,QJSB_RELAY_IP:process.env.QJSB_RELAY_IP};
assert.ok(secrets.QJSB_KEY,'Set QJSB_KEY in the private environment');
const base=process.env.QJSB_BASE||'https://quickjsbrowser.berry55.workers.dev',out=process.env.QJSB_TEST_OUTPUT||'.cache/real-site';fs.mkdirSync(out,{recursive:true});
async function connect(name,proxy){
 const sid='flow-live-'+randomUUID(),u=new URL('/cdp',base);u.protocol='wss:';u.searchParams.set('key',secrets.QJSB_KEY);u.searchParams.set('s',sid);if(proxy)u.searchParams.set('proxy',proxy);
 const ws=new WebSocket(u),pending=new Map(),events=[];let id=0;
 ws.addEventListener('message',event=>{const f=JSON.parse(String(event.data));if(f.method)events.push(f);const p=pending.get(f.id);if(p){pending.delete(f.id);clearTimeout(p.timer);f.error?p.reject(new Error(f.error.message)):p.resolve(f.result);}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WebSocket open timed out')),15000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('WebSocket connection failed'));},{once:true});});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error(method+' timed out'));},45000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
 return {sid,events,send,async value(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result?.value;},async state(){const u=new URL('/s/'+sid+'/state',base);u.searchParams.set('key',secrets.QJSB_KEY);return (await fetch(u,{signal:AbortSignal.timeout(10000)})).json();},async shot(label){const t=performance.now(),r=await send('Page.captureScreenshot',{format:'png'}),png=Buffer.from(r.data,'base64');assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');fs.writeFileSync(out+'/'+label+'.png',png);return {ms:Math.round(performance.now()-t),bytes:png.length,hash:createHash('sha256').update(png).digest('hex')};},close(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('connection closed'));}pending.clear();ws.close();}};
}


const target=process.env.QJSB_REAL_URL||'https://linux.do/t/topic/2999210';
const report={target,at:new Date().toISOString(),phases:[]};let c;
const idle=()=>new Promise(r=>setTimeout(r,Number(process.env.QJSB_PHASE_IDLE_MS)||0));
const inspect=()=>c.value(`JSON.stringify({url:location.href,title:document.title,posts:document.querySelectorAll('.topic-post').length,cooked:[...document.querySelectorAll('.cooked')].map(n=>n.textContent).join(' '),header:!!document.querySelector('.d-header'),splash:!!document.querySelector('#d-splash'),links:[...document.querySelectorAll('a[href]')].map(a=>({text:a.textContent.trim().slice(0,100),href:new URL(a.getAttribute('href'),location.href).href})).filter(a=>a.href.includes('/t/'))})`);

async function navigate(url,label){
 const startedAt=new Date().toISOString(),before=await c.state(),start=performance.now(),nav=await c.send('Page.navigate',{url,resourceBatch:32});assert.ok(!nav.errorText,nav.errorText);let state=nav.loading,batches=1;
 while(state.status==='pending'&&batches++<40)state=await c.send('Browser.continueLoading',{id:state.id,requests:32});
 const document=JSON.parse(await inspect()),after=await c.state();
 const phase={label,url,startedAt,endedAt:new Date().toISOString(),wallMs:Math.round(performance.now()-start),batches,document,page:after.page,cache:after.resourceCache,routes:after.routes,cacheDelta:Object.fromEntries(['hits','hitBytes','misses'].map(k=>[k,after.resourceCache[k]-before.resourceCache[k]])),networkDelta:(after.routes.relay+after.routes.direct)-(before.routes.relay+before.routes.direct)};
 report.phases.push(phase);fs.writeFileSync(out+'/result.json',JSON.stringify(report,null,2));
 phase.screenshot=await c.shot(label);
 assert.ok(document.posts>0&&document.cooked.trim().length>100&&document.header&&!document.splash,'Real Discourse UI did not become ready');assert.equal(after.page.status,'executed',JSON.stringify(after.page));
 console.log(JSON.stringify({label,title:document.title,wallMs:phase.wallMs,batches,cache:phase.cacheDelta,network:phase.networkDelta,posts:document.posts}));return phase;
}
try{
 assert.ok(secrets.QJSB_RELAY_IP,'QJSB_RELAY_IP required');c=await connect('real-cache-flow',secrets.QJSB_RELAY_IP);report.sid=c.sid;report.durableObjectId=(await c.state()).durableObjectId;
 await c.send('Page.enable');await c.send('Runtime.enable');await c.send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
 const a=await navigate(target,'cold-a');await idle();
 const b=process.env.QJSB_SECOND_URL||a.document.links.find(l=>l.href.startsWith('https://linux.do/t/')&&!l.href.includes('/2999210'))?.href;
 assert.ok(b,'No second real topic link found');report.secondUrl=b;
 const second=await navigate(b,'warm-b');await idle();assert.notEqual(second.document.title,a.document.title,'Second topic did not replace first document');
 const again=await navigate(target,'warm-a');assert.equal(again.document.title,a.document.title);assert.ok(again.cacheDelta.hitBytes>1000000,'Common resources were not reused');await idle();
 // Activate an actual website link. The DOM click follows the browser event and
 // cancellation path; the application may use SPA history or a document load.
 report.clickStartedAt=new Date().toISOString();const chosen=await c.value(`(()=>{const a=[...document.querySelectorAll('a[href]')].find(a=>{try{return new URL(a.getAttribute('href'),location.href).href===${JSON.stringify(b)}}catch{return false}});if(!a)return false;a.click();return true})()`);
 assert.equal(chosen,true,'Actual second-topic anchor missing');
 let doc;
 for(let attempt=0;attempt<30;attempt++){
   const loading=await c.send('Browser.getLoadingState');if(loading.status==='pending')await c.send('Browser.continueLoading',{id:loading.id,requests:32});
   doc=JSON.parse(await inspect());if(doc.title===second.document.title&&doc.cooked.length>100)break;await new Promise(r=>setTimeout(r,500));
 }
 assert.equal(doc.title,second.document.title,'Click did not reach second topic');report.click={document:doc,endedAt:new Date().toISOString(),screenshot:await c.shot('clicked-b')};await idle();
 // Return through CDP document history and verify the actual first topic again.
 report.returnStartedAt=new Date().toISOString();const history=await c.send('Page.getNavigationHistory');report.history=history;
 const previous=[...history.entries].reverse().find(e=>e.url===target);assert.ok(previous,'First topic missing from CDP history');await c.send('Page.navigateToHistoryEntry',{entryId:previous.id});
 let loading=await c.send('Browser.getLoadingState');while(loading.status==='pending')loading=await c.send('Browser.continueLoading',{id:loading.id,requests:32});
 const returned=JSON.parse(await inspect());assert.equal(returned.title,a.document.title);assert.ok(returned.cooked.length>100);report.returned={document:returned,screenshot:await c.shot('returned-a')};report.finalState=await c.state();report.passed=true;
}catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(c){try{await c.send('Browser.close');}catch{}}c?.close();fs.writeFileSync(out+'/result.json',JSON.stringify(report,null,2));}
