// 手搓 TLS 1.3 客户端：裸 connect(反代IP) → 手搓 ClientHello(SNI=目标) → 完整握手 → HTTP 流式读写
// 不依赖 node 模块，纯 WebCrypto + 纯 JS x25519
import { connect } from 'cloudflare:sockets';
import { LEGACY_VERSION, CIPHERS, COMPRESSION, EXTENSIONS, CANONICAL_EXT_ORDER } from './chrome-hello.js';

const utf8 = new TextEncoder();

// ============ 纯 JS x25519 (RFC 7748) ============
const P = 2n ** 255n - 19n;
const A24 = 121665n;
function decodeLE(b) {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}
function encodeLE(n, len) {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) { b[i] = Number(n & 0xffn); n >>= 8n; }
  return b;
}
function modP(a) { let r = a % P; if (r < 0n) r += P; return r; }
function powmod(a, e) {
  let r = 1n, b = modP(a);
  while (e > 0n) { if (e & 1n) r = modP(r * b); b = modP(b * b); e >>= 1n; }
  return r;
}
function x25519(k, u) {
  const K = new Uint8Array(k);
  K[0] &= 248; K[31] &= 127; K[31] |= 64;
  const x1 = decodeLE(u);
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
  for (let t = 254; t >= 0; t--) {
    const kt = BigInt((K[t >> 3] >> (t & 7)) & 1);
    swap ^= kt;
    if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    swap = kt;
    const A = modP(x2 + z2), AA = modP(A * A);
    const B = modP(x2 - z2), BB = modP(B * B);
    const E = modP(AA - BB);
    const C = modP(x3 + z3), D = modP(x3 - z3);
    const DA = modP(D * A), CB = modP(C * B);
    x3 = modP(DA + CB); x3 = modP(x3 * x3);
    z3 = modP(x1 * modP(DA - CB)); z3 = modP(z3 * (DA - CB));
    x2 = modP(AA * BB);
    z2 = modP(E * modP(AA + A24 * E));
  }
  if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
  const r = modP(x2 * powmod(z2, P - 2n));
  return encodeLE(r, 32);
}
const BASE = new Uint8Array(32); BASE[0] = 9;
function x25519Keygen() {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return { secret: k, public: x25519(k, BASE) };
}
function x25519Shared(secret, peerPublic) { return x25519(secret, peerPublic); }

