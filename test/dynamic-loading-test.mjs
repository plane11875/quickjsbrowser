import assert from 'node:assert/strict';
import {QjsSession} from '../src/session.js';
const s=new QjsSession({waitUntil(p){p.catch(()=>{})}},{}),urls=[];
const source={
 '/feature.js':`import {value} from './value.js';globalThis.moduleRuns=(globalThis.moduleRuns||0)+1;export default value;`,
 '/value.js':`export const value='loaded';`,
 '/unused.js':`throw Error('unused dynamic module must not be fetched');`,
};
s.smartFetch=async(url)=>{urls.push(url);const code=source[new URL(url).pathname];return new Response(code||'',{status:code?200:404,headers:{'cache-control':'max-age=600'}});};
const html=`<html><head><script type="module">globalThis.bootRuns=(globalThis.bootRuns||0)+1;const name='feature';import('./'+name+'.js').then(m=>{document.querySelector('#result').textContent=m.default;});globalThis.unused=()=>import('./unused.js');</script></head><body><p id="result">pending</p></body></html>`;
await s.runPageScripts(html,'https://test/',{resourceBatch:1,serialize:false});
assert.equal(s.loadingState().status,'pending');assert.equal(s.engine.callGlobal('eval','bootRuns').value,1);
await s.continueLoading({id:s.pageLoad.id,requests:1});
assert.equal(s.loadingState().status,'complete',JSON.stringify(s.pageStatus));
assert.equal(s.engine.callGlobal('eval','document.querySelector("#result").textContent').value,'loaded');
assert.equal(s.engine.callGlobal('eval','moduleRuns').value,1);assert.equal(s.engine.callGlobal('eval','bootRuns').value,1);
assert.equal(s.engine.memoryStats().sourceBytes,0,'compiled sources must release transport copies');
assert.deepEqual(urls,['https://test/feature.js','https://test/value.js']);
s.reset();console.log('PASS runtime dynamic import expression, static dependency closure, resource-batch resume without repeating effects, and unused dynamic module stays unloaded');
