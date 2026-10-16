// test/register.mjs — node 侧 loader hook 入口（让 .ttf / .iife.js 能被 import）
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(pathToFileURL(new URL('./loader-hooks.mjs', import.meta.url).pathname));