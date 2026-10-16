// test/paint-probe3.mjs — 验证「砍掉 pass2」的代价：省多少时间、丢多少画面
// 用法：node --experimental-wasm-modules --import ./test/register.mjs test/paint-probe3.mjs [url] [maxPass]
import initBlitz, { add_font, set_generic_lead, add_resource, clear_resources,
  missed_resources, render_png_rgba_no_js } from '../src/vendor/pkg/kitesurf_clone.js';
import blitzWasm from '../src/vendor/pkg/kitesurf_clone_bg.wasm';
import fontSansReg from '../src/vendor/fonts/sans-regular.ttf';
import fontSansBold from '../src/vendor/fonts/sans-bold.ttf';
import fontMono from '../src/vendor/fonts/mono-regular.ttf';
import fontSc from '../src/vendor/fonts/sc-regular.ttf';
import fontJp from '../src/vendor/fonts/jp-regular.ttf';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { writeFileSync } from 'node:fs';

const TARGET = process.argv[2] || 'https://x.com/elonmusk';
const MAXPASS = Number(process.argv[3] || 1);
const CONC = Number(process.env.CONC || 6);
const W = 1280, H = 900;
const UA = 'Mozilla/5.0 (quickjsbrowser/0.1; +https://quickjsbrowser.workers.dev)';
const dispatcher = new ProxyAgent(process.env.PROXY || 'http://127.0.0.1:7890');
const doFetch = (u, o) => undiciFetch(u, { ...o, dispatcher });
const ms = (t0) => (performance.now() - t0).toFixed(0).padStart(6);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); }
  }));
  return out;
}

await initBlitz(blitzWasm);
for (const f of [fontSansReg, fontSansBold, fontMono, fontSc, fontJp]) {
  try { add_font(f.name, f.data ?? f); } catch (e) { try { add_font(f); } catch {} }
}
try { set_generic_lead([['monospace', ['mono', 'sc', 'jp']], ['ui-monospace', ['mono', 'sc', 'jp']]]); } catch {}

const T0 = performance.now();
let t = performance.now();
const r = await doFetch(TARGET, { redirect: 'follow', headers: { 'User-Agent': UA } });
const html = (await r.text()).slice(0, 4_000_000);
console.log(`[1] fetch HTML      ${ms(t)} ms   ${html.length} B`);
t = performance.now();
clear_resources();
let rgba = render_png_rgba_no_js(html, r.url, W, H);
console.log(`[2] 首渲染          ${ms(t)} ms`);

const tried = new Set();
let pass = 0, nfetched = 0;
while (pass < MAXPASS) {
  const missed = missed_resources() || [];
  const todo = missed.filter((u) => !tried.has(u));
  for (const u of missed) tried.add(u);
  if (!todo.length) { console.log(`    pass${pass + 1}: 收敛`); break; }
  t = performance.now();
  await mapLimit(todo, CONC, async (u) => {
    try {
      const rr = await doFetch(u, { redirect: 'follow', headers: { 'User-Agent': UA } });
      if (rr.ok) { add_resource(u, new Uint8Array(await rr.arrayBuffer())); nfetched++; }
    } catch {}
  });
  console.log(`[3] pass${pass + 1} 补抓 ${String(todo.length).padStart(2)} 个     ${ms(t)} ms`);
  t = performance.now();
  rgba = render_png_rgba_no_js(html, r.url, W, H);
  console.log(`[4] pass${pass + 1} 重渲染                 ${ms(t)} ms`);
  pass++;
}
const total = Number(ms(T0));
console.log(`\nmaxPass=${MAXPASS}  总耗时 ${ms(T0)} ms   抓到 ${nfetched} 资源`);
// 差异度：与两轮版对比用
writeFileSync(`/tmp/probe_p${MAXPASS}.rgba`, Buffer.from(rgba));
console.log(`rgba 已存 /tmp/probe_p${MAXPASS}.rgba  (${rgba.length} B)`);