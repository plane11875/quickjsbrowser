import puppeteer from 'puppeteer-core';
const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://localhost:8799/cdp?key=local-test-key&s=probe1', defaultViewport: { width: 1280, height: 900 } });
try {
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'load', timeout: 60000 });
  console.log('title       =', JSON.stringify(await page.evaluate(() => document.title)));
  console.log('h1          =', JSON.stringify(await page.evaluate(() => document.querySelector('h1')?.textContent)));
  console.log('h1 tagName  =', JSON.stringify(await page.evaluate(() => document.querySelector('h1')?.tagName)));
  console.log('a href      =', JSON.stringify(await page.evaluate(() => document.querySelector('a')?.href)));
  console.log('body len    =', await page.evaluate(() => document.body.innerHTML.length));
  console.log('p           =', JSON.stringify(await page.evaluate(() => document.querySelector('p')?.textContent)));
} finally { await browser.close(); }
