// h2.js — 最小 HTTP/2 客户端（纯字节进、纯字节出），跑在 sni-tls.js 的 TLS 流上。
//
// 为什么非要有它：我们的 ClientHello 照着真 Chrome 报 ALPN「h2, http/1.1」，
// 不报 h2 就不是 Chrome（JA4 的 alpn 标记会露）；报了服务器必然选 h2，
// 此时再发 HTTP/1.1 请求就是一堆乱码。
//
// 附带好处：Akamai 的 HTTP/2 指纹（SETTINGS 值 / 连接级 WINDOW_UPDATE 增量 /
// 伪头顺序）也一并对齐——那同样是 Bot Management 的输入。
// 实测 curl_cffi chrome146 的指纹：
//   1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
//
// 交互模型：一次请求所需的所有帧（preface/SETTINGS/WINDOW_UPDATE/HEADERS/DATA）
// 一次性构造好发出去，然后单纯读响应。不做 SETTINGS ACK、不做流控回补——
// 我们宣告的 INITIAL_WINDOW_SIZE 就是 Chrome 的 6291456（6MB），单页足够；
// 超过 6MB 的响应会停在那里，由调用方按超长处理。
// HPACK 编解码照搬 gpt2api/src/h2socks.js（同一主人的另一份实现）。
import { HUFFMAN_TABLE } from './huffman.js';

// ---------- HPACK 静态表 (RFC7541 附录 A) ----------
const STATIC_TABLE = [
  [':authority', ''], [':method', 'GET'], [':method', 'POST'], [':path', '/'],
  [':path', '/index.html'], [':scheme', 'http'], [':scheme', 'https'],
  [':status', '200'], [':status', '204'], [':status', '206'], [':status', '304'],
  [':status', '400'], [':status', '404'], [':status', '500'],
  ['accept-charset', ''], ['accept-encoding', 'gzip, deflate'], ['accept-language', ''],
  ['accept-ranges', ''], ['accept', ''], ['access-control-allow-origin', ''], ['age', ''],
  ['allow', ''], ['authorization', ''], ['cache-control', ''], ['content-disposition', ''],
  ['content-encoding', ''], ['content-language', ''], ['content-length', ''],
  ['content-location', ''], ['content-range', ''], ['content-type', ''], ['cookie', ''],
  ['date', ''], ['etag', ''], ['expect', ''], ['expires', ''], ['from', ''], ['host', ''],
  ['if-match', ''], ['if-modified-since', ''], ['if-none-match', ''], ['if-range', ''],
  ['if-unmodified-since', ''], ['last-modified', ''], ['link', ''], ['location', ''],
  ['max-forwards', ''], ['proxy-authenticate', ''], ['proxy-authorization', ''],
  ['range', ''], ['referer', ''], ['refresh', ''], ['retry-after', ''], ['server', ''],
  ['set-cookie', ''], ['strict-transport-security', ''], ['transfer-encoding', ''],
  ['user-agent', ''], ['vary', ''], ['via', ''], ['www-authenticate', ''],
];

// ---------- Huffman 解码（响应头里服务端普遍用 huffman） ----------
function buildHuffmanTrie() {
  const root = {};
  HUFFMAN_TABLE.forEach((entry, sym) => {
    const [hex, bitsStr] = entry.split(',');
    const bits = parseInt(bitsStr, 10);
    const val = BigInt('0x' + hex);
    let node = root;
    for (let i = bits - 1; i >= 0; i--) {
      const bit = Number((val >> BigInt(i)) & 1n);
      if (!node[bit]) node[bit] = {};
      node = node[bit];
    }
    node.sym = sym;
  });
  return root;
}
let TRIE = null;

function huffmanDecode(bytes) {
  if (!TRIE) TRIE = buildHuffmanTrie();
  let node = TRIE;
  let out = '';
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >> i) & 1;
      node = node[bit];
      if (!node) throw new Error('huffman: bad path');
      if (node.sym !== undefined) {
        out += String.fromCharCode(node.sym);
        node = TRIE;
      }
    }
  }
  // 结尾 padding 全是 1（EOS 前缀），停在中间节点是合法的，直接接受
  return out;
}

