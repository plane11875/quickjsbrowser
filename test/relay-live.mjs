// relay-live.mjs — 端到端真网络：经反代 IP 走我们自己的手搓 TLS + HTTP/2 抓真站点。
//
// 最有价值的是第一条：打 tls.peet.ws，让它把我们发出的 ClientHello 和 HTTP/2 前言
// 读回来。本地测试验的是「我们以为自己发了什么」，这一条验的是「对面实际收到了什么」。
//
// 本机可直连反代（实测 251ms），所以不必部署就能跑：
//   node --import ./test/register.mjs test/relay-live.mjs
import { relayFetch } from '../src/net/relay.js';
import { requestHeaders } from '../src/fingerprint.js';

const RELAY = process.env.RELAY_IP || '127.0.0.1:2096';
const REF_JA4 = 't13d1516h2_8daaf6152771_d8a2da3f94cd';
const REF_AKAMAI = '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p';

let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x === undefined ? '' : x); } };

async function get(url, extra = {}) {
  const t0 = Date.now();
  const r = await relayFetch(RELAY, url, {
    headers: requestHeaders({ type: 'document', url, ...extra }),
  });
  const body = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, headers: Object.fromEntries(r.headers), body, text: new TextDecoder().decode(body), ms: Date.now() - t0 };
}

// ---- 1. 让 peet 回读我们真实的指纹 ----
try {
  const r = await get('https://tls.peet.ws/api/all');
  console.log(`\n[peet] status=${r.status} ${r.body.length}B ${r.ms}ms`);
  if (r.status === 200) {
    const j = JSON.parse(r.text);
    const t = j.tls || {}, h2 = j.http2 || {};
    console.log('  它对我们的判定:');
    console.log('    JA3     :', t.ja3);
    console.log('    JA3 hash:', t.ja3_hash);
    console.log('    JA4     :', t.ja4);
    console.log('    akamai  :', h2.akamai_fingerprint);
    console.log('    alpn    :', j.http2 ? 'h2' : '?');
    check('对面读到的 JA4 == curl_cffi chrome146', t.ja4 === REF_JA4, t.ja4);
    check('对面读到的 Akamai h2 指纹 == curl_cffi chrome146', h2.akamai_fingerprint === REF_AKAMAI, h2.akamai_fingerprint);
    check('JA3 的密码套件段与 Chrome 一致',
      (t.ja3 || '').split(',')[1] === '4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53',
      (t.ja3 || '').split(',')[1]);
    check('JA3 的曲线组段含后量子组 4588', (t.ja3 || '').split(',')[3] === '4588-29-23-24', (t.ja3 || '').split(',')[3]);
  } else {
    check('peet 返回 200', false, r.status);
  }
} catch (e) {
  console.log('[peet] 失败:', String(e && e.message || e));
  check('peet 请求成功', false, String(e && e.message || e));
}

// ---- 2. 真站点 ----
for (const [name, url, want] of [
  ['Hacker News', 'https://news.ycombinator.com/', /Hacker News/i],
  ['x.com', 'https://x.com/elonmusk', /Elon Musk/i],
  ['linux.do', 'https://linux.do/t/topic/3029893', null],
]) {
  try {
    const r = await get(url);
    const title = (/<title[^>]*>([^<]{0,80})/i.exec(r.text) || [])[1] || '';
    console.log(`\n[${name}] status=${r.status} ${r.body.length}B ${r.ms}ms title="${title}"`);
    if (want) check(`${name} 拿到期望页面`, r.status === 200 && want.test(r.text), `status=${r.status} title=${title}`);
  } catch (e) {
    console.log(`\n[${name}] 失败: ${String(e && e.message || e)}`);
    check(`${name} 请求成功`, false, String(e && e.message || e));
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
