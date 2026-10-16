// test/bench.mjs — 性能基线测量（node 直连 engine.wasm）。用法：node test/bench.mjs
// 每一项都直接量「改动前/后」的真实数字，不做估计。

import fs from 'node:fs';
import http from 'node:http';
import { PRELUDE } from '../src/prelude.js';
import { DOM_WIRE } from '../src/wire.js';

const ROOT = new URL('..', import.meta.url).pathname;
// linkedom.iife.js 在 Worker 里是 Text 模块规则包装的，node 下直接读文件
const linkedomSrc = fs.readFileSync(ROOT + 'src/vendor/linkedom.iife.js', 'utf8');
const mod = new WebAssembly.Module(fs.readFileSync(ROOT + 'src/engine.wasm'));

const TE = new TextEncoder();
const TD = new TextDecoder();

function makeEngine() {
  let mem;
  const wasi = {
    clock_time_get: (_id, _p, out) => {
      new DataView(mem.buffer).setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
      return 0;
    },
    fd_write: (_f, _i, _n, o) => { new DataView(mem.buffer).setUint32(o, 0, true); return 0; },
    fd_close: () => 0,
    fd_seek: () => 29,
  };
  const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi, browser:{layout:()=>-1} });
  mem = inst.exports.memory;
  inst.exports._initialize();
  const E = inst.exports;
  E.qjs_new();
  E.qjs_set_limits(128 * 1024 * 1024, 512 * 1024, 30000000);
  E.qjs_enable_interrupt();
  const ev = (name, code, isMod) => {
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
    return JSON.parse(readPacked(E.qjs_call_global(all.length)));
  };
  const readPacked = (p) => TD.decode(new Uint8Array(mem.buffer, Number(p & 0xffffffffn), Number(p >> 32n)));
  return { E, mem, ev, callG, readPacked };
}

const results = [];
async function bench(label, fn, n = 3) {
  await fn(); // warm（同时把 fn 自身的状态归零）
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn();
  const dt = (performance.now() - t0) / n;
  results.push([label, Number(dt.toFixed(2)), n]);
  console.log(`  ${label.padEnd(50)} ${dt.toFixed(2)} ms`);
  return dt;
}

console.log('\n=== B1 引擎构建分项 ===');
await bench('qjs_new() 单独', () => { const e = makeEngine(); e.E.qjs_free(); }, 5);
await bench('qjs_new() + prelude', () => { const e = makeEngine(); e.ev('p.js', PRELUDE); e.E.qjs_free(); }, 5);
await bench('完整引擎（含 linkedom 272KB + wire）', () => {
  const e = makeEngine();
  e.ev('p.js', PRELUDE); e.ev('l.js', linkedomSrc); e.ev('w.js', DOM_WIRE);
  e.E.qjs_free();
}, 5);

console.log('\n=== B2 微任务泵 drainJobs ===');
{
  const { E, ev } = makeEngine();
  ev('p.js', PRELUDE);
  const N = 5000;
  const mk = (n) => ev('m.js', `let c=0; for(let i=0;i<${n};i++) Promise.resolve(i).then(v=>{c+=v});`, false);
  const drainOld = () => {
    mk(N);
    let n = 0;
    while (E.qjs_job_pending() && n++ < 20000) E.qjs_exec_job();
    E.qjs_take_tasks();
  };
  await bench(`${N} 个微任务：JS 侧 drainJobs+takeTasks（现状）`, drainOld, 5);
  if (E.qjs_exec_jobs) {
    const drainNew = () => {
      mk(N);
      E.qjs_exec_jobs(20000);
      E.qjs_take_tasks();
    };
    const a = await bench(`${N} 个微任务：C 侧批量 qjs_exec_jobs（改后）`, drainNew, 5);
    console.log(`  → 见汇总对比`);
  }
  E.qjs_free();
}

console.log('\n=== B3 outbox / console 通道 ===');
{
  const { E, ev, readPacked } = makeEngine();
  ev('p.js', PRELUDE);
  const N = 20000;
  await bench(`${N} 条 console.log → take_tasks → JSON.parse`, () => {
    ev('c.js', `for(let i=0;i<${N};i++) console.log("line "+i);`);
    JSON.parse(readPacked(E.qjs_take_tasks()));
  }, 3);
  E.qjs_free();
}

console.log('\n=== B4 大 HTML 进 VM（load_dom 通道）===');
{
  const { ev, callG } = makeEngine();
  ev('p.js', PRELUDE); ev('l.js', linkedomSrc); ev('w.js', DOM_WIRE);
  const html = '<!DOCTYPE html><html><body>' + Array.from({ length: 8000 },
    (_, i) => `<div class="row r${i}" data-i="${i}"><span>item &amp; ${i}</span><a href="/x?a=1&b=2">go</a></div>`).join('') + '</body></html>';
  console.log(`  （HTML ${(html.length / 1024).toFixed(0)} KB）`);
  // 分项：宿主侧 JSON.stringify 成本
  await bench('宿主 JSON.stringify({kind,html,baseUrl})', () => { JSON.stringify({ kind: 'load_dom', html, baseUrl: 'https://x.test/' }); }, 3);
  // 分项：VM 侧 JSON.parse 成本（不含 linkedom parseHTML）
  const blob = JSON.stringify({ kind: 'noop', html });
  await bench('宿主 JSON.parse(大字符串)（VM 侧同量级）', () => { JSON.parse(blob); }, 3);
  await bench('__dispatch(JSON{load_dom}) 全量（含 parseHTML）', () => {
    callG('__dispatch', JSON.stringify({ kind: 'load_dom', html, baseUrl: 'https://x.test/' }));
  }, 3);
  const hasRaw = callG('__load_dom_raw', 'x');
  if (hasRaw && hasRaw.ok === false && /not a function/.test(String(hasRaw.error?.message))) {
    console.log('  （无 __load_dom_raw 入口 —— 这就是改前的现状）');
  } else {
    await bench('__load_dom_raw 直通（含 parseHTML，改后）', () => { callG('__load_dom_raw', html); }, 3);
  }
  E_free: { }
}