// ============ WebCrypto 原语 ============
function hashLen(hash) { return hash === 'SHA-384' ? 48 : 32; }
function keyLenFor(suite) { return suite === 0x1301 ? 16 : 32; }
async function hashFn(hash, data) {
  return new Uint8Array(await crypto.subtle.digest(hash, data));
}
async function hmacFn(hash, key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function hkdfExtract(hash, salt, ikm) {
  const s = salt.length ? salt : new Uint8Array(hashLen(hash));
  return hmacFn(hash, s, ikm);
}
async function hkdfExpand(hash, prk, info, len) {
  let out = new Uint8Array(0);
  let t = new Uint8Array(0);
  let i = 1;
  while (out.length < len) {
    const m = new Uint8Array(t.length + info.length + 1);
    m.set(t, 0); m.set(info, t.length); m[t.length + info.length] = i;
    t = await hmacFn(hash, prk, m);
    const tmp = new Uint8Array(out.length + t.length);
    tmp.set(out, 0); tmp.set(t, out.length);
    out = tmp;
    i++;
  }
  return out.slice(0, len);
}
async function hkdfExpandLabel(hash, secret, label, context, len) {
  const l = utf8.encode('tls13 ' + label);
  const info = new Uint8Array(2 + 1 + l.length + 1 + context.length);
  const dv = new DataView(info.buffer);
  dv.setUint16(0, len);
  info[2] = l.length;
  info.set(l, 3);
  info[3 + l.length] = context.length;
  info.set(context, 4 + l.length);
  return hkdfExpand(hash, secret, info, len);
}
async function deriveSecret(hash, secret, label, messages) {
  const th = await hashFn(hash, messages);
  return hkdfExpandLabel(hash, secret, label, th, hashLen(hash));
}
async function aeadEncrypt(key, iv, seq, plaintext, aad) {
  const nonce = nonceFor(iv, seq);
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, k, plaintext);
  return new Uint8Array(ct);
}
async function aeadDecrypt(key, iv, seq, ciphertext, aad) {
  const nonce = nonceFor(iv, seq);
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, k, ciphertext);
  return new Uint8Array(pt);
}
function nonceFor(iv, seq) {
  const n = new Uint8Array(12);
  n.set(iv, 0);
  for (let i = 0; i < 8; i++) n[11 - i] ^= Number((BigInt(seq) >> BigInt(8 * i)) & 0xffn);
  return n;
}
function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ============ TLS 1.3 客户端 ============
// ClientHello 不再手搓骨架：密码套件列表、扩展顺序与扩展体全部取自 chrome-hello.js
// （一份真 Chrome 抓包的逐字节转写），这里只填每次连接才会变的那几处。
function u16(n) { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }
function u24(n) { return new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]); }
function hexBytes(hex) {
  const out = new Uint8Array((hex || '').length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function extBody(ext, hostname, pubkey, opts) {
  switch (ext.kind) {
    case 'sni': {
      const h = utf8.encode(hostname);
      return concat(u16(h.length + 3), new Uint8Array([0x00]), u16(h.length), h);
    }
    case 'keyshare': {
      const shares = [concat(u16(ext.greaseGroup), u16(1), new Uint8Array([0x00]))];
      // 真包这里有 1216 字节的 X25519MLKEM768 共享。我们算不出它的共享密钥，发出去
      // 服务器就可能选它 → 握手必死，所以默认删掉；supported_groups 里保留 4588，
      // 所以 JA3 的曲线组字段仍然和 Chrome 一致。
      if (opts.pq) {
        const pq = hexBytes(ext.pqBody);
        shares.push(concat(u16(ext.pqGroup), u16(pq.length), pq));
      }
      shares.push(concat(u16(ext.x25519Group), u16(pubkey.length), pubkey));
      const list = concat(...shares);
      return concat(u16(list.length), list);
    }
    case 'groups': {
      // 默认把 4588(X25519MLKEM768) 摘掉。实测：只要它在 supported_groups 里而 key_share 没给
      // 对应共享，Cloudflare 就回 HelloRetryRequest（random 前缀 cf21ad74…，99 字节），握手到此为止；
      // 摘掉之后立刻正常。要真正带上它得实现 ML-KEM 768 的解封装，目前没有。
      //
      // 代价：JA3 的曲线组字段从 Chrome 146 的 `4588-29-23-24` 变成 `29-23-24`，
      // 也就是「131 之前的老 Chrome」的样子。但 JA4 不含曲线组，三段全都还是 Chrome 146
      // 的值——而 JA4 才是稳定、且被 Cloudflare 实际使用的那个指纹。
      const gs = opts.pq ? ext.groups : ext.groups.filter((g) => g !== 0x11ec);
      const list = concat(...gs.map(u16));
      return concat(u16(list.length), list);
    }
    case 'alpn': {
      const names = opts.protocols || ext.protocols;
      const list = concat(...names.map((n) => {
        const b = utf8.encode(n);
        return concat(new Uint8Array([b.length]), b);
      }));
      return concat(u16(list.length), list);
    }
    default:
      return hexBytes(ext.b);
  }
}

// BoringSSL ssl_setup_extension_permutation 的复刻：对规范表下标做 Fisher-Yates，
// 洗牌用的种子每条连接重新随机（BoringSSL 用的是 RAND_bytes）。
// 输出 = 本次实际要发的扩展的次序；GREASE 首尾两条不参与，单独处理。
function shuffledExtensionOrder(exts) {
  const n = CANONICAL_EXT_ORDER.length;
  const perm = new Uint8Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  const seeds = new Uint32Array(n - 1);
  crypto.getRandomValues(seeds);
  for (let i = n - 1; i > 0; i--) {
    const j = seeds[i - 1] % (i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const rank = new Map();
  for (let u = 0; u < n; u++) rank.set(CANONICAL_EXT_ORDER[perm[u]], u);
  // 规范表里没有的（理论上不该有）排到最后，保证确定性而不是靠 sort 的稳定性
  return exts.slice().sort((a, b) => (rank.get(a.t) ?? 1e9) - (rank.get(b.t) ?? 1e9));
}

// opts: { pq: 是否带上后量子共享(默认 false), dropPqGroup: 是否把 4588 也从 supported_groups
// 摘掉(默认 false，摘了 JA3 曲线组就和 Chrome 不一致), protocols: ALPN 列表(默认只报 http/1.1，
// 因为本文件的 HTTP 层就是 HTTP/1.1；真包报 h2+http/1.1，要一致得上 HTTP/2 客户端) }
// 导出是为了测试：本地就能把生成的 ClientHello 解回来算 JA3/JA4，不必打网络。
export function buildClientHello(hostname, pubkey, opts = {}) {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const sid = new Uint8Array(32);
  crypto.getRandomValues(sid);

  const cs = concat(...CIPHERS.map(u16));
  const drop = new Set(opts.drop || []);
  const g1 = EXTENSIONS.filter((e) => e.kind === 'grease1');
  const g2 = EXTENSIONS.filter((e) => e.kind === 'grease2');
  const middle = shuffledExtensionOrder(
    EXTENSIONS.filter((e) => e.kind !== 'grease1' && e.kind !== 'grease2' && !drop.has(e.t)),
  );
  const exts = [...g1, ...middle, ...g2].map((ext) => {
    const body = extBody(ext, hostname, pubkey, opts);
    return concat(u16(ext.t), u16(body.length), body);
  });
  const extAll = concat(...exts);

  const body = concat(
    u16(LEGACY_VERSION),
    random,
    new Uint8Array([sid.length]), sid,
    u16(cs.length), cs,
    new Uint8Array([COMPRESSION.length]), new Uint8Array(COMPRESSION),
    u16(extAll.length), extAll,
  );
  const hs = concat(new Uint8Array([0x01]), u24(body.length), body);
  const record = concat(new Uint8Array([0x16, 0x03, 0x01]), u16(hs.length), hs);
  return { record, handshake: hs };
}

function parseServerHello(payload) {
  let off = 4;
  off += 2 + 32; // version + random
  const sidLen = payload[off]; off += 1 + sidLen;
  const suite = (payload[off] << 8) | payload[off + 1]; off += 2;
  off += 1; // compression
  const extLen = (payload[off] << 8) | payload[off + 1]; off += 2;
  let serverPub = null;
  const end = off + extLen;
  while (off + 4 <= end) {
    const type = (payload[off] << 8) | payload[off + 1];
    const len = (payload[off + 2] << 8) | payload[off + 3];
    off += 4;
    if (type === 0x0033) {
      const kl = (payload[off + 2] << 8) | payload[off + 3];
      serverPub = payload.slice(off + 4, off + 4 + kl);
    }
    off += len;
  }
  // 注意：ALPN 不在这里。TLS 1.3 的 RFC 8446 §4.3.1 把 ALPN 放在 EncryptedExtensions
  // （握手类型 0x08，加密的）里，ServerHello 只有 key_share / supported_versions / psk。
  // 早期版本在这里找 ALPN 永远找不到，结果就是「明知道是 h2 却发 HTTP/1.1」，被服务器掐线。
  return { suite, serverPub };
}

// 从 EncryptedExtensions（握手类型 0x08，走握手密钥加密）里取出服务端选中的 ALPN。
// 结构：u16 扩展段总长 + 若干 (u16 type, u16 len, body)；ALPN 的 body 是
// u16 协议名列表长度 + (u8 名长 + 名)。
function alpnFromEncryptedExtensions(body) {
  if (body.length < 2) return null;
  const total = (body[0] << 8) | body[1];
  let o = 2;
  const end = Math.min(2 + total, body.length);
  while (o + 4 <= end) {
    const t = (body[o] << 8) | body[o + 1];
    const l = (body[o + 2] << 8) | body[o + 3];
    if (t === 0x0010 && o + 7 <= end) {
      const nl = body[o + 6];
      return new TextDecoder().decode(body.slice(o + 7, o + 7 + nl));
    }
    o += 4 + l;
  }
  return null;
}

function handshakeMsg(type, body) {
  return concat(new Uint8Array([type, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body);
}
function recordHeader(type, payloadLen) {
  return new Uint8Array([type, 0x03, 0x03, (payloadLen >> 8) & 0xff, payloadLen & 0xff]);
}
function record(type, payload) {
  const rec = new Uint8Array(5 + payload.length);
  rec[0] = type; rec[1] = 0x03; rec[2] = 0x03;
  rec[3] = (payload.length >> 8) & 0xff; rec[4] = payload.length & 0xff;
  rec.set(payload, 5);
  return rec;
}

class RecordBuffer {
  constructor(stream) {
    this.stream = stream;
    this.buf = new Uint8Array(0);
  }
  async readRecord() {
    while (this.buf.length < 5) {
      const c = await this.stream.read();
      if (c === null) throw new Error('socket closed while reading record header');
      this.buf = concat(this.buf, c);
    }
    const type = this.buf[0];
    const len = (this.buf[3] << 8) | this.buf[4];
    while (this.buf.length < 5 + len) {
      const c = await this.stream.read();
      if (c === null) throw new Error('socket closed while reading record body');
      this.buf = concat(this.buf, c);
    }
    const payload = this.buf.slice(5, 5 + len);
    this.buf = this.buf.slice(5 + len);
    return { type, payload };
  }
}

// cloudflare:sockets → { write, read, destroy } 流
export function makeCFStream(sock) {
  const reader = sock.readable.getReader();
  const writer = sock.writable.getWriter();
  return {
    async write(d) { await writer.write(d); },
    async read() {
      const { value, done } = await reader.read();
      if (done) return null;
      return value;
    },
    destroy() { try { sock.close(); } catch (e) {} },
  };
}

// 核心：经反代IP 完成到 targetHost 的完整 TLS 1.3 握手 + 发送 HTTP 请求
// 返回 async generator，逐段产出解密后的 HTTP 响应字节（含状态行/头/体原始字节）
export async function* tlsRequest(stream, targetHost, method, path, headerLines, bodyBytes, opts) {
  const { secret, public: pub } = x25519Keygen();
  const hello = buildClientHello(targetHost, pub, opts);
  await stream.write(hello.record);

  const rb = new RecordBuffer(stream);
  let shMsg = null;
  while (true) {
    const rec = await rb.readRecord();
    if (rec.type === 0x15) throw new Error('TLS Alert: ' + hex(rec.payload));
    if (rec.type === 0x16) {
      if (rec.payload[0] === 0x02) { shMsg = rec.payload; break; }
    }
  }
  const sh = parseServerHello(shMsg);
  // 把协商到的密码套件回写给调用方（relay.js 据此判断我们能不能算这把套件）
  if (opts) opts.negotiatedSuite = sh.suite;
  const hash = sh.suite === 0x1302 ? 'SHA-384' : 'SHA-256';
  const keyLen = keyLenFor(sh.suite);
  if (sh.suite !== 0x1301 && sh.suite !== 0x1302) throw new Error('unsupported suite 0x' + sh.suite.toString(16));

  const shared = x25519Shared(secret, sh.serverPub);
  const empty = new Uint8Array(0);
  const zeroes = new Uint8Array(hashLen(hash));
  const early = await hkdfExtract(hash, empty, zeroes);
  const derived = await deriveSecret(hash, early, 'derived', empty);
  const hsSecret = await hkdfExtract(hash, derived, shared);
  const transcriptSH = concat(hello.handshake, shMsg);
  const cHsSec = await deriveSecret(hash, hsSecret, 'c hs traffic', transcriptSH);
  const sHsSec = await deriveSecret(hash, hsSecret, 's hs traffic', transcriptSH);
  const cHsKey = await hkdfExpandLabel(hash, cHsSec, 'key', empty, keyLen);
  const cHsIv = await hkdfExpandLabel(hash, cHsSec, 'iv', empty, 12);
  const sHsKey = await hkdfExpandLabel(hash, sHsSec, 'key', empty, keyLen);
  const sHsIv = await hkdfExpandLabel(hash, sHsSec, 'iv', empty, 12);

  const transcriptMsgs = [hello.handshake, shMsg];
  let sSeq = 0;
  let serverFinished = null;
  while (!serverFinished) {
    const rec = await rb.readRecord();
    if (rec.type === 0x15) throw new Error('TLS Alert during handshake');
    if (rec.type !== 0x17) continue;
    const plain = await aeadDecrypt(sHsKey, sHsIv, sSeq, rec.payload, recordHeader(0x17, rec.payload.length));
    sSeq++;
    let end = plain.length - 1;
    while (end > 0 && plain[end] === 0x00) end--;
    const inner = plain.slice(0, end);
    let off = 0;
    while (off + 4 <= inner.length) {
      const t = inner[off];
      const len = (inner[off + 1] << 16) | (inner[off + 2] << 8) | inner[off + 3];
      const msg = inner.slice(off, off + 4 + len);
      transcriptMsgs.push(msg);
      if (t === 0x14) { serverFinished = msg; }
      if (t === 0x08 && opts) opts.negotiatedAlpn = alpnFromEncryptedExtensions(msg.slice(4));
      off += 4 + len;
    }
  }

  // client Finished（内层 content type = 0x16）
  const thBeforeCF = await hashFn(hash, concat(...transcriptMsgs));
  const cFinKey = await hkdfExpandLabel(hash, cHsSec, 'finished', empty, hashLen(hash));
  const verifyData = await hmacFn(hash, cFinKey, thBeforeCF);
  const finMsg = handshakeMsg(0x14, verifyData);
  const finPlain = concat(finMsg, new Uint8Array([0x16]));
  const finEnc = await aeadEncrypt(cHsKey, cHsIv, 0, finPlain, recordHeader(0x17, finPlain.length + 16));
  await stream.write(record(0x17, finEnc));

  // app secrets
  const derived2 = await deriveSecret(hash, hsSecret, 'derived', empty);
  const master = await hkdfExtract(hash, derived2, zeroes);
  const transcriptApp = concat(...transcriptMsgs);
  const cApSec = await deriveSecret(hash, master, 'c ap traffic', transcriptApp);
  const sApSec = await deriveSecret(hash, master, 's ap traffic', transcriptApp);
  const cApKey = await hkdfExpandLabel(hash, cApSec, 'key', empty, keyLen);
  const cApIv = await hkdfExpandLabel(hash, cApSec, 'iv', empty, 12);
  const sApKey = await hkdfExpandLabel(hash, sApSec, 'key', empty, keyLen);
  const sApIv = await hkdfExpandLabel(hash, sApSec, 'iv', empty, 12);

  // 组装要发出去的字节（分片成多个 ≤16KB 的 TLS 记录，避免 record_overflow）。
  // opts.buildRequest(alpn) 在握手之后才被调用，因为「说 h2 还是说 HTTP/1.1」得看协商结果；
  // 它返回 null 就回退到下面拼的 HTTP/1.1 请求。
  const body = bodyBytes ? (typeof bodyBytes === 'string' ? utf8.encode(bodyBytes) : bodyBytes) : null;
  const head = `${method} ${path} HTTP/1.1\r\nHost: ${targetHost}\r\n` + headerLines +
    (body ? `Content-Length: ${body.length}\r\n` : '') + 'Connection: close\r\n\r\n';
  const built = opts && opts.buildRequest ? opts.buildRequest(opts.negotiatedAlpn) : null;
  const reqContent = built || (body ? concat(utf8.encode(head), body) : utf8.encode(head));

  const MAX_RECORD = 16000; // TLS 记录明文上限 16384，留余量给内层类型字节
  let reqSeq = 0;
  for (let i = 0; i < reqContent.length; i += MAX_RECORD) {
    const part = reqContent.slice(i, Math.min(i + MAX_RECORD, reqContent.length));
    const plain = concat(part, new Uint8Array([0x17]));
    const enc = await aeadEncrypt(cApKey, cApIv, reqSeq, plain, recordHeader(0x17, plain.length + 16));
    await stream.write(record(0x17, enc));
    reqSeq++;
  }

  // 产出解密后的响应字节
  let apSeq = 0;
  while (true) {
    const rec = await rb.readRecord();
    if (rec.type === 0x15) {
      if (rec.payload[1] === 0x00) return; // close_notify → 正常结束
      throw new Error('TLS Alert: ' + hex(rec.payload));
    }
    if (rec.type === 0x17) {
      const plain = await aeadDecrypt(sApKey, sApIv, apSeq, rec.payload, recordHeader(0x17, rec.payload.length));
      apSeq++;
      let end = plain.length - 1;
      while (end > 0 && plain[end] === 0x00) end--;
      const innerType = plain[end];
      if (innerType === 0x15) {
        if (plain[1] === 0x00) return; // close_notify
        throw new Error('TLS Alert(encrypted) level=' + plain[0] + ' desc=' + plain[1]);
      }
      if (innerType === 0x16) continue; // NewSessionTicket 等
      const chunk = plain.slice(0, end);
      if (chunk.length) yield chunk;
    } else if (rec.type === 0x16) {
      // 理论不该出现，跳过
    }
  }
}

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
