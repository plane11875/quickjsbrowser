// test/local-test.mjs — 本地全链路（node 直连 engine.wasm + prelude，模拟 DO 宿主侧）。
// 覆盖：prelude 宿主面（console/定时器/fetch/location/storage/crypto/事件）、
// ESM 预取链、动态 import 拒绝、中断防护。用法：node test/local-test.mjs

import fs from 'node:fs';
import { PRELUDE } from '../src/prelude.js';

const ROOT = new URL('..', import.meta.url).pathname;
const mod = new WebAssembly.Module(fs.readFileSync(ROOT + 'src/engine.wasm'));

let mem;
let exitCode = null;
// 导入面与 src/engine.js 的 wasiStubs 保持一致（Intl/Temporal 引入 preopen/
// environ/path 一组，见 engine.wasiStubs 注释）
const wasi = {
  clock_time_get: (id, prec, out) => {
    new DataView(mem.buffer).setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
    return 0;
  },
  fd_write: (_fd, _i, _n, outp) => { new DataView(mem.buffer).setUint32(outp, 0, true); return 0; },
  fd_close: () => 0,
  fd_seek: () => 29,
  fd_read: () => 8,
  fd_fdstat_get: () => 8,
  fd_fdstat_set_flags: () => 8,
  fd_prestat_get: () => 8,
  fd_prestat_dir_name: () => 8,
  path_open: () => 8,
  path_readlink: () => 8,
  environ_sizes_get: (c, s) => {
    const d = new DataView(mem.buffer);
    d.setUint32(c, 0, true); d.setUint32(s, 0, true); return 0;
  },
  environ_get: (e, b) => {
    const d = new DataView(mem.buffer);
    d.setUint32(e, 0, true); d.setUint32(b, 0, true); return 0;
  },
  proc_exit: (c) => { throw new Error('proc_exit ' + c); },
};
const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi });
mem = inst.exports.memory;
inst.exports._initialize();
const E = inst.exports;
const TE = new TextEncoder();
const TD = new TextDecoder();
const read = (p) => { const ptr = Number(p & 0xffffffffn), l = Number(p >> 32n); return TD.decode(new Uint8Array(mem.buffer, ptr, l)); };
const run = (name, code, isMod = false) => {
  const nb = TE.encode(name), cb = TE.encode(code);
  const all = new Uint8Array(nb.length + cb.length);
  all.set(nb); all.set(cb, nb.length);
  const ptr = E.qjs_alloc(all.length);
  new Uint8Array(mem.buffer, ptr, all.length).set(all);
  return E.qjs_eval(all.length, isMod ? 1 : 0, nb.length);
};
const callG = (name, args) => {
  const ob = TE.encode(name), ab = TE.encode(args);
  const all = new Uint8Array(4 + ob.length + ab.length);
  new DataView(all.buffer).setUint32(0, ob.length, true);
  all.set(ob, 4); all.set(ab, 4 + ob.length);
  const ptr = E.qjs_alloc(all.length);
  new Uint8Array(mem.buffer, ptr, all.length).set(all);
  return JSON.parse(read(E.qjs_call_global(all.length)));
};

if (!E.qjs_new()) throw new Error('qjs_new failed');
E.qjs_set_limits(128 * 1024 * 1024, 512 * 1024, 3000);
E.qjs_enable_interrupt();
if (run('prelude.js', PRELUDE) !== 0) throw new Error('prelude eval failed: ' + read(E.qjs_take_tasks()));

// ---- 模拟宿主侧 ----
const log = [];
const timers = new Map();
let fetches = [];
let randPool = Array.from(crypto.getRandomValues(new Uint8Array(65536)), (c) => String.fromCharCode(c)).join('');

function pump() {
  // 顺序：先抽干微任务（fetch 回喂的 then 链），再收任务；任务处理可能再产生微任务
  for (let round = 0; round < 16; round++) {
    while (E.qjs_job_pending()) E.qjs_exec_job();
    const tasks = JSON.parse(read(E.qjs_take_tasks()));
    if (!tasks.length) break;
    for (const t of tasks) {
      switch (t.kind) {
        case 'console': log.push(`[${t.payload.level}] ${t.payload.text}`); break;
        case 'exception': log.push(`[exception] ${t.payload.message}`); break;
        case 'timer': timers.set(t.payload.id, t.payload); break;
        case 'fetch': fetches.push(t.payload); break;
        case 'navigate': log.push(`[navigate] ${t.payload.url}`); break;
        case 'storage_set': log.push(`[storage_set] ${t.payload.which}:${t.payload.key}=${t.payload.value}`); break;
        case 'need_random': { const b = Array.from(crypto.getRandomValues(new Uint8Array(t.payload.bytes || 4096)), (c) => String.fromCharCode(c)).join(''); randPool += b; break; }
        default: log.push(`[?] ${t.kind}`);
      }
    }
  }
  while (E.qjs_job_pending()) E.qjs_exec_job();
}
const dispatch = (obj) => callG('__dispatch', JSON.stringify(obj));
function fireTimers() {
  // 逐个触发已到期定时器（含 interval 重排）
  for (let round = 0; round < 8; round++) {
    if (!timers.size) break;
    const cur = [...timers.keys()];
    for (const id of cur) {
      const p = timers.get(id);
      if (!p) continue;
      if (!p.interval) timers.delete(id);
      dispatch({ kind: 'timer_fire', id });
      pump();
    }
  }
}

