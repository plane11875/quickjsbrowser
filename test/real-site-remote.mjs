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
assert.ok(secrets.QJSB_RELAY_IP,'Set QJSB_RELAY_IP to select the SNI relay explicitly');
const report={target,at:new Date().toISOString(),viewport:{width:1024,height:768},scriptExecution:'explicitly enabled',route:'configured SNI relay'};
let c;
try{
 c=await connect('real-topic-2999210',secrets.QJSB_RELAY_IP);report.sid=c.sid;
 await c.send('Page.enable');await c.send('Runtime.enable');
 await c.send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
 await c.send('Emulation.setScriptExecutionDisabled',{value:false});
 const initialState=await c.state();report.durableObjectId=initialState.durableObjectId;fs.writeFileSync(out+'/result.json',JSON.stringify(report,null,2));
 const start=performance.now();const nav=await c.send('Page.navigate',{url:target,resourceBatch:32});
 report.navigationMs=Math.round(performance.now()-start);report.navigation=nav;
 if(nav.errorText)throw new Error(nav.errorText);
 let state=nav.loading;report.batches=[state];
 for(let batch=0;state.status==='pending'&&batch<20;batch++){
   state=await c.send('Browser.continueLoading',{id:state.id,requests:32});report.batches.push(state);
 }
 report.finalState=state;
 report.document=JSON.parse(await c.value(`JSON.stringify({url:location.href,title:document.title,text:document.body.textContent.slice(0,12000),links:[...document.querySelectorAll('a[href]')].slice(0,30).map(a=>({text:a.textContent,href:a.href}))})`));
 fs.writeFileSync(out+'/loaded-dom.html',await c.value('document.documentElement.outerHTML'));
 report.screenshot=await c.shot('linux-topic-2999210');
 const runtimeState=await c.state();report.page=runtimeState.page;report.durableObjectId=runtimeState.durableObjectId;
 report.applicationComplete=state.status==='complete'&&report.page.status==='executed';
 if(!report.applicationComplete)process.exitCode=2;
 console.log(JSON.stringify({target,title:report.document.title,status:state.status,page:report.page,batches:report.batches.map(b=>({stage:b.stage,status:b.status,cachedResources:b.cachedResources,cachedScripts:b.cachedScripts,remainingResources:b.remainingResources})),screenshot:report.screenshot,applicationComplete:report.applicationComplete}));
}catch(e){report.error=e.message;console.error(e.message);process.exitCode=1;}
finally{c?.close();fs.writeFileSync(out+'/result.json',JSON.stringify(report,null,2));}
