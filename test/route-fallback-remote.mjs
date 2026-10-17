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


let c;const report={at:new Date().toISOString(),results:[]};
try{
 assert.ok(secrets.QJSB_RELAY_IP,'QJSB_RELAY_IP required');c=await connect('route-probe',secrets.QJSB_RELAY_IP);
 for(const url of ['https://linux.do/t/topic/2999210','https://js.stripe.com/v3/','https://js.stripe.com/v3/pricing-table.js','https://accounts.google.com/gsi/client']){
  const result=await c.value(`fetch(${JSON.stringify(url)}).then(async r=>({status:r.status,url:r.url,bytes:(await r.text()).length}))`);assert.equal(result.status,200,JSON.stringify(result));assert.ok(result.bytes>100);report.results.push(result);
 }
 const before=await c.state();await c.value(`fetch('https://js.stripe.com/v3/pricing-table.js').then(r=>r.text()).then(t=>t.length)`);const after=await c.state();assert.equal(after.routes.relay,before.routes.relay,'known direct origin should not retry SNI');assert.equal(after.routes.direct,before.routes.direct+1);
 report.routes=after.routes;
 const u=new URL('/s/'+c.sid+'/log',base);u.searchParams.set('key',secrets.QJSB_KEY);const log=(await(await fetch(u)).json()).log;
 assert.ok(log.some(line=>line.includes('[route] sni https://linux.do 200')));
 for(const host of ['https://js.stripe.com','https://accounts.google.com'])assert.ok(log.some(line=>line.includes('[route] direct '+host+' 200')));
 report.passed=true;console.log(JSON.stringify(report));
}catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(c){try{await c.send('Browser.close');}catch{}}c?.close();fs.writeFileSync(out+'/result.json',JSON.stringify(report,null,2));}
