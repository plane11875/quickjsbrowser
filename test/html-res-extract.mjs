// test/html-res-extract.mjs — 从 HTML 文本正则提取资源 URL，与 blitz 首渲染的 missed_resources() 对比覆盖率
// 用法：node --experimental-wasm-modules --import ./test/register.mjs test/html-res-extract.mjs [url]
import initBlitz, { add_font, set_generic_lead, clear_resources,
  missed_resources, render_png_rgba_no_js } from '../src/vendor/pkg/kitesurf_clone.js';
import blitzWasm from '../src/vendor/pkg/kitesurf_clone_bg.wasm';
import fontSansReg from '../src/vendor/fonts/sans-regular.ttf';
import fontSansBold from '../src/vendor/fonts/sans-bold.ttf';
import fontMono from '../src/vendor/fonts/mono-regular.ttf';
import fontSc from '../src/vendor/fonts/sc-regular.ttf';
import fontJp from '../src/vendor/fonts/jp-regular.ttf';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const TARGET = process.argv[2] || 'https://x.com/elonmusk';
const dispatcher = new ProxyAgent(process.env.PROXY || 'http://127.0.0.1:7890');
const doFetch = (u, o) => undiciFetch(u, { ...o, dispatcher });
const UA = 'Mozilla/5.0 (quickjsbrowser/0.1; +https://quickjsbrowser.workers.dev)';

await initBlitz(blitzWasm);
for (const f of [fontSansReg, fontSansBold, fontMono, fontSc, fontJp]) {
  try { add_font(f.name, f.data ?? f); } catch (e) { try { add_font(f); } catch {} }
}
try { set_generic_lead([['monospace', ['mono', 'sc', 'jp']], ['ui-monospace', ['mono', 'sc', 'jp']]]); } catch {}

const r = await doFetch(TARGET, { redirect: 'follow', headers: { 'User-Agent': UA } });
const html = (await r.text()).slice(0, 4_000_000);
const base = r.url;
console.log(`HTML ${html.length} B  base=${base}`);

// ---- A. blitz 首渲染判定的 missing ----
clear_resources();
render_png_rgba_no_js(html, base, 1280, 900);
const missed = missed_resources() || [];
console.log(`\nblitz 首渲染判定 missing: ${missed.length} 个`);
for (const u of missed.slice(0, 20)) console.log('   ', u.slice(0, 110));

// ---- B. 正则从 HTML 提取候选资源 ----
const EXT = /\.(css|js|mjs|png|jpe?g|gif|webp|svg|woff2?|ttf|otf|ico)(\?|#|$)/i;
const urls = new Set();
for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
  let u = m[1].trim();
  if (!u || u.startsWith('#') || u.startsWith('data:') || u.startsWith('javascript:')) continue;
  if (u.startsWith('//')) u = 'https:' + u;
  else if (u.startsWith('/')) { try { u = new URL(u, base).href; } catch { continue; } }
  else if (!/^https?:/i.test(u)) { try { u = new URL(u, base).href; } catch { continue; } }
  if (EXT.test(u)) urls.add(u);
}
// CSS 里的 @import / url() 也要算
for (const m of html.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) {
  try { urls.add(new URL(m[1], base).href); } catch {}
}
const cand = [...urls];
console.log(`\n正则提取候选: ${cand.length} 个`);

// ---- C. 覆盖率 ----
const missedSet = new Set(missed);
const hit = cand.filter((u) => missedSet.has(u));
console.log(`\n命中 blitz 判定的 missing: ${hit.length}/${missed.length} = ${(hit.length / missed.length * 100).toFixed(1)}%`);
const extra = cand.filter((u) => !missedSet.has(u));
console.log(`误抓（正则多提的）: ${extra.length} 个 —— 这些会白花子请求`);
for (const u of extra.slice(0, 8)) console.log('   多余:', u.slice(0, 100));