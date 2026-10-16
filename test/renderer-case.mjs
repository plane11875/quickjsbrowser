import fs from 'node:fs';
import { createHash } from 'node:crypto';
import initBlitz, { add_font, add_resource, clear_resources, missed_resources, render_png_rgba_no_js } from '../src/vendor/pkg/kitesurf_clone.js';
const wasm = fs.readFileSync(new URL('../src/vendor/pkg/kitesurf_clone_bg.wasm', import.meta.url));
await initBlitz({ module_or_path: wasm });
for (const [name, family] of [['sans-regular', 'sans'], ['sans-bold', 'sans'], ['mono-regular', 'mono'], ['sc-regular', 'sc'], ['jp-regular', 'jp']]) {
  add_font(fs.readFileSync(new URL(`../src/vendor/fonts/${name}.ttf`, import.meta.url)), family);
}
clear_resources();
const name = process.argv[2];
const width = 320, height = 160;
let html;
if (name === 'left' || name === 'right') {
  html = `<html><body style="margin:0"><p><span style="float:${name};background:red;width:30px;height:30px">X</span>Text</p></body></html>`;
} else if (name === 'css') {
  const url = 'https://fixture.invalid/float.css';
  add_resource(url, new TextEncoder().encode('.float{float:left;width:30px;height:30px;background:red}'));
  html = `<html><head><link rel="stylesheet" href="${url}"></head><body><p><span class="float">X</span>Text</p></body></html>`;
} else {
  html = fs.readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
}
const started = performance.now();
const rgba = render_png_rgba_no_js(html, 'https://fixture.invalid/', width, height);
let redPixels = 0;
for (let i = 0; i < rgba.length; i += 4) if (rgba[i] > 180 && rgba[i + 1] < 80 && rgba[i + 2] < 80 && rgba[i + 3] > 0) redPixels++;
console.log(JSON.stringify({ name, width, height, bytes: rgba.length, ms: performance.now() - started, hash: createHash('sha256').update(rgba).digest('hex'), redPixels, missed: missed_resources() }));
