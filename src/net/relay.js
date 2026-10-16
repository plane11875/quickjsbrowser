// 反代(SNI 中继)传输层：把抓取从 CF 的出口 IP 上摘下来。
//
// 动机：Worker 的 fetch() 出口永远是 CF 机房 IP，Cloudflare Bot Management 认这个
// （linux.do 403 challenge、HN 419），而 cloudflare:sockets 又明令禁止连 CF 自己的
// 地址段，所以 Worker 内部无解。反代 IP 是个中转站：TCP 连到它，TLS 的 SNI 写目标域名，
// 它按 SNI 转发，目标站看到的是反代的 IP。
//
// 附带收益：TLS 握手由我们自己做，ClientHello 完全可控，指纹在这一层
// （对照实测见 AGENTS.md，本 Worker 的 fetch 出口是 CF 的 TLS 栈，改不了）。
//
// 协议参考 gpt2api/src/transport.js（同一个主人，同一套反代）。
import { connect } from 'cloudflare:sockets';
import { makeCFStream, tlsRequest } from './sni-tls.js';
import { buildH2Request, parseH2Response, h2StreamEnded } from './h2.js';

const MAX_REDIRECTS = 5;
const MAX_BODY = 8_000_000;

function findHeaderEnd(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function parseHead(text) {
  const lines = text.split('\r\n');
  const m = lines[0].match(/^HTTP\/\d\.\d\s+(\d+)/);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx <= 0) continue;
    const name = lines[i].slice(0, idx).trim().toLowerCase();
    const value = lines[i].slice(idx + 1).trim();
    // set-cookie 会重复出现，合并成逗号分隔（够 cookie 罐用）
    headers[name] = headers[name] ? headers[name] + ', ' + value : value;
  }
  return { status: m ? parseInt(m[1], 10) : 502, headers };
}

function dechunk(buf) {
  const out = [];
  let total = 0;
  let i = 0;
  const crlf = (from) => {
    for (let k = from; k + 1 < buf.length; k++) if (buf[k] === 13 && buf[k + 1] === 10) return k;
    return -1;
  };
  const dec = new TextDecoder();
  while (i < buf.length) {
    const j = crlf(i);
    if (j < 0) break;
    const n = parseInt(dec.decode(buf.slice(i, j)).split(';')[0].trim(), 16);
    if (!Number.isFinite(n) || n === 0) break;
    if (j + 2 + n > buf.length) break;
    out.push(buf.slice(j + 2, j + 2 + n));
    total += n;
    i = j + 2 + n + 2;
  }
  const res = new Uint8Array(total);
  let off = 0;
  for (const c of out) { res.set(c, off); off += c.length; }
  return res;
}

