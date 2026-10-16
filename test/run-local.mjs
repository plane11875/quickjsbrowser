import { spawnSync } from 'node:child_process';
const suites = ['dynamic-loading-test', 'resource-cache-test', 'local-test', 'prelude-test', 'intl-test', 'session-test', 'navigation-test', 'capabilities-test', 'browser-flow-test', 'resumable-loading-test', 'h2-check', 'ja3-check'];
for (const suite of suites) {
  console.log(`\n--- ${suite} ---`);
  const result = spawnSync(process.execPath, ['--experimental-wasm-modules', '--import', './test/register.mjs', `test/${suite}.mjs`], { stdio: 'inherit', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}
