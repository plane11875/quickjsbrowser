import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const base=process.env.QJSB_BASE,key=process.env.QJSB_KEY,out='.cache/capabilities/after';
fs.mkdirSync(out,{recursive:true});
const inline=(script)=>'data:text/html,'+encodeURIComponent(`<html><head><title>Budget probe</title><script>${script}</script></head><body><p id="out">Original content</p></body></html>`);
const cases=[
 {name:'linux-fast',target:'https://linux.do/t/topic/3029893',fast:true},
 {name:'linux-bounded',target:'https://linux.do/t/topic/3029893',bounded:true},
 {name:'example',target:'https://example.com'},
 {name:'module-app',target:'https://raw.githubusercontent.com/plane11875/quickjsbrowser/main/test/fixtures/capability-app.html',bounded:true,expected:'executed'},
 {name:'oversized',target:inline('/*'+'x'.repeat(60000)+'*/document.body.textContent="wrong"'),bounded:true,expected:'degraded'},
 {name:'loop',target:inline('while(true){}'),bounded:true,expected:'degraded'},
];
const reports=[];
for(const test of cases){
 const sid='regression-'+randomUUID(),u=new URL('/cdp',base);u.protocol='wss:';u.searchParams.set('key',key);u.searchParams.set('s',sid);
 const ws=new WebSocket(u);const pending=new Map();let id=0;
 ws.addEventListener('message',event=>{const f=JSON.parse(String(event.data));const task=pending.get(f.id);if(!task)return;pending.delete(f.id);clearTimeout(task.timer);f.error?task.reject(new Error(f.error.message)):task.resolve(f.result);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error(method+' exceeded 6 seconds'));},6000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
 const report={name:test.name,sid,target:test.target.startsWith('data:')?'inline budget probe':test.target};
 try{
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(new Error('WebSocket failed')),{once:true});});
  if(test.bounded)await send('Emulation.setScriptExecutionDisabled',{value:false});
  let t=performance.now();const nav=await send('Page.navigate',{url:test.target});report.navigationMs=performance.now()-t;
  assert.ok(report.navigationMs<3200,'navigation performance gate exceeded');
  if(nav.errorText){report.unavailable=nav.errorText;}
  else{
   const meta=await send('Runtime.evaluate',{expression:'JSON.stringify({title:document.title,text:document.body.textContent.slice(0,1200),out:document.querySelector("#out")?.textContent,observed:document.querySelector("#observed")?.textContent})',returnByValue:true});
   report.meta=JSON.parse(meta.result.value);
   t=performance.now();const shot=await send('Page.captureScreenshot',{format:'png'});report.screenshotMs=performance.now()-t;
   assert.ok(report.screenshotMs<3500,'screenshot performance gate exceeded');
   const png=Buffer.from(shot.data,'base64');assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   report.bytes=png.length;report.sha256=createHash('sha256').update(png).digest('hex');fs.writeFileSync(`${out}/${test.name}.png`,png);
  }
  const stateUrl=new URL(`/s/${sid}/state`,base);stateUrl.searchParams.set('key',key);
  const state=await (await fetch(stateUrl,{signal:AbortSignal.timeout(4000)})).json();report.page=state.page;
  if(test.expected){assert.ok(!report.unavailable,'fixture document unavailable');assert.equal(report.page?.status,test.expected,JSON.stringify(report.page));}
  if(test.name==='module-app'){assert.equal(report.meta.out,'Bounded module app ready');assert.equal(report.meta.observed,'MutationObserver delivered');}
  if(test.name==='oversized'||test.name==='loop')assert.equal(report.meta.out,'Original content');
  report.pass=true;
 }catch(e){report.error=e.message.slice(0,1500);report.pass=false;}
 finally{for(const p of pending.values())clearTimeout(p.timer);ws.close();}
 reports.push(report);fs.writeFileSync(`${out}/results.json`,JSON.stringify(reports,null,2));
 console.log(JSON.stringify({...report,page:report.page?{mode:report.page.mode,status:report.page.status,rendering:report.page.rendering,requests:report.page.requests,reasons:report.page.errors?.map(e=>e.reason)}:undefined,meta:report.meta?{title:report.meta.title,out:report.meta.out,observed:report.meta.observed}:undefined}));
}
assert.ok(reports.every(r=>r.pass),'deployed regression failed');
console.log('REMOTE_CAPABILITY_OK');
