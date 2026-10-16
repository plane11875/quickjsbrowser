// 验收 A（本地）：puppeteer-core connect ws://localhost:8799/cdp → goto example.com → evaluate title
import puppeteer from 'puppeteer-core';

const BASE = process.env.CDP_WS || 'ws://localhost:8799/cdp?key=local-test-key&s=t1';

const browser = await puppeteer.connect({ browserWSEndpoint: BASE, defaultViewport: { width: 1280, height: 900 } });
console.log('[1] connect ok');
try {
  const page = await browser.newPage();
  console.log('[2] newPage ok');
  await page.goto('https://example.com', { waitUntil: 'load', timeout: 60000 });
  console.log('[3] goto ok, url =', page.url());
  const title = await page.evaluate(() => document.title);
  console.log('[4] evaluate document.title =', JSON.stringify(title));
  const h1 = await page.evaluate(() => document.querySelector('h1')?.textContent);
  console.log('[5] evaluate h1 =', JSON.stringify(h1));
  const asyncVal = await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 200)); return 1 + 41; });
  console.log('[6] async evaluate =', asyncVal);
  const shot = await page.screenshot({ type: 'png' });
  console.log('[7] screenshot bytes =', shot.length, 'magic =', shot.subarray(0, 8).toString('hex'));
  console.log('TITLE-PASS =', title === 'Example Domain');
} finally {
  await browser.close();
}
