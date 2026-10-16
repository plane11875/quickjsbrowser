import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const results = new Map();
for (const name of ['float-inline', 'float-inline-fixed', 'float-block', 'left', 'right', 'css']) {
  const child = spawnSync(process.execPath, ['test/renderer-case.mjs', name], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${name}: ${child.stderr || child.stdout}`);
  const lines = child.stdout.trim().split('\n');
  const result = JSON.parse(lines.at(-1));
  assert.equal(result.bytes, result.width * result.height * 4, name);
  results.set(name, result);
  console.log(`PASS ${name} (${result.ms.toFixed(0)}ms)`);
}
assert.notEqual(results.get('left').hash, results.get('right').hash, 'float direction must change layout');
for (const name of ['left', 'right', 'css']) assert.ok(results.get(name).redPixels > 0, `${name}: floated content must be painted`);
assert.deepEqual(results.get('css').missed, [], 'preloaded stylesheet should be consumed');
console.log('PASS float placement and external CSS regression checks');
