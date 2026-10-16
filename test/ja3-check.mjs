// ja3-check.mjs — 校验我们生成的 ClientHello 与 curl_cffi chrome146 档位一致。
//
// 基准来源：curl_cffi 的 chrome146 实测（tls.peet.ws 回读）。
// 基准值（写死在这里，作为回归对照）：
//   JA3 密码套件/曲线组/点格式三段恒定，扩展段每次连接都变（Chrome 会重排）
//   JA4 = t13d1516h2_8daaf6152771_d8a2da3f94cd（六次取样完全相同）
//
// 本地不需要任何网络——ClientHello 是我们自己拼的字节，解回来算就行。
// 注意 peet 的 JA3/JA4 会把 GREASE 值剔掉，这里也照它的口径剔除后再比。
import { createHash } from 'node:crypto';
import { buildClientHello } from '../src/net/sni-tls.js';

const REF_CIPHERS = '4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53';
// 曲线组比 Chrome 146 少一个 4588：带上它就是 HelloRetryRequest（见 sni-tls.js 的注释）。
// 注意 JA4 不含曲线组，所以下面 JA4 三段仍然是 Chrome 146 的原值。
const REF_CURVES = '29-23-24';
const REF_EXT_SET = [13, 16, 27, 11, 35, 23, 45, 51, 65281, 65037, 17613, 0, 18, 10, 43, 5].join('-');
const REF_JA4_B = '8daaf6152771';
const REF_JA4_C = 'd8a2da3f94cd';
const REF_EXT_COUNT = 16;

const isGrease = (v) => ((v & 0xff) === (v >> 8)) && ((v & 0x0f0f) === 0x0a0a);
const h4 = (v) => v.toString(16).padStart(4, '0');
const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : extra); }
}

function parseClientHello(record) {
  const hs = record.subarray(5);
  let o = 4;
  const ver = (hs[o] << 8) | hs[o + 1]; o += 2;
  o += 32;
  const sidLen = hs[o]; o += 1 + sidLen;
  const csLen = (hs[o] << 8) | hs[o + 1]; o += 2;
  const ciphers = [];
  for (let i = 0; i < csLen; i += 2) ciphers.push((hs[o + i] << 8) | hs[o + i + 1]);
  o += csLen;
  const compLen = hs[o]; o += 1 + compLen;
  const extLen = (hs[o] << 8) | hs[o + 1]; o += 2;
  const end = o + extLen;
  const exts = [];
  let groups = [], pointfmt = [], sigalgs = [], alpn = [];
  while (o < end) {
    const t = (hs[o] << 8) | hs[o + 1];
    const l = (hs[o + 2] << 8) | hs[o + 3];
    const body = hs.subarray(o + 4, o + 4 + l);
    exts.push({ t, body });
    if (t === 10) { const n = (body[0] << 8) | body[1]; for (let i = 0; i < n; i += 2) groups.push((body[2 + i] << 8) | body[3 + i]); }
    if (t === 11) { const n = body[0]; for (let i = 0; i < n; i++) pointfmt.push(body[1 + i]); }
    if (t === 13) { const n = (body[0] << 8) | body[1]; for (let i = 0; i < n; i += 2) sigalgs.push((body[2 + i] << 8) | body[3 + i]); }
    if (t === 16) { const n = (body[0] << 8) | body[1]; let i = 2; while (i < 2 + n) { const l2 = body[i]; alpn.push(Buffer.from(body.subarray(i + 1, i + 1 + l2)).toString()); i += 1 + l2; } }
    o += 4 + l;
  }
  return { ver, ciphers, exts, groups, pointfmt, sigalgs, alpn, consumed: o, extEnd: end };
}

const pub = new Uint8Array(32); pub.fill(7);
const p = parseClientHello(buildClientHello('tls.peet.ws', pub).record);

check('record/handshake/扩展长度字段自洽', p.consumed === p.extEnd, `${p.consumed} vs ${p.extEnd}`);

