// test/paint-probe.mjs — 插桩测量 paint() 各阶段真实耗时（诊断用，不改 src）
// 用法：node --experimental-wasm-modules --import ./test/register.mjs test/paint-probe.mjs [url]
import initBlitz, { add_font, set_generic_lead, add_resource, clear_resources,
  missed_resources, render_png_rgba_no_js } from '../src/vendor/pkg/kitesurf_clone.js';
import blitzWasm from '../src/vendor/pkg/kitesurf_clone_bg.wasm';
import fontSansReg from '../src/vendor/fonts/sans-regular.ttf';
import fontSansBold from '../src/vendor/fonts/sans-bold.ttf';
import fontMono from '../src/vendor/fonts/mono-regular.ttf';
import fontSc from '../src/vendor/fonts/sc-regular.ttf';
import fontJp from '../src/vendor/fonts/jp-regular.ttf';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// node 的 fetch 不认 HTTP_PROXY，被墙域名必须显式走代理
const proxyUrl = process.env.PROXY || 'http://127.0.0.1:7890';
const dispatcher = new ProxyAgent(proxyUrl);
const doFetch = (u, o) => undiciFetch(u, { ...o, dispatcher });

const TARGET = process.argv[2] || 'https://x.com/elonmusk';
const W = 1280, H = 900;
const UA = 'Mozilla/5.0 (quickjsbrowser/0.1; +https://quickjsbrowser.workers.dev)';

const ms = (t0) => (performance.now() - t0).toFixed(0).padStart(6);

await initBlitz(blitzWasm);
for (const f of [fontSansReg, fontSansBold, fontMono, fontSc, fontJp]) {
  try { add_font(f.name, f.data ?? f); } catch (e) { try { add_font(f); } catch {} }
}
try { set_generic_lead([['monospace', ['mono', 'sc', 'jp']], ['ui-monospace', ['mono', 'sc', 'jp']]]); } catch {}

// ---- 阶段 1：抓 HTML ----
let t = performance.now();
const r = await doFetch(TARGET, { redirect: 'follow', headers: { 'User-Agent': UA } });
const html = (await r.text()).slice(0, 4_000_000);
console.log(`[1] fetch HTML      ${ms(t)} ms   ${html.length} B  (final: ${r.url})`);

// ---- 阶段 2：首渲染 + 资源发现 ----
t = performance.now();
clear_resources();
const t0 = performance.now();
let rgba = render_png_rgba_no_js(html, r.url, W, H);
console.log(`[2] 首渲染          ${ms(t)} ms`);

const missed0 = missed_resources() || [];
console.log(`[3] 首渲染后缺失资源: ${missed0.length} 个`);

// ---- 阶段 4：串行补抓（复刻线上原实现）----
const all = [];
const tried = new Set();
let pass = 0;
while (pass < 3) {
  const missed = missed_resources() || [];
  const todo = missed.filter((u) => !tried.has(u));
  for (const u of missed) tried.add(u);
  if (!todo.length) break;
  const n = todo.length;
  t = performance.now();
  for (const u of todo) {
    try {
      const rr = await doFetch(u, { redirect: 'follow', headers: { 'User-Agent': UA } });
      if (rr.ok) { add_resource(u, new Uint8Array(await rr.arrayBuffer())); all.push(u); }
    } catch {}
  }
  console.log(`[4] pass${pass + 1} 串行补抓 ${n} 个  ${ms(t)} ms  (${(Number(ms(t))/n).toFixed(0)} ms/个)`);
  t = performance.now();
  rgba = render_png_rgba_no_js(html, r.url, W, H);
  console.log(`[5] pass${pass + 1} 重渲染    ${ms(t)} ms`);
  pass++;
}
console.log(`\n合计成功补抓资源: ${all.length} / ${tried.size}`);

// ---- 汇总 ----
const tS = performance.now();
t = performance.now();
rgba = render_png_rgba_no_js(html, r.url, W, H);
console.log(`[6] 最终重渲染(已有全部资源) ${ms(t)} ms`);