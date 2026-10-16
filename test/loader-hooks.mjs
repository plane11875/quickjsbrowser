// test/loader-hooks.mjs — 让 node 能 import session.js。
// wrangler 靠 rules 把 .wasm/.ttf/.iife.js 当模块规则打包，node 不认这些扩展名。
// 这里只补 .ttf（二进制资源）和 .iife.js（纯文本）；.wasm 交给 node 的
// --experimental-wasm-modules 原生支持。
import { readFile } from 'node:fs/promises';

// cloudflare:sockets 是 workers 运行时内置的，node 解析不了这个裸说明符。
// 映射到本目录的替身，让 session.js → net/relay.js 这条 import 链在 node 里能过。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:sockets') {
    return {
      url: new URL('./shims/sockets.mjs', import.meta.url).href,
      shortCircuit: true,
      format: 'module',
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ttf')) {
    const buf = await readFile(new URL(url));
    const src = 'export default new Uint8Array(' + JSON.stringify(Array.from(buf)) + ');';
    return { format: 'module', shortCircuit: true, source: src };
  }
  if (url.endsWith('.wasm')) {
    // node 的 wasm ESM 要求配套 .js glue（这里没有），改成运行时读字节。
    // engine.wasm 对应 wrangler 的 CompiledWasm 规则：default 是已编译 Module；
    // 其余 .wasm（blitz）对应该规则下的裸字节。
    const read = 'import { readFile } from "node:fs/promises";'
      + 'const b = new Uint8Array(await readFile(new URL(' + JSON.stringify(url) + ')));';
    const src = url.endsWith('/engine.wasm')
      ? read + 'export default new WebAssembly.Module(b);'
      : read + 'export default b;';
    return { format: 'module', shortCircuit: true, source: src };
  }
  if (url.endsWith('.iife.js')) {
    const buf = await readFile(new URL(url));
    return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(buf.toString('utf8')) + ';' };
  }
  return nextLoad(url, context);
}