const ciphers = p.ciphers.filter((c) => !isGrease(c));
const extTypes = p.exts.map((e) => e.t).filter((t) => !isGrease(t));
const curves = p.groups.filter((g) => !isGrease(g));

check('密码套件 15 个（剔 GREASE）且顺序与 Chrome 一致', ciphers.join('-') === REF_CIPHERS, ciphers.join('-'));
check('扩展 16 个（剔 GREASE）且集合与 Chrome 一致',
  extTypes.slice().sort((a, b) => a - b).join('-') === REF_EXT_SET.split('-').map(Number).sort((a, b) => a - b).join('-'),
  extTypes.slice().sort((a, b) => a - b).join('-'));
check('曲线组 29-23-24（摘掉 4588 以免 HelloRetryRequest）', curves.join('-') === REF_CURVES, curves.join('-'));
check('GREASE：第一个扩展为空体、最后一个为 1 字节（BoringSSL 固定位置）',
  isGrease(p.exts[0].t) && p.exts[0].body.length === 0 &&
  isGrease(p.exts[p.exts.length - 1].t) && p.exts[p.exts.length - 1].body.length === 1);
check('key_share 只给 GREASE + X25519（1216 字节后量子那条已摘）', (() => {
  const ks = p.exts.find((e) => e.t === 51).body;
  const n = (ks[0] << 8) | ks[1];
  const seen = [];
  for (let i = 2; i < 2 + n;) { const g = (ks[i] << 8) | ks[i + 1]; const l = (ks[i + 2] << 8) | ks[i + 3]; seen.push(g); i += 4 + l; }
  return seen.length === 2 && seen[1] === 0x001d;
})());
check('SNI 是本次目标', (() => {
  const sni = p.exts.find((e) => e.t === 0).body;
  const n = (sni[3] << 8) | sni[4];
  return Buffer.from(sni.subarray(5, 5 + n)).toString() === 'tls.peet.ws';
})());

// 扩展顺序必须每次不同（真 Chrome 就是重排的；固定顺序反而是破绽）
const orders = new Set();
for (let i = 0; i < 40; i++) orders.add(parseClientHello(buildClientHello('tls.peet.ws', pub).record).exts.map((e) => e.t).join('-'));
check('40 次生成的扩展顺序各不相同（复刻 Chrome 重排）', orders.size === 40, `只得到 ${orders.size} 种`);

// JA4：顺序无关，是稳定指纹。
// 参考实现（FoxIO ja4/common.py 的 get_hex_sorted）：扩展参与哈希时要一并剔掉
// SNI(0x0000) 和 ALPN(0x0010)，但 JA4_a 里的扩展计数仍按「剔 GREASE 后」的 16 个算。
const ja4a = `t13${
  p.exts.some((e) => e.t === 0) ? 'd' : 'i'
}${String(ciphers.length).padStart(2, '0')}${String(extTypes.length).padStart(2, '0')}${
  p.alpn.length ? p.alpn[0][0] + p.alpn[0][p.alpn[0].length - 1] : '00'}`;
const ja4b = sha12(ciphers.slice().sort((a, b) => a - b).map(h4).join(','));
const ja4cExts = extTypes.filter((t) => t !== 0x0000 && t !== 0x0010).sort((a, b) => a - b);
const ja4c = sha12(ja4cExts.map(h4).join(',') + '_' + p.sigalgs.map(h4).join(','));
console.log(`   我们: ${ja4a}_${ja4b}_${ja4c}`);
console.log(`   基准: t13d1516h2_${REF_JA4_B}_${REF_JA4_C}`);
check('JA4_b（密码套件哈希）一致', ja4b === REF_JA4_B, ja4b);
check('JA4_c（扩展+签名算法哈希）一致', ja4c === REF_JA4_C, ja4c);
check('JA4_a 扩展数一致（16）', extTypes.length === REF_EXT_COUNT, extTypes.length);
check('JA4_a 的 ALPN 标记是 h2（因此必须真的会说 h2，见 h2.js）', ja4a.endsWith('h2'), ja4a);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
