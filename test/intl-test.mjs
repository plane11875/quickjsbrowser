// test/intl-test.mjs — Intl/Temporal + JSON modules + import attributes + outbox 溢出
// 这几项都改在 C 侧（engine.c），单测它们才能证明改动真的生效。
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const mod = new WebAssembly.Module(fs.readFileSync(ROOT + 'src/engine.wasm'));
const TE = new TextEncoder(), TD = new TextDecoder();
let mem;
const wasi = {
  clock_time_get: (_i, _p, o) => { new DataView(mem.buffer).setBigUint64(o, BigInt(Date.now()) * 1000000n, true); return 0; },
  fd_write: (_f, _i, _n, o) => { new DataView(mem.buffer).setUint32(o, 0, true); return 0; },
  fd_close: () => 0, fd_seek: () => 29,
  fd_read: () => 8, fd_fdstat_get: () => 8, fd_fdstat_set_flags: () => 8,
  fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8,
  path_open: () => 8, path_readlink: () => 8,
  environ_sizes_get: (c, s) => { const d = new DataView(mem.buffer); d.setUint32(c, 0, true); d.setUint32(s, 0, true); return 0; },
  environ_get: (e, b) => { const d = new DataView(mem.buffer); d.setUint32(e, 0, true); d.setUint32(b, 0, true); return 0; },
  proc_exit: (c) => { throw new Error('proc_exit ' + c); },
};
const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi, browser:{layout:()=>-1} });
mem = inst.exports.memory;
inst.exports._initialize();
const E = inst.exports;
E.qjs_new();
E.qjs_set_limits(256 * 1024 * 1024, 1024 * 1024, 3000000);
E.qjs_enable_interrupt();
const read = (p) => TD.decode(new Uint8Array(mem.buffer, Number(p & 0xffffffffn), Number(p >> 32n)));
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
const put = (url, src, kind = 0) => {
  const ub = TE.encode(url), sb = TE.encode(src);
  const all = new Uint8Array(5 + ub.length + sb.length);
  new DataView(all.buffer).setUint32(0, ub.length, true);
  all[4] = kind; all.set(ub, 5); all.set(sb, 5 + ub.length);
  const ptr = E.qjs_alloc(all.length);
  new Uint8Array(mem.buffer, ptr, all.length).set(all);
  return E.qjs_add_module_source(all.length);
};
const tasks = () => JSON.parse(read(E.qjs_take_tasks()));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra);
  cond ? pass++ : fail++;
};
const val = (expr) => { const r = callG('eval', expr); return r.ok ? r.value : 'ERR:' + JSON.stringify(r.error); };
// 本文件不注入 prelude，页面可见的 console 直接由 outbox 代替
run('shim.js', 'globalThis.__log=[]; globalThis.console={log:(...a)=>__hostEnqueue("console",JSON.stringify({level:"log",text:a.join(" ")})),' +
  'error:(...a)=>__hostEnqueue("console",JSON.stringify({level:"error",text:a.join(" ")})),' +
  'warn:()=>{},info:()=>{},debug:()=>{},trace:()=>{}};', false);

// I1 Intl.NumberFormat / DateTimeFormat（含时区）
check('I1 Intl.NumberFormat', val('new Intl.NumberFormat("en-US").format(1234567.891)') === '1,234,567.891',
  val('new Intl.NumberFormat("en-US").format(1234567.891)'));
// quickjs 编译进来的 tzdata 只有 49 个时区（vendor/quickjs/temporal/tzdata_generated.c
// 由 gen_tzdata.py 生成）；Asia/Tokyo 在表内，Asia/Shanghai 不在 → 退回 UTC。
check('I1b 内嵌 tzdata 生效（Asia/Tokyo = +9）',
  val('new Intl.DateTimeFormat("en",{timeZone:"Asia/Tokyo",hour:"2-digit",hour12:false}).format(new Date(0))') === '09',
  val('new Intl.DateTimeFormat("en",{timeZone:"Asia/Tokyo",hour:"2-digit",hour12:false}).format(new Date(0))'));
check('I1c 表外时区退回 UTC（已知边界，非崩溃）',
  val('new Intl.DateTimeFormat("en",{timeZone:"Asia/Shanghai",hour:"2-digit",hour12:false}).format(new Date(0))') === '00',
  val('new Intl.DateTimeFormat("en",{timeZone:"Asia/Shanghai",hour:"2-digit",hour12:false}).format(new Date(0))'));
check('I1d Intl.RelativeTimeFormat', val('new Intl.RelativeTimeFormat("en",{numeric:"auto"}).format(-1,"day")') === 'yesterday',
  val('new Intl.RelativeTimeFormat("en",{numeric:"auto"}).format(-1,"day")'));
check('I1e Intl.PluralRules', val('new Intl.PluralRules("en").select(2)') === 'other',
  val('new Intl.PluralRules("en").select(2)'));
