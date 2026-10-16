import assert from 'node:assert/strict';import {QjsEngine} from '../src/engine.js';
const engine=new QjsEngine(),before=engine.memoryStats();
assert.equal(engine.eval('globalThis.heapProbe=new Uint8Array(2*1024*1024)','heap-test.js',false),0);
const large=engine.memoryStats();assert.ok(large.allocatedBytes>=before.allocatedBytes+2*1024*1024,'WASI allocations must include backing bytes');
engine.eval('globalThis.heapProbe=null','heap-test.js',false);engine.exports.qjs_run_gc();const freed=engine.memoryStats();assert.ok(freed.allocatedBytes<large.allocatedBytes-1024*1024);
engine.exports.qjs_set_limits(freed.allocatedBytes+128*1024,512*1024,3000);
assert.equal(engine.eval('globalThis.heapProbe=new Uint8Array(1024*1024)','heap-test.js',false),1,'native memory limit must reject a real oversized allocation');
engine.exports.qjs_set_limits(128*1024*1024,512*1024,3000);assert.equal(engine.callGlobal('eval','6*7').value,42);
engine.dispose();console.log('PASS actual WASI byte accounting, backing-store release, native allocation limit and recovery');