console.log('\n=== B5 随机池 getRandomValues ===');
{
  const { ev, callG, E } = makeEngine();
  ev('p.js', PRELUDE);
  const b64 = Buffer.alloc(65536, 7).toString('base64');
  callG('__dispatch', JSON.stringify({ kind: 'random', b64 }));
  await bench('getRandomValues × 2000', () => {
    ev('g.js', 'for(let i=0;i<2000;i++){const a=new Uint8Array(16);crypto.getRandomValues(a);}');
  }, 3);
  E.qjs_free();
}

console.log('\n=== B6 模块图预取（本地 CDN，30ms/请求）===');
{
  const server = http.createServer((req, res) => {
    const m = /^\/m\/(\d+)\.js$/.exec(req.url);
    if (!m) { res.writeHead(404).end(); return; }
    const id = +m[1];
    const imports = id < 60 ? [id * 3 + 1, id * 3 + 2, id * 3 + 3].filter((x) => x <= 60) : [];
    const body = imports.length
      ? imports.map((k) => `import {v${k}} from "./${k}.js";`).join('\n') + `\nexport const v${id} = ${imports.join('+')};\n`
      : `export const v${id} = ${id};\n`;
    setTimeout(() => res.writeHead(200, { 'content-type': 'text/javascript' }).end(body), 30);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/m/1.js`;

  const fetchSrc = async (u) => {
    const r = await fetch(u);
    if (!r.ok) return null;
    return await r.text();
  };
  const entry = await fetchSrc(base);
  const SPEC = [/\bfrom\s*("([^"\n]*)"|'([^'\n]*)')/g, /\bimport\s*\(\s*("([^"\n]*)"|'([^'\n]*)')/g];
  const scan = (src) => {
    const out = [];
    for (const re of SPEC) { re.lastIndex = 0; for (const m of src.matchAll(re)) { const s = m[2] ?? m[3]; if (s) out.push(s); } }
    return out;
  };
  const resolve = (b, n) => new URL(n, b).href;

  async function bfsSerial() {
    const seen = new Set([base]);
    let q = [[base, entry]];
    let n = 0;
    for (let d = 0; q.length && d < 32; d++) {
      const next = [];
      for (const [u, src] of q) {
        for (const spec of scan(src)) {
          const abs = resolve(u, spec);
          if (seen.has(abs)) continue;
          seen.add(abs);
          const t = await fetchSrc(abs);
          if (t == null) continue;
          n++; next.push([abs, t]);
        }
      }
      q = next;
    }
    return n;
  }
  async function bfsParallel() {
    const seen = new Set([base]);
    let q = [[base, entry]];
    let n = 0;
    for (let d = 0; q.length && d < 32; d++) {
      const want = [];
      for (const [u, src] of q) {
        for (const spec of scan(src)) {
          const abs = resolve(u, spec);
          if (seen.has(abs)) continue;
          seen.add(abs);
          want.push(abs);
        }
      }
      const texts = await Promise.all(want.map((u) => fetchSrc(u).catch(() => null)));
      const next = [];
      for (let i = 0; i < want.length; i++) { if (texts[i] == null) continue; n++; next.push([want[i], texts[i]]); }
      q = next;
    }
    return n;
  }
  console.log(`  （树深约 ${Math.ceil(Math.log2(60))}，60 模块；fetch 强制 30ms 延迟）`);
  const s1 = await bench('60 模块图：串行 BFS（现状）', bfsSerial, 3);
  const p1 = await bench('60 模块图：并行 BFS（改后）', bfsParallel, 3);
  console.log(`  → 加速 ${(s1 / p1).toFixed(2)}×  （${s1.toFixed(0)}ms → ${p1.toFixed(0)}ms）`);

  const cache = new Map();
  async function bfsCached() {
    const seen = new Set([base]);
    let q = [[base, entry]];
    let n = 0;
    for (let d = 0; q.length && d < 32; d++) {
      const next = [];
      for (const [u, src] of q) {
        for (const spec of scan(src)) {
          const abs = resolve(u, spec);
          if (seen.has(abs)) continue;
          seen.add(abs);
          let t = cache.get(abs);
          if (t === undefined) { t = await fetchSrc(abs); cache.set(abs, t); }
          if (t == null) continue;
          n++; next.push([abs, t]);
        }
      }
      q = next;
    }
    return n;
  }
  await bfsCached();
  await bench('60 模块图：第二次 BFS（会话内缓存全命中，改后）', bfsCached, 3);
  server.close();
}

console.log('\n=== 汇总 ===');
for (const [l, d, n] of results) console.log(`${String(d).padStart(9)} ms  x${String(n).padStart(2)}  ${l}`);