check('I1f Intl.ListFormat', val('typeof new Intl.ListFormat("en").format === "function"') === true);

// I2 Temporal
check('I2 Temporal.PlainDate', val('Temporal.PlainDate.from("2026-10-14").toString()') === '2026-10-14',
  val('String(Temporal && Temporal.PlainDate && Temporal.PlainDate.from("2026-10-14"))'));
check('I2b Temporal.Instant + 内嵌时区', val('Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("Asia/Tokyo").hour') === 9,
  val('String(Temporal && Temporal.Instant && Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("Asia/Tokyo").hour)'));

// I3 JSON modules（宿主注册 kind=1，无 import attributes）
put('https://cdn.test/data.json', '{"a":1,"b":[2,3],"s":"hi"}', 1);
check('I3 JSON module（kind=1）', run('https://app.test/m.js', 'import d from "https://cdn.test/data.json"; globalThis.j=d;', true) === 0);
check('I3b JSON module 值', val('JSON.stringify(globalThis.j)') === '{"a":1,"b":[2,3],"s":"hi"}', val('JSON.stringify(globalThis.j)'));

// I4 import attributes：type:'json'（源码注册为 JS，但 attributes 指定 json）
put('https://cdn.test/attr.json', '{"k":"v"}', 0);
check('I4 import attributes type=json', run('https://app.test/m2.js', 'import d from "https://cdn.test/attr.json" with { type: "json" }; globalThis.j2=d;', true) === 0,
  JSON.stringify(tasks()));
check('I4b attributes JSON 值', val('JSON.stringify(globalThis.j2)') === '{"k":"v"}', val('JSON.stringify(globalThis.j2)'));

// I5 不支持的 attribute 类型要报错（页面可捕获）
run('https://app.test/m3.js', 'import("https://cdn.test/attr.json", { with: { type: "css" } }).catch(e => globalThis.e3 = String(e).slice(0, 60));', false);
E.qjs_exec_job();
check('I5 不支持的 attribute 抛错', String(val('globalThis.e3')).includes('unsupported module attribute type'),
  String(val('globalThis.e3')));

// I6 单次 eval 里海量日志：不打断脚本，且溢出被显式上报（不是静默丢）
tasks();
run('t.js', 'globalThis.thrown=0; try{ for(let i=0;i<70000;i++) console.log("L"+i); }catch(e){ globalThis.thrown=1; globalThis.err=String(e); }');
check('I6 7 万条日志不打断脚本', val('globalThis.thrown') === 0, String(val('globalThis.err')));
check('I6b 溢出被上报为 outbox_dropped', tasks().some((t) => t.kind === 'outbox_dropped'));

// I7 同 URL 重新注册的语义边界：只在"该 URL 还没被 import 过"时生效。
// 已 import 过的 URL 由 quickjs 模块注册表按 URL 唯一持有，quickjs 未暴露
// 模块失效 API，换新源码也换不掉（README「v1 已知边界」已记）。
put('https://cdn.test/mut.js', 'export const v = 1;', 0);
run('https://app.test/m4.js', 'import {v} from "https://cdn.test/mut.js"; globalThis.m1=v;', true);
put('https://cdn.test/mut.js', 'export const v = 2;', 0);
run('https://app.test/m6.js', 'import {v} from "https://cdn.test/mut.js"; globalThis.m2=v;', true);
check('I7 已 import 过的 URL 不受重注册影响（已知边界）',
  val('JSON.stringify([globalThis.m1,globalThis.m2])') === '[1,1]',
  val('JSON.stringify([globalThis.m1,globalThis.m2])'));
// 未 import 过的 URL：最后一次注册生效
put('https://cdn.test/fresh.js', 'export const v = 1;', 0);
put('https://cdn.test/fresh.js', 'export const v = 7;', 0);
run('https://app.test/m7.js', 'import {v} from "https://cdn.test/fresh.js"; globalThis.m3=v;', true);
check('I7b 未 import 过的 URL 用最后一次注册', val('globalThis.m3') === 7, String(val('globalThis.m3')));

// I8 qjs_run_gc 存在且不炸
let gcOk = true;
try { E.qjs_run_gc(); } catch (e) { gcOk = false; }
check('I8 qjs_run_gc 可调用', gcOk);

// I9 微任务泵中断预算按批重置：重 Promise 链不再"全挂"
run('t9.js', 'globalThis.n=0; for(let i=0;i<40000;i++) Promise.resolve(i).then(v=>{globalThis.n+=v;});');
const n1 = E.qjs_job_pending() ? (() => { let k = 0; E.qjs_interrupt_reset(); while (E.qjs_job_pending() && k++ < 200000) E.qjs_exec_job(); })() : 0;
check('I9 4 万个微任务抽干', val('globalThis.n') === 799980000, String(val('globalThis.n')) + ' jobs=' + n1);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);