import assert from 'node:assert/strict';
import { QjsSession } from '../src/session.js';
import { CdpConnection } from '../src/cdp.js';

const session = () => new QjsSession({ waitUntil() {} }, {});
const value = (s, expression) => {
  const r = s.engine.callGlobal('eval', expression);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const html = '<!doctype html><html><head><title>navigation</title>'
  + '<link rel="stylesheet" href="https://assets.example/style.css">'
  + '<script>globalThis.pageRan = true</script>'
  + '<script src="https://assets.example/a.js"></script>'
  + '<script type="module" src="https://assets.example/m.js"></script>'
  + '</head><body><p id="content">original</p></body></html>';
const s = session();
const requests = [];
s.smartFetch = async (url) => {
  requests.push(url);
  assert.equal(url, 'https://linux.do/t/topic/1', 'restricted navigation must fetch only the document');
  return new Response(html);
};
s.cdpEarlyScripts = [{ src: 'globalThis.automationRan = true; document.querySelector("#content").textContent = "automated";' }];
const frames = [];
const cdp = new CdpConnection(s, { send: (frame) => frames.push(JSON.parse(frame)) });
cdp.onMessage(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'https://linux.do/t/topic/1' } }));
await cdp.chain;
await cdp.sendChain;
assert.ok(frames.some((f) => f.id === 1 && !f.result.errorText));
assert.equal(requests.length, 1);
assert.equal(value(s, 'typeof pageRan'), 'undefined');
assert.equal(value(s, 'automationRan'), true);
assert.equal(value(s, 'document.querySelector("#content").textContent'), 'automated');
assert.equal(value(s, 'document.querySelectorAll("script").length'), 3);
assert.ok(value(s, 'document.querySelector("link").href').includes('style.css'));
assert.ok(frames.some((f) => f.method === 'Page.loadEventFired'));
// CDP screenshot and evaluate must still read the live, mutable DOM.
assert.ok(s.engine.callGlobal('__dom_html').value.includes('automated'));
cdp.close();
s.engine.dispose();
console.log('PASS CDP site policy preserves DOM, CSS, early scripts and lifecycle');

const unrestricted = session();
let active = 0, peak = 0;
const downloads = [];
unrestricted.smartFetch = async (url) => {
  downloads.push(url);
  active++; peak = Math.max(peak, active);
  const name = new URL(url).pathname.slice(1);
  await new Promise((resolve) => setTimeout(resolve, name === 'a.js' ? 30 : 5));
  active--;
  return new Response(`globalThis.scriptOrder = (globalThis.scriptOrder || '') + '${name[0]}';`);
};
const result = await unrestricted.runPageScripts('<html><head><script src="/a.js"></script><script src="/b.js"></script><script src="/a.js"></script></head><body>ok</body></html>', 'https://example.com/');
assert.equal(downloads.length, 2, 'duplicate script URLs download once');
assert.equal(peak, 2, 'independent downloads overlap');
assert.equal(value(unrestricted, 'scriptOrder'), 'aba', 'execution follows document order');
assert.ok(result.includes('ok'), 'HTTP JS pipeline still returns serialized DOM');
unrestricted.engine.dispose();
console.log('PASS concurrent classic script downloads preserve ordered execution');

const render = session();
const resources = [];
render.smartFetch = async (url) => {
  resources.push(url);
  if (url.endsWith('.css')) return new Response('p { color: red; }');
  throw new Error('unexpected render resource: ' + url);
};
const png = await render.paint('<html><head><link rel="stylesheet" href="https://assets.example/a.css"><link rel="modulepreload" href="https://assets.example/app.js"></head><body><p>styles remain</p></body></html>', 'https://example.com/', 320, 160);
assert.equal(Buffer.from(png).subarray(0,8).toString('hex'), '89504e470d0a1a0a');
assert.ok(resources.includes('https://assets.example/a.css'));
assert.ok(resources.every((url) => !url.endsWith('.js')));
console.log('PASS renderer loads CSS without downloading unused script preloads');