class HPACK {
  constructor(maxTable = 0) {
    this.maxTable = maxTable;
    this.dynamic = [];
  }
  evict() {
    let size = this.dynamic.reduce((s, e) => s + e[0].length + e[1].length + 32, 0);
    while (size > this.maxTable && this.dynamic.length) {
      const e = this.dynamic.pop();
      size -= e[0].length + e[1].length + 32;
    }
  }
  lookup(idx) {
    if (idx <= 61) return STATIC_TABLE[idx - 1];
    const e = this.dynamic[idx - 62];
    if (!e) throw new Error(`hpack: bad index ${idx}`);
    return e;
  }
  add(name, value) {
    if (this.maxTable === 0) return;
    this.dynamic.unshift([name, value]);
    this.evict();
  }
  decodeBlock(block) {
    const pairs = [];
    const u8 = block;
    let i = 0;
    const readVarint = (n) => {
      let value = u8[i] & ((1 << n) - 1);
      if (value < (1 << n) - 1) { i++; return value; }
      let m = 0;
      for (;;) {
        i++;
        const b = u8[i];
        value += (b & 127) * Math.pow(2, m);
        m += 7;
        if (!(b & 128)) { i++; return value; }
      }
    };
    const readString = () => {
      const huff = !!(u8[i] & 128);
      const len = readVarint(7);
      const raw = u8.slice(i, i + len);
      i += len;
      return huff ? huffmanDecode(raw) : new TextDecoder().decode(raw);
    };
    while (i < u8.length) {
      const b0 = u8[i];
      if (b0 & 128) {
        pairs.push(this.lookup(readVarint(7)));
      } else if ((b0 & 192) === 64) {
        let name;
        const idx = readVarint(6);
        if (idx === 0) name = readString();
        else name = this.lookup(idx)[0];
        const value = readString();
        this.add(name, value);
        pairs.push([name, value]);
      } else if ((b0 & 224) === 32) {
        this.maxTable = readVarint(5);
        this.evict();
      } else {
        let name;
        const idx = readVarint(4);
        if (idx === 0) name = readString();
        else name = this.lookup(idx)[0];
        pairs.push([name, readString()]);
      }
    }
    return pairs;
  }
}

// 编码只用 literal-without-indexing（0x00 前缀），不用 huffman 也不碰动态表——
// 这部分不进 Akamai 指纹，够用即可。
function hpackEncode(headers) {
  const out = [];
  // RFC7541 §5.1 的整数编码：值 ≥ 2^N-1 时，先写满前缀位（7 位前缀就是 0x7f），
  // 再对「值减去 2^N-1」做 128 进制续字节。漏掉那个 0x7f 或者忘了减，长度 ≥127 的
  // 头整块就解不开，服务器直接回 COMPRESSION_ERROR(9)——Accept 就有 130 字符。
  const putInt = (n, prefixBits) => {
    const max = (1 << prefixBits) - 1;
    if (n < max) { out.push(n); return; }
    out.push(max);
    n -= max;
    while (n >= 128) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
    out.push(n);
  };
  const putStr = (s) => {
    const bytes = new TextEncoder().encode(s);
    putInt(bytes.length, 7);
    for (const b of bytes) out.push(b);
  };
  for (const [n, v] of headers) {
    out.push(0x00);
    putStr(n);
    putStr(v);
  }
  return new Uint8Array(out);
}

// ---------- 帧 ----------
const FT = { DATA: 0, HEADERS: 1, PRIORITY: 2, RST: 3, SETTINGS: 4, PUSH: 5, PING: 6, GOAWAY: 7, WINDOW_UPDATE: 8, CONTINUATION: 9 };
const FL = { END_STREAM: 0x01, ACK: 0x01, END_HEADERS: 0x04, PADDED: 0x08, PRIORITY: 0x20 };

function frame(type, flags, streamId, payload) {
  const f = new Uint8Array(9 + payload.length);
  f[0] = (payload.length >> 16) & 255;
  f[1] = (payload.length >> 8) & 255;
  f[2] = payload.length & 255;
  f[3] = type;
  f[4] = flags;
  f[5] = (streamId >>> 24) & 127;
  f[6] = (streamId >>> 16) & 255;
  f[7] = (streamId >>> 8) & 255;
  f[8] = streamId & 255;
  f.set(payload, 9);
  return f;
}

