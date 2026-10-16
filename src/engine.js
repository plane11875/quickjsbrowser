// engine.js — QuickJS wasm 装载 + C ABI 封装。
// C ABI（engine/engine.c，reactor 模型：实例化后必须先 _initialize）：
//   qjs_new() -> 1/0
//   qjs_alloc(len) -> ptr                       输入缓冲（容量复用）
//   qjs_eval(len, isModule, nameLen) -> 0/1     缓冲布局 [name][code]
//   qjs_add_module_source(len) -> 0/1           布局 [u32 urlLen][u8 kind][url][src]
//                                               kind 0=JS / 1=JSON（后者包成 export default）
//   qjs_call_global(len) -> (ptr|len<<32)       布局 [u32 nameLen][name][args]；args 为
//                                               原始字符串直通 VM（对象载荷 VM 侧 JSON.parse）
//   qjs_exec_job() -> 1/0/2    qjs_job_pending() -> 0/1
//   qjs_take_tasks() -> (ptr|len<<32)           outbox JSON 数组
//   qjs_run_gc()                                显式 GC（换页后回收旧 DOM）
//   qjs_set_limits(mem,stack,budget)  qjs_set_interrupt(on,budget)  qjs_interrupt_reset()
//   qjs_free()
// 导入面：wasi_snapshot_preview1 7 个桩。

import wasmModule from './engine.wasm';
import { PRELUDE } from './prelude.js';
import linkedomSrc from './vendor/linkedom.iife.js';
import { DOM_WIRE } from './wire.js';

const TD = new TextDecoder();
const TE = new TextEncoder();

// Intl/Temporal（CONFIG_TEMPORAL_INTL）把 wasi-libc 的 preopen / 环境变量 /
// 路径 API 一并拖进导入面（15 个）。本引擎刻意没有文件系统视图：这些桩一律
// 回 EBADF(8)，environ 报"空"。时区数据来自编译进来的 tzdata_generated.c，
// 不读盘 —— 所以 DateTimeFormat 的 timeZone 照常可用。
const EBADF = 8;

