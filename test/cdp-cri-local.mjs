// 验收 C（本地）：chrome-remote-interface 经 target 直连（?key= 无法进 CRI 的 /json/list，
// 用 target 选项给完整 ws URL），驱动 navigate + evaluate + screenshot
import CDP from 'chrome-remote-interface';

const target = process.env.CDP_TARGET || 'ws://localhost:8799/cdp?key=local-test-key&s=cri1';
const client = await CDP({ target, local: true });
const { Page, Runtime } = client;
console.log('[1] CRI connected');
try {
  await Page.enable();
  await Runtime.enable();
  console.log('[2] Page.enable / Runtime.enable ok');
  await Page.navigate({ url: 'https://example.com' });
  await Page.loadEventFired();
  console.log('[3] navigate + loadEventFired ok');
  const r = await Runtime.evaluate({ expression: 'document.title', returnByValue: true });
  console.log('[4] document.title =', JSON.stringify(r.result.value));
  const r2 = await Runtime.evaluate({ expression: 'document.querySelectorAll("a").length', returnByValue: true });
  console.log('[5] <a> count =', r2.result.value);
  const shot = await Page.captureScreenshot({ format: 'png' });
  const buf = Buffer.from(shot.data, 'base64');
  console.log('[6] screenshot bytes =', buf.length, 'magic =', buf.subarray(0, 8).toString('hex'));
  console.log('CRI-TITLE-PASS =', r.result.value === 'Example Domain');
} finally {
  await client.close();
}