let pass = 0, fail = 0;
const check = (name, cond) => { console.log(cond ? 'PASS' : 'FAIL', name); cond ? pass++ : fail++; };

// T1 console 出队
run('t1.js', 'console.log("hello prelude"); console.error("oops", {a:1});');
pump();
check('T1 console', log.some((l) => l === '[log] hello prelude') && log.some((l) => l.includes('[error] oops {"a":1}')));

// T2 定时器（setTimeout + interval）
run('t2.js', 'globalThis.seq=[]; setTimeout(()=>globalThis.seq.push("t1"),50); const iv=setInterval(()=>globalThis.seq.push("iv"),20); setTimeout(()=>clearInterval(iv),100);');
pump();
fireTimers();
const seq = callG('eval', 'JSON.stringify(globalThis.seq)').value;
check('T2 定时器', seq && seq.includes('t1') && seq.includes('iv') && seq[seq.length - 1] !== 'iv');

// T3 fetch 出队 + 回喂
run('t3.js', 'fetch("https://api.test/data").then(r=>r.json()).then(j=>globalThis.fetched=j).catch(e=>globalThis.fetchErr=String(e));');
pump();
check('T3a fetch 出队', fetches.length === 1 && fetches[0].url === 'https://api.test/data' && fetches[0].method === 'GET');
dispatch({ kind: 'fetch_resolve', id: fetches[0].id, resp: { ok: true, status: 200, statusText: 'OK', url: fetches[0].url, headers: { 'content-type': 'application/json' }, text: '{"n":7}' } });
pump();
check('T3b fetch 回喂', callG('eval', 'JSON.stringify(globalThis.fetched)').value === '{"n":7}');

// T4 location
run('t4.js', 'location.href = "https://ex.test/path?q=1";');
pump();
dispatch({ kind: 'loc', url: 'https://ex.test/path?q=1' });
pump();
check('T4 location', log.some((l) => l === '[navigate] https://ex.test/path?q=1')
  && callG('eval', 'location.pathname').value === '/path'
  && callG('eval', 'location.search').value === '?q=1'
  && callG('eval', 'location.origin').value === 'https://ex.test');

// T5 storage
run('t5.js', 'localStorage.setItem("k","v"); globalThis.got = localStorage.getItem("k"); sessionStorage.setItem("s","2");');
pump();
check('T5 storage', callG('eval', 'globalThis.got').value === 'v' && log.some((l) => l.includes('[storage_set] local:k=v')));

// T6 crypto 池
run('t6.js', 'const a=new Uint8Array(64); crypto.getRandomValues(a); globalThis.randOk = a.some(v=>v!==0);');
pump();
check('T6 crypto', callG('eval', 'globalThis.randOk').value === true);

// T7 ESM 预取链（走 fetch 模拟外部 CDN）
const addSrc = (url, src) => { /* 注册进 C 表走会话同款 */ };
{
  const registry = new Map();
  registry.set('https://cdn.test/lib.js', 'export const base = 40;');
  registry.set('https://cdn.test/app.js', 'import {base} from "./lib.js"; export const val = base + 2;');
  // 先注入 prelude 可见的 fetch 拦截：模块源码表直接喂 C，再 eval
  E; // noop
  const put = (url, src, kind = 0) => {
    const ub = TE.encode(url), sb = TE.encode(src);
    const all = new Uint8Array(5 + ub.length + sb.length);
    new DataView(all.buffer).setUint32(0, ub.length, true);
    all[4] = kind; all.set(ub, 5); all.set(sb, 5 + ub.length);
    const ptr = E.qjs_alloc(all.length);
    new Uint8Array(mem.buffer, ptr, all.length).set(all);
    return E.qjs_add_module_source(all.length);
  };
  put('https://cdn.test/lib.js', registry.get('https://cdn.test/lib.js'));
  put('https://cdn.test/app.js', registry.get('https://cdn.test/app.js'));
  run('https://app.test/main.js', 'import {val} from "https://cdn.test/app.js"; globalThis.mv = val;', true);
  pump();
  check('T7 ESM 链', callG('eval', 'globalThis.mv').value === 42);
}

// T8 动态 import 未预取 → 拒绝且可捕获
run('t8.js', 'import("./missing.js").catch(e=>globalThis.miss=String(e).slice(0,40));');
pump();
E.qjs_exec_job();
check('T8 动态import拒绝', String(callG('eval', 'String(globalThis.miss).includes("not prefetched")').value) === 'true');

// T9 while(true) 拦截
{
  E.qjs_set_interrupt(1, 3000);
  const rc = run('t9.js', 'while(true){}');
  E.qjs_set_interrupt(0, 0);
  pump();
  check('T9 中断拦截', rc === 1);
}

// T10 window/document 事件
run('t10.js', 'globalThis.fired=0; addEventListener("load",()=>globalThis.fired++); document.addEventListener("DOMContentLoaded",()=>globalThis.fired+=10);');
pump();
dispatch({ kind: 'domready' });
pump();
check('T10 事件', callG('eval', 'globalThis.fired').value === 11);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