function wasiStubs(state) {
  const dv = () => new DataView(state.memory.buffer);
  // 无 preopen / 无 fd：所有 fd 相关调用回 EBADF，wasi-libc 据此置 errno
  const noFd = () => EBADF;
  return {
    // Date 语义：gettimeofday/clock_gettime → clock_time_get；DO 桩喂真时间
    clock_time_get: (id, precision, outPtr) => {
      const ns = BigInt(Date.now()) * 1000000n;
      dv().setBigUint64(outPtr, ns, true);
      return 0;
    },
    fd_write: (_fd, _iovs, _iovsLen, nwrittenPtr) => {
      // stderr（未捕获异常打印等）：v1 丢弃内容，回 0 字节
      dv().setUint32(nwrittenPtr, 0, true);
      return 0;
    },
    fd_close: () => 0,
    fd_seek: () => 29, // ESPIPE：无处可寻
    fd_read: noFd,
    fd_fdstat_get: noFd,
    fd_fdstat_set_flags: noFd,
    fd_prestat_get: noFd,
    fd_prestat_dir_name: noFd,
    path_open: noFd,
    path_readlink: noFd,
    // 空环境：getenv("TZ") 等恒为 NULL，quickjs 转用内嵌 tzdata
    environ_sizes_get: (countPtr, sizePtr) => {
      const d = dv();
      d.setUint32(countPtr, 0, true);
      d.setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get: (environPtr, bufPtr) => {
      const d = dv();
      d.setUint32(environPtr, 0, true);
      d.setUint32(bufPtr, 0, true);
      return 0;
    },
    // 正常路径永不触发（quickjs 不用 exit）；真被调用说明引擎内部 abort，
    // 抛出去好过静默让 wasm 停摆。
    proc_exit: (code) => { throw new Error('quickjs proc_exit(' + code + ')'); },
  };
}

export class QjsEngine {
  constructor(opts = {}) {
    this.opts = opts;
    const state = { memory: null };
    this.instance = new WebAssembly.Instance(wasmModule, { wasi_snapshot_preview1: wasiStubs(state) });
    state.memory = this.instance.exports.memory;
    this.exports = this.instance.exports;
    this.exports._initialize(); // reactor：先跑 wasm 构造器（malloc 初始化等）
    if (!this.exports.qjs_new()) throw new Error('qjs_new failed');
    this.exports.qjs_set_limits(
      opts.memBytes ?? 128 * 1024 * 1024,
      opts.stackBytes ?? 512 * 1024,
      // quickjs 每 ~10000 轮循环/调用才触发一次中断处理器（JS_INTERRUPT_COUNTER_INIT），
      // 预算按处理器调用次数计：3000 次 ≈ 3000 万轮 ≈ 0.3~1s CPU，先于 DO 30s CPU 墙生效
      opts.interruptBudget ?? 3000,
    );
    this.exports.qjs_enable_interrupt();
    for (const [src, name] of [[PRELUDE, 'prelude.js'], [linkedomSrc, 'linkedom.js'], [DOM_WIRE, 'wire.js']]) {
      const rc = this.eval(src, name, false);
      if (rc !== 0) {
        const tasks = this.takeTasks();
        throw new Error(name + ' failed: ' + JSON.stringify(tasks).slice(0, 400));
      }
    }
  }

  #writeBytes(bytes) {
    const ptr = this.exports.qjs_alloc(bytes.length);
    new Uint8Array(this.instance.exports.memory.buffer, ptr, bytes.length).set(bytes);
    return bytes.length;
  }

  #readPacked(packed) {
    const p = Number(packed & 0xffffffffn);
    const len = Number(packed >> 32n);
    return TD.decode(new Uint8Array(this.instance.exports.memory.buffer, p, len));
  }

  /** 返回 0=成功，1=异常（异常已入 outbox，kind=exception） */
  eval(code, name = '<eval>', isModule = false) {
    const nb = TE.encode(name);
    const cb = TE.encode(code);
    const all = new Uint8Array(nb.length + cb.length);
    all.set(nb, 0);
    all.set(cb, nb.length);
    this.#writeBytes(all);
    return this.exports.qjs_eval(all.length, isModule ? 1 : 0, nb.length);
  }

  addModuleSource(url, src, kind = 0) {
    const ub = TE.encode(url);
    const sb = TE.encode(src);
    const all = new Uint8Array(5 + ub.length + sb.length);
    new DataView(all.buffer).setUint32(0, ub.length, true);
    all[4] = kind; // 0=JS，1=JSON（C 侧包成 export default）
    all.set(ub, 5);
    all.set(sb, 5 + ub.length);
    this.#writeBytes(all);
    return this.exports.qjs_add_module_source(all.length) === 1;
  }

  addModuleResolution(base, name, resolved) {
    const b=TE.encode(base),n=TE.encode(name),u=TE.encode(resolved);
    const bytes=new Uint8Array(8+b.length+n.length+u.length);
    const dv=new DataView(bytes.buffer);dv.setUint32(0,b.length,true);dv.setUint32(4,n.length,true);
    bytes.set(b,8);bytes.set(n,8+b.length);bytes.set(u,8+b.length+n.length);
    this.#writeBytes(bytes);return this.exports.qjs_add_module_resolution(bytes.length)===1;
  }

  beginScope(steps, perSource, totalSource) { this.exports.qjs_scope_begin(steps,perSource,totalSource); }
  endScope() { this.exports.qjs_scope_end(); }
  scopeExhausted() { return !!this.exports.qjs_scope_exhausted(); }

  /** 调 VM 全局函数（args 为原始字符串直通；对象载荷 VM 侧自行 JSON.parse） */
  callGlobal(name, args = '') {
    const ob = TE.encode(name);
    const ab = TE.encode(args);
    const all = new Uint8Array(4 + ob.length + ab.length);
    new DataView(all.buffer).setUint32(0, ob.length, true);
    all.set(ob, 4);
    all.set(ab, 4 + ob.length);
    this.#writeBytes(all);
    return JSON.parse(this.#readPacked(this.exports.qjs_call_global(all.length)));
  }

  jobPending() { return this.exports.qjs_job_pending() === 1; }

  /** 微任务抽干；job 内异常（返回 2）以 outbox exception 体现并停止。
   *  每批先重置中断计数：qjs_eval/qjs_call_global 都会重置，但微任务泵原先不重置，
   *  于是单个 eval 之后的一串 Promise 链共用同一份预算 —— 链跑够 3000 次中断
   *  （≈3000 万轮）后，**后续所有** job 立刻抛 InterruptedError 且无人重置，
   *  页面表现为"异步逻辑莫名全挂"。按批重置后语义与 eval 一致，
   *  且批内仍有 job 上限 + 预算双重兜底，无限微任务链依然被打断。 */
  drainJobs(limit = 20000) {
    let n = 0;
    if (!this.jobPending()) return 0;
    this.exports.qjs_interrupt_reset();
    while (this.jobPending() && n++ < limit) {
      if (this.exports.qjs_exec_job() === 2) break;
    }
    return n;
  }

  /** 显式 GC：换页后旧 DOM 整批变垃圾，立刻回收 */
  runGC() { this.exports.qjs_run_gc(); }

  /** 取走全部 VM→宿主任务 */
  takeTasks() {
    const raw = this.#readPacked(this.exports.qjs_take_tasks());
    try { return JSON.parse(raw); } catch (e) {
      return [{ kind: 'outbox_corrupt', payload: { raw: raw.slice(0, 200) } }];
    }
  }

  setInterrupt(on, budget) { this.exports.qjs_set_interrupt(on ? 1 : 0, budget ?? 0); }

  dispose() {
    try { this.exports.qjs_free(); } catch { /* 已死则忽略 */ }
  }
}
