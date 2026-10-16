// h2-check.mjs — 校验我们发出去的 HTTP/2 前言部分与真 Chrome 的 Akamai 指纹一致。
//
// 基准（curl_cffi chrome146 实测，tls.peet.ws 回读）：
//   1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
//   即 SETTINGS 四项 / 连接级 WINDOW_UPDATE 增量 / 独立 PRIORITY 帧数 / 伪头顺序
//
// 本地纯计算，不打网络。这里的 HPACK 解码是另写的一份（不复用 h2.js 的解码器），
// 免得两个同源代码互相掩护——编码器只发 literal-without-indexing + 非 huffman 字符串，
// 手解十行就够。
import { buildH2Request, parseH2Response, H2_PREFACE } from '../src/net/h2.js';

const REF_AKAMAI = '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p';
const FT = { DATA: 0, HEADERS: 1, PRIORITY: 2, SETTINGS: 4, WINDOW_UPDATE: 8, CONTINUATION: 9 };

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : extra); }
}

/** 把字节流切成帧 */
function frames(bytes, start) {
  const out = [];
  let o = start;
  while (o + 9 <= bytes.length) {
    const len = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
    if (o + 9 + len > bytes.length) break;
    out.push({ type: bytes[o + 3], flags: bytes[o + 4], sid: ((bytes[o + 5] & 127) << 24) | (bytes[o + 6] << 16) | (bytes[o + 7] << 8) | bytes[o + 8], payload: bytes.subarray(o + 9, o + 9 + len) });
    o += 9 + len;
  }
  return out;
}

/** 只解 literal-without-indexing(0x00) + 非 huffman 字符串 */
function decodeSimpleHpack(block) {
  const out = [];
  let i = 0;
  const readStr = () => {
    let n = block[i]; i++;
    if (n === 127) { let m = 0; n = 0; for (;;) { const b = block[i]; i++; n += (b & 127) * Math.pow(2, m); m += 7; if (!(b & 128)) break; } }
    const s = new TextDecoder().decode(block.subarray(i, i + n));
    i += n;
    return s;
  };
  while (i < block.length) {
    if (block[i] !== 0x00) throw new Error('本测试只解 literal-without-indexing，遇到 0x' + block[i].toString(16));
    i++;
    out.push([readStr(), readStr()]);
  }
  return out;
}

const req = buildH2Request('GET', 'tls.peet.ws', '/api/all',
  { 'user-agent': 'UA', 'accept': 'text/html' }, null);
check('以 h2 preface 开头', Buffer.from(req.subarray(0, 24)).toString() === Buffer.from(H2_PREFACE).toString());

const fs = frames(req, 24);
const settingFrame = fs.find((f) => f.type === FT.SETTINGS);
const settings = [];
for (let i = 0; i < settingFrame.payload.length; i += 6) {
  const id = (settingFrame.payload[i] << 8) | settingFrame.payload[i + 1];
  const val = ((settingFrame.payload[i + 2] << 24) | (settingFrame.payload[i + 3] << 16) | (settingFrame.payload[i + 4] << 8) | settingFrame.payload[i + 5]) >>> 0;
  settings.push(`${id}:${val}`);
}
const wu = fs.find((f) => f.type === FT.WINDOW_UPDATE);
const wuInc = ((wu.payload[0] << 24) | (wu.payload[1] << 16) | (wu.payload[2] << 8) | wu.payload[3]) >>> 0;
const prioFrames = fs.filter((f) => f.type === FT.PRIORITY).length;

const headFrame = fs.find((f) => f.type === FT.HEADERS);
const hb = (headFrame.flags & 0x20) ? headFrame.payload.subarray(5) : headFrame.payload;
const names = decodeSimpleHpack(hb).map(([n]) => n);
const map = { ':method': 'm', ':authority': 'a', ':scheme': 's', ':path': 'p' };
const order = names.filter((n) => map[n]).map((n) => map[n]).join(',');

const akamai = `${settings.join(';')}|${wuInc}|${prioFrames}|${order}`;
console.log('   我们:', akamai);
console.log('   基准:', REF_AKAMAI);
check('Akamai HTTP/2 指纹与 curl_cffi chrome146 一致', akamai === REF_AKAMAI, akamai);
check('HEADERS 带 PRIORITY 标志（Chrome 把优先级挂在 HEADERS 上，不是独立帧）', !!(headFrame.flags & 0x20));
check('无独立 PRIORITY 帧（Chrome 为 0）', prioFrames === 0);
check('GET 无体时 HEADERS 带 END_STREAM', !!(headFrame.flags & 0x01));

// 响应解析：造一个 200 + content-type + 一个 DATA 帧
const enc = (s) => { const b = new TextEncoder().encode(s); return [b.length, ...b]; };
const block = new Uint8Array([0x00, ...enc(':status'), ...enc('200'), 0x00, ...enc('content-type'), ...enc('text/html')]);
const mkFrame = (type, flags, sid, payload) => {
  const f = new Uint8Array(9 + payload.length);
  f[0] = (payload.length >> 16) & 255; f[1] = (payload.length >> 8) & 255; f[2] = payload.length & 255;
  f[3] = type; f[4] = flags;
  f[5] = (sid >>> 24) & 127; f[6] = (sid >>> 16) & 255; f[7] = (sid >>> 8) & 255; f[8] = sid & 255;
  f.set(payload, 9);
  return f;
};
const bodyText = new TextEncoder().encode('<html>hi</html>');
const respBytes = new Uint8Array([
  ...mkFrame(FT.SETTINGS, 0, 0, new Uint8Array([0, 3, 0, 0, 0, 100])),
  ...mkFrame(FT.HEADERS, 0x04, 1, block),
  ...mkFrame(FT.DATA, 0x01, 1, bodyText),
]);
const r = parseH2Response(respBytes);
check('响应解析：状态 200', r.status === 200, r.status);
check('响应解析：content-type 正确', r.headers['content-type'] === 'text/html', r.headers['content-type']);
check('响应解析：body 正确', new TextDecoder().decode(r.body) === '<html>hi</html>', new TextDecoder().decode(r.body));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