/** 单跳：连反代 → 手搓 TLS(SNI=目标) → HTTP/1.1，收完整个响应 */
async function once(relay, target, method, headers, body, opts, signal) {
  const [relayHost, relayPort] = relay.split(':');
  let stream = null, sock = null, onAbort;
  const aborted = new Promise((_,reject)=>{
    onAbort=()=>{try{stream?.destroy();sock?.close();}catch{}reject(signal.reason||new Error('relay aborted'));};
    if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
  });
  try {
    sock = connect({ hostname: relayHost, port: parseInt(relayPort, 10) || 443 });
    await Promise.race([sock.opened,aborted]);
    stream = makeCFStream(sock);

    let headerLines = '';
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      // host 由 tls 层按目标域名写；content-length 由 tls 层自己加（重复会被上游 400）；
      // accept-encoding 强制 identity——我们不做解压，声明了 gzip 拿回来就是乱码。
      if (lk === 'host' || lk === 'connection' || lk === 'content-length' || lk === 'accept-encoding') continue;
      headerLines += `${k}: ${v}\r\n`;
    }
    headerLines += 'Accept-Encoding: identity\r\n';

    const bodyBytes = body == null ? null
      : (body instanceof Uint8Array ? body : new TextEncoder().encode(String(body)));

    // 我们照真 Chrome 报 ALPN「h2, http/1.1」，服务器必然选 h2；这时必须真的说 h2，
    // 否则发过去的 HTTP/1.1 请求在对面看来就是乱码。只有对面选了 http/1.1 才回退。
    const tlsOpts = {
      ...(opts || {}),
      buildRequest: (alpn) => (alpn === 'h2'
        ? buildH2Request(method, target.hostname, target.pathname + target.search, headers, bodyBytes)
        : null),
    };

    const gen = tlsRequest(stream, target.hostname, method,
      target.pathname + target.search, headerLines, bodyBytes, tlsOpts);

    const dec = new TextDecoder();
    let buf = new Uint8Array(0);
    let headerEnd = -1;
    let contentLength = -1;
    let h2mode = false;
    for (;;) {
      const { value, done } = await Promise.race([gen.next(),aborted]);
      if (done) break;
      // 握手在第一次 yield 之前就完成了，所以这里已经能读到协商结果
      if (!h2mode && tlsOpts.negotiatedAlpn === 'h2') h2mode = true;
      const nb = new Uint8Array(buf.length + value.length);
      nb.set(buf); nb.set(value, buf.length);
      buf = nb;
      if (h2mode) {
        // h2 是长连接，服务器发完不会关；收到流 1 的 END_STREAM 才收手，
        // 否则会一直等下去（实测挂死）。
        if (buf.length > MAX_BODY) break;
        if (h2StreamEnded(buf)) break;
        continue;
      }
      if (headerEnd < 0) {
        headerEnd = findHeaderEnd(buf);
        if(headerEnd>=0){
          const parsed=parseHead(dec.decode(buf.slice(0,headerEnd)));
          if(!(parsed.headers['transfer-encoding']||'').includes('chunked'))contentLength=parseInt(parsed.headers['content-length']||'',10);
          if(method==='HEAD'||parsed.status===204||parsed.status===304)break;
        }
      }
      if(headerEnd>=0 && contentLength>=0 && buf.length>=headerEnd+4+contentLength)break;
      if (buf.length > MAX_BODY) break;
    }

    if (h2mode) {
      const r = parseH2Response(buf);
      if (r.error) throw new Error('反代 h2 ' + r.error);
      if (!r.status) throw new Error('反代 h2 没给出状态: ' + dec.decode(buf.slice(0, 80)));
      return { status: r.status, headers: r.headers, body: r.body, via: 'h2' };
    }

    if (headerEnd < 0) throw new Error('反代没回 HTTP 头: ' + dec.decode(buf).slice(0, 100));
    const { status, headers: rh } = parseHead(dec.decode(buf.slice(0, headerEnd)));
    let raw = buf.slice(headerEnd + 4);
    if ((rh['transfer-encoding'] || '').includes('chunked')) raw = dechunk(raw);
    const cl = parseInt(rh['content-length'] || '', 10);
    if (Number.isFinite(cl) && cl >= 0 && raw.length > cl) raw = raw.slice(0, cl);
    return { status, headers: rh, body: raw, via: 'http/1.1' };
  } finally {
    signal?.removeEventListener('abort',onAbort);
    try { if (stream) stream.destroy(); else sock?.close(); } catch {}
  }
}

/**
 * 经反代取一个 URL。返回真的 Response（url 属性指向最终 URL，与 fetch 的语义对齐），
 * 调用方可以当成 fetch 的返回值直接用。
 * relay 形如 '1.2.3.4:2096'。
 */
export async function relayFetch(relay, urlStr, { method = 'GET', headers = {}, body = null, redirect = 'follow', tls = null, signal = null } = {}) {
  let target = new URL(urlStr);
  let m = method;
  let b = body;
  for (let hop = 0; ; hop++) {
    const r = await once(relay, target, m, headers, b, tls, signal);
    const loc = r.headers.location;
    if (redirect === 'follow' && r.status >= 300 && r.status < 400 && loc && hop < MAX_REDIRECTS) {
      target = new URL(loc, target);
      // 3xx 之后按浏览器语义退化成 GET，且不再带 body
      if (m !== 'GET' && m !== 'HEAD') m = 'GET';
      b = null;
      continue;
    }
    const resp = new Response(r.body.length ? r.body : null, { status: r.status, headers: r.headers });
    // Response.url 是原型上的只读 getter，在实例上定义同名属性即可遮蔽
    Object.defineProperty(resp, 'url', { value: target.toString(), configurable: true });
    return resp;
  }
}
