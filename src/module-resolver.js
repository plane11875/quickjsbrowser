import { parse } from 'es-module-lexer/minimal/js';

// The CSP-compatible JS build needs neither eval nor runtime Wasm compilation.
export function moduleSpecifiers(source, staticOnly = false) {
  return [...new Set(parse(source)[0].filter((i) => typeof i.n === 'string' && !i.typeOnly && (!staticOnly || i.d === -1)).map((i) => i.n))];
}

export class ModuleResolver {
  constructor(base, maps = []) {
    this.base = base;
    this.imports = new Map();
    this.scopes = new Map();
    for (const text of maps) {
      if (text.length > 65536) throw new Error('import map exceeds 64 KiB');
      const map = JSON.parse(text);
      this.merge(this.imports, map.imports);
      for (const [scope, entries] of Object.entries(map.scopes || {})) {
        const key = new URL(scope, base).href;
        if (!this.scopes.has(key)) this.scopes.set(key, new Map());
        this.merge(this.scopes.get(key), entries);
      }
    }
  }
  merge(target, entries) {
    if (!entries || typeof entries !== 'object') return;
    for (let [key, value] of Object.entries(entries)) {
      if (target.size >= 1024) throw new Error('import map exceeds 1024 entries');
      if (this.urlLike(key)) key = new URL(key, this.base).href;
      if (target.has(key)) continue; // first mapping wins
      let resolved = null;
      if (typeof value === 'string' && this.urlLike(value)) {
        resolved = new URL(value, this.base).href;
        if (key.endsWith('/') && !resolved.endsWith('/')) resolved = null;
      }
      target.set(key, resolved);
    }
  }
  urlLike(s) { return /^(?:[a-z][a-z\d+.-]*:|\/|\.\.?\/)/i.test(s); }
  match(map, spec) {
    if (map.has(spec)) return { found: true, url: map.get(spec) };
    const key = [...map.keys()].filter((k) => k.endsWith('/') && spec.startsWith(k)).sort((a,b) => b.length-a.length)[0];
    if (!key) return { found: false };
    const prefix = map.get(key);
    if (!prefix) return { found: true, url: null };
    const tail = spec.slice(key.length);
    if (/%2f|%5c/i.test(tail)) return { found: true, url: null };
    const url = new URL(tail, prefix).href;
    return { found: true, url: url.startsWith(prefix) ? url : null };
  }
  resolve(base, name) {
    const spec = this.urlLike(name) ? new URL(name, base).href : name;
    for (const scope of [...this.scopes.keys()].filter((s) => base.startsWith(s)).sort((a,b) => b.length-a.length)) {
      const m = this.match(this.scopes.get(scope), spec);
      if (m.found) return m.url;
    }
    const m = this.match(this.imports, spec);
    if (m.found) return m.url;
    // Browser modules do not implicitly turn bare names into npm/CDN requests.
    return this.urlLike(name) ? spec : null;
  }
}

// Lexical spans avoid touching comments, strings or import.meta. The native
// import executes only after the asynchronous host has prepared the module.
export function prepareDynamicImports(source, base) {
  const imports=parse(source)[0].filter(i=>i.d>=0).sort((a,b)=>b.ss-a.ss);
  for(const i of imports)source=source.slice(0,i.ss)+'globalThis.__dynamicImport.bind(null,'+JSON.stringify(base)+')'+source.slice(i.ss+6);
  return source;
}