// Chrome 的 SETTINGS（HEADER_TABLE_SIZE / ENABLE_PUSH / INITIAL_WINDOW_SIZE / MAX_HEADER_LIST_SIZE）
const CHROME_SETTINGS = [[1, 65536], [2, 0], [4, 6291456], [6, 262144]];
const CHROME_CONN_WINDOW_INCREMENT = 15663105;
export const H2_PREFACE = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function cat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 构造一次请求所需的全部字节（preface 起到 DATA 止），一次性发出 */
export function buildH2Request(method, authority, path, headersObj, bodyBytes) {
  const settings = new Uint8Array(CHROME_SETTINGS.length * 6);
  CHROME_SETTINGS.forEach(([id, val], i) => {
    settings[i * 6] = (id >> 8) & 255;
    settings[i * 6 + 1] = id & 255;
    settings.set(u32(val), i * 6 + 2);
  });

  // 伪头顺序必须是 m,a,s,p（Chrome 实测），顺序错了 Akamai 指纹就对不上
  const hdrs = [[':method', method], [':authority', authority], [':scheme', 'https'], [':path', path]];
  const skip = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive']);
  for (const [k, v] of Object.entries(headersObj || {})) {
    const lk = k.toLowerCase();
    if (skip.has(lk) || lk.startsWith(':')) continue;
    hdrs.push([lk, String(v)]);
  }

  const hasBody = !!(bodyBytes && bodyBytes.length);
  // HEADERS 带优先级字段：exclusive=1 / dep=0 / weight=255(=256)。真 Chrome 就是这么发的。
  // Akamai 指纹第三段数的是独立的 PRIORITY 帧（Chrome 为 0），所以优先级只能挂在 HEADERS 上。
  const priority = new Uint8Array([0x80, 0x00, 0x00, 0x00, 0xff]);
  const headFlags = FL.END_HEADERS | FL.PRIORITY | (hasBody ? 0 : FL.END_STREAM);
  const parts = [
    H2_PREFACE,
    frame(FT.SETTINGS, 0, 0, settings),
    frame(FT.WINDOW_UPDATE, 0, 0, u32(CHROME_CONN_WINDOW_INCREMENT)),
    frame(FT.HEADERS, headFlags, 1, cat(priority, hpackEncode(hdrs))),
  ];
  if (hasBody) {
    const MAXF = 16384;
    for (let off = 0; off < bodyBytes.length; off += MAXF) {
      const piece = bodyBytes.subarray(off, off + MAXF);
      const last = off + MAXF >= bodyBytes.length;
      parts.push(frame(FT.DATA, last ? FL.END_STREAM : 0, 1, piece));
    }
  }
  return cat(...parts);
}

/** 扫一遍已收全的帧，判断流 1 是否已经结束（END_STREAM / RST / GOAWAY）。
 *  返回 null 表示还要继续收。HTTP/2 是长连接，服务器不会像 HTTP/1.1 那样
 *  发完就关——等 socket 关闭来结束读取会永远等下去。 */
export function h2StreamEnded(bytes) {
  let o = 0;
  while (o + 9 <= bytes.length) {
    const len = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
    const type = bytes[o + 3];
    const flags = bytes[o + 4];
    const sid = ((bytes[o + 5] & 127) << 24) | (bytes[o + 6] << 16) | (bytes[o + 7] << 8) | bytes[o + 8];
    if (o + 9 + len > bytes.length) return null; // 帧还没收全
    if ((type === FT.DATA || type === FT.HEADERS) && sid === 1 && (flags & FL.END_STREAM)) return 'end';
    if (type === FT.RST && sid === 1) return 'reset';
    if (type === FT.GOAWAY) return 'goaway';
    o += 9 + len;
  }
  return null;
}

/** 解析响应字节（服务端→客户端方向），返回 {status, headers, body, error} */
export function parseH2Response(bytes) {
  const hpack = new HPACK(0);
  const state = { status: 0, headers: {} };
  const chunks = [];
  let total = 0;
  let headerBlock = null;
  let error = null;
  let done = false;

  const takePairs = (block) => {
    for (const [n, v] of hpack.decodeBlock(block)) {
      if (n === ':status') state.status = parseInt(v, 10);
      else state.headers[n] = state.headers[n] ? state.headers[n] + ', ' + v : v;
    }
  };

  let o = 0;
  while (o + 9 <= bytes.length && !done) {
    const len = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
    const type = bytes[o + 3];
    const flags = bytes[o + 4];
    const sid = ((bytes[o + 5] & 127) << 24) | (bytes[o + 6] << 16) | (bytes[o + 7] << 8) | bytes[o + 8];
    if (o + 9 + len > bytes.length) break; // 帧没接完，剩下的丢弃
    const payload = bytes.subarray(o + 9, o + 9 + len);
    o += 9 + len;

    if (type === FT.HEADERS && sid === 1) {
      let p = payload;
      if (flags & FL.PADDED) p = p.subarray(1 + p[0]);
      if (flags & FL.PRIORITY) p = p.subarray(5);
      if (flags & FL.END_HEADERS) takePairs(p);
      else headerBlock = p.slice();
    } else if (type === FT.CONTINUATION && sid === 1 && headerBlock) {
      const nb = new Uint8Array(headerBlock.length + payload.length);
      nb.set(headerBlock); nb.set(payload, headerBlock.length);
      headerBlock = nb;
      if (flags & FL.END_HEADERS) { takePairs(headerBlock); headerBlock = null; }
    } else if (type === FT.DATA && sid === 1) {
      if (payload.length) { chunks.push(payload); total += payload.length; }
      if (flags & FL.END_STREAM) done = true;
    } else if (type === FT.RST && sid === 1) {
      error = 'RST_STREAM code=' + (((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0);
      done = true;
    } else if (type === FT.GOAWAY) {
      done = true;
    }
  }

  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.length; }
  return { status: state.status, headers: state.headers, body, error };
}

