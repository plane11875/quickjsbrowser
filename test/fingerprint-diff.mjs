// test/fingerprint-diff.mjs — 指纹 before/after 插桩对照（同一引擎、同一表达式集，只换 prelude）。
//
// 为什么要有它：指纹改动没法靠"看着像"验收。这里把「旧 prelude 源码」和「当前 prelude」
// 装进两个独立引擎实例，跑同一份"检测脚本会问的问题"清单，逐行对比。
// 用法：
//   git show HEAD:src/prelude.js > /tmp/old-prelude.mjs   # 取改动前的版本
//   node .fp-ba.tmp.mjs                                   # 或 node test/fingerprint-diff.mjs
// 注意：两个实例的 wasi 桩必须各自持有自己的 memory（共用会让第二个实例的指针读到
// 第一个实例的内存，报 "Unexpected token '\uFFFD'"）——踩过一次。

// before = git HEAD 版 prelude（旧指纹面），after = 工作区版（本次改动）。
import fs from 'node:fs';
const ROOT = '/home/zywoo/Project/cloudflare/project/workers/quickjsbrowser/';
const mod = new WebAssembly.Module(fs.readFileSync(ROOT + 'src/engine.wasm'));
const TE = new TextEncoder(), TD = new TextDecoder();
function makeWasi() {
  const st = { mem: null };
  const wasi = {
    clock_time_get: (_i,_p,o)=>{ new DataView(st.mem.buffer).setBigUint64(o, BigInt(Date.now())*1000000n, true); return 0; },
    fd_write: (_f,_i,_n,o)=>{ new DataView(st.mem.buffer).setUint32(o,0,true); return 0; },
    fd_close:()=>0, fd_seek:()=>29, fd_read:()=>8, fd_fdstat_get:()=>8, fd_fdstat_set_flags:()=>8,
    fd_prestat_get:()=>8, fd_prestat_dir_name:()=>8, path_open:()=>8, path_readlink:()=>8,
    environ_sizes_get:(c,s)=>{ const d=new DataView(st.mem.buffer); d.setUint32(c,0,true); d.setUint32(s,0,true); return 0; },
    environ_get:(e,b)=>{ const d=new DataView(st.mem.buffer); d.setUint32(e,0,true); d.setUint32(b,0,true); return 0; },
    proc_exit:(c)=>{ throw new Error('proc_exit '+c); },
  };
  return { wasi, st };
}
function boot(prelude) {
  const { wasi, st } = makeWasi();
  const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi });
  st.mem = inst.exports.memory;
  const mem = st.mem;
  inst.exports._initialize();
  const E = inst.exports;
  E.qjs_new(); E.qjs_set_limits(128*1024*1024, 512*1024, 3000); E.qjs_enable_interrupt();
  const ev = (n, c) => { const nb=TE.encode(n), cb=TE.encode(c); const a=new Uint8Array(nb.length+cb.length); a.set(nb); a.set(cb,nb.length); const p=E.qjs_alloc(a.length); new Uint8Array(mem.buffer,p,a.length).set(a); return E.qjs_eval(a.length,0,nb.length); };
  const call = (n, a) => { const ob=TE.encode(n), ab=TE.encode(a); const al=new Uint8Array(4+ob.length+ab.length); new DataView(al.buffer).setUint32(0,ob.length,true); al.set(ob,4); al.set(ab,4+ob.length); const p=E.qjs_alloc(al.length); new Uint8Array(mem.buffer,p,al.length).set(al); const r=E.qjs_call_global(al.length); return JSON.parse(TD.decode(new Uint8Array(mem.buffer, Number(r&0xffffffffn), Number(r>>32n)))); };
  if (ev('prelude.js', prelude) !== 0) throw new Error('prelude eval failed');
  return (e) => { const r = call('eval', `(()=>{try{return String(${e})}catch(err){return 'THROW:'+err.message}})()`); return r.ok ? r.value : 'UNDEF'; };
}
const EXPRS = [
  ['navigator.plugins.length', 'navigator.plugins.length'],
  ['navigator.mimeTypes.length', 'navigator.mimeTypes.length'],
  ['navigator.plugins[0].name', 'navigator.plugins[0] && navigator.plugins[0].name'],
  ['navigator.deviceMemory', 'navigator.deviceMemory'],
  ['navigator.pdfViewerEnabled', 'navigator.pdfViewerEnabled'],
  ['navigator.connection.effectiveType', '(navigator.connection||{}).effectiveType'],
  ['typeof navigator.permissions.query', 'typeof (navigator.permissions||{}).query'],
  ['typeof navigator.storage.estimate', 'typeof (navigator.storage||{}).estimate'],
  ['typeof navigator.userAgentData', 'typeof navigator.userAgentData'],
  ['userAgentData.brands 序列', '(navigator.userAgentData||{brands:[]}).brands.map(b=>b.brand+"/"+b.version).join(", ")'],
  ['typeof navigator.sendBeacon', 'typeof navigator.sendBeacon'],
  ['typeof navigator.getGamepads', 'typeof navigator.getGamepads'],
  ['typeof navigator.getBattery', 'typeof navigator.getBattery'],
  ['typeof navigator.locks', 'typeof navigator.locks'],
  ['typeof navigator.vendorSub', 'typeof navigator.vendorSub'],
  ['navigator.product', 'navigator.product'],
  ['typeof navigator.productSub', 'typeof navigator.productSub'],
  ['typeof window.chrome', 'typeof window.chrome'],
  ['Object.keys(window.chrome)', 'typeof window.chrome === "object" ? Object.keys(window.chrome).join(",") : "-"'],
  ['typeof screen', 'typeof screen'],
  ['screen.width', 'typeof screen !== "undefined" ? screen.width : "-"'],
  ['typeof innerWidth', 'typeof innerWidth'],
  ['typeof devicePixelRatio', 'typeof devicePixelRatio'],
  ['navigator.constructor.name', 'navigator.constructor.name'],
  ['Function.prototype.toString.call(fetch)', 'Function.prototype.toString.call(fetch).indexOf("[native code]")>=0 ? "native" : "JS 源码"'],
  ['navigator.languages.join(",")', 'navigator.languages.join(",")'],
];
// 旧 prelude 由调用方准备好（见文件头用法）；默认读 /tmp/old-prelude.mjs
const oldPath = (process.argv.find((a) => a.startsWith('--old=')) || '').slice(6) || '/tmp/old-prelude.mjs';
const oldMod = await import('file://' + oldPath);
const newMod = await import('../src/prelude.js');
const A = boot(oldMod.PRELUDE), B = boot(newMod.PRELUDE);
const w = Math.max(...EXPRS.map(([n]) => n.length));
console.log('| 检测表达式'.padEnd(w + 20) + '| before (git HEAD) | after (本次) |');
console.log('|' + '-'.repeat(w + 18) + '|-------------------|-------------|');
let same = 0;
for (const [label, expr] of EXPRS) {
  const b = A(expr), a = B(expr);
  if (b === a) same++;
  console.log(`| ${label.padEnd(w + 16)} | ${String(b).slice(0, 40).padEnd(17)} | ${String(a).slice(0, 40)}`);
}
console.log(`\n${EXPRS.length - same}/${EXPRS.length} 项发生变化`);
