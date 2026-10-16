// fingerprint.js — 伪装 persona 的**单一事实源**。
//
// 为什么单独立文件：同一份身份必须同时喂给四处，各写一份必然漂移——
//   1. session.js / cdp.js 的出站 HTTP 头（Sec-CH-UA / Accept-Language / UA）
//   2. prelude.js 的 navigator（userAgent / platform / languages / userAgentData）
//   3. index.js 的 /json/version 发现面
//   4. CDP 面里上报的 UA
// 反爬检测的核心不是「有没有某个头」，而是**跨接口自相矛盾**：请求头说 macOS/Chrome 151、
// JS 里 platform 说 Linux、navigator.userAgentData.brands 与 sec-ch-ua 对不上，
// 这类不一致比缺头更容易被打分。参考实现（Chromix，C++ 层）的 P0 校验就是这个：
// 见其 sdk/python/chromix/_device_headers.py header_errors()——「HTTP Client Hints 必须
// 与同一上下文的 JS 身份一致」，一字不差地拿 JS 值逐字段比对 HTTP 头。
//
// 所有数值来源：本机真实 Chrome 154 的实测（DevTools 请求头 + 页面内 evaluate），
// 以及 Chromium 源码 components/embedder_support/user_agent_utils.cc 的
// GetGreasedUserAgentBrandVersion / GenerateBrandVersionList。

// ---- persona 常量 ----
// 版本号必须和 TLS 指纹对齐：src/net/chrome-hello.js 那份 ClientHello 就是 Chrome 146 的
// 真包（curl_cffi 的 chrome146 档位抓的）。UA 报 151 而 TLS 是 146 的扩展布局，
// 属于典型的跨层自相矛盾——比报低版本还容易被挑出来。
export const CHROME_MAJOR = 146;
export const CHROME_FULL = '146.0.0.0';
// macOS 平台上 Chrome 一律报 10_15_7（与真实内核版本无关），platform 报 MacIntel，
// UA-CH 的 platform 报 "macOS"。三者必须成套。
export const OS_IN_UA = 'Macintosh; Intel Mac OS X 10_15_7';
export const NAVIGATOR_PLATFORM = 'MacIntel';
export const CH_PLATFORM = 'macOS';

export const BROWSER_UA =
  `Mozilla/5.0 (${OS_IN_UA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;

// 与 navigator.languages 必须一致（只允许 q 值/子标签差异），见 _device_headers.py
export const LANGUAGES = ['zh-CN', 'zh', 'en'];
export const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

// 硬件面：与 navigator.hardwareConcurrency / deviceMemory 同源，便于一处改全处改。
// deviceMemory 真实 Chrome 上限就是 8（超过一律报 8）。
export const HARDWARE_CONCURRENCY = 8;
export const DEVICE_MEMORY = 8;

// ---- Chromium 的 GREASE 品牌算法（源码级复刻，见文件头注释）----
// 用途：sec-ch-ua 里那条 "Not=A?Brand";v="99" 是 Chromium 按 major 版本号算出来的，
// 不是随手编的字符串。编错了等于自报「我不是 Chrome」。算法：
//   greasey_brand = "Not" + chars[seed%11] + "A" + chars[(seed+1)%11] + "Brand"
//   greasey_ver   = versions[seed%3]           → 8 / 99 / 24
//   列表 = [greasey, Chromium, Google Chrome] 再按 orders[seed%6] 洗牌
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
const BRAND_ORDERS = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/**
 * 按 major 版本号算出 Chrome 的 UA-CH 品牌列表（sec-ch-ua 的顺序即此顺序）。
 * @param {number} seed 浏览器 major 版本号
 * @returns {{brand: string, version: string}[]}
 */
export function chromiumBrands(seed) {
  const greasey = {
    brand: `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`,
    version: GREASE_VERSIONS[seed % GREASE_VERSIONS.length],
  };
  // 有品牌（正式 Chrome）时是 3 条：GREASE / Chromium / Google Chrome
  const list = [greasey, { brand: 'Chromium', version: String(seed) }, { brand: 'Google Chrome', version: String(seed) }];
  const order = BRAND_ORDERS[seed % BRAND_ORDERS.length];
  const out = new Array(list.length);
  for (let i = 0; i < order.length; i++) out[order[i]] = list[i];
  return out;
}

/** navigator.userAgentData.brands 的 JS 形态（与 sec-ch-ua 同源，二者必须一致） */
export const UA_DATA_BRANDS = chromiumBrands(CHROME_MAJOR);

/** sec-ch-ua 头的字符串形态 */
export const SEC_CH_UA = UA_DATA_BRANDS.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');

// ---- 按资源类型的请求头（真实 Chrome 实测值，逐类型不同，别一套头打天下）----
// 实测方法：本地起 http 回显服务器 → 真 Chrome 打开带 <link>/<script>/<img>/fetch 的页面
// → 逐请求 dump 头；h2 专有的 Priority / sec-ch-ua 另用 DevTools 请求面板核对。
const ACCEPT = {
  document: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  script: '*/*',
  style: 'text/css,*/*;q=0.1',
  image: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  font: '*/*',
  // fetch/XHR：Chrome 默认 */*（实测），带 content-type 时仍是 */*
  xhr: '*/*',
};
const DEST = { document: 'document', script: 'script', style: 'style', image: 'image', font: 'font', xhr: 'empty' };
// Priority（h2）：实测 document = "u=0, i"，脚本 = "u=1"；图片是最低优先级
const PRIORITY = { document: 'u=0, i', script: 'u=1', style: 'u=1', font: 'u=1', xhr: 'u=1', image: 'u=2, i' };

/** 无 PSL：用「最后两级标签」近似 eTLD+1 判 same-site（example.co.uk 会判错，可接受） */
function sameSiteApprox(a, b) {
  const host = (h) => {
    const p = String(h || '').split('.');
    return p.length <= 2 ? p.join('.') : p.slice(-2).join('.');
  };
  return host(a) === host(b) && host(a) !== '';
}

/** 按默认 Referrer-Policy: strict-origin-when-cross-origin 生成 Referer 值 */
function refererValueFor(from, to) {
  if (!from || !to) return '';
  try {
    const a = new URL(from), b = new URL(to);
    if (a.origin === b.origin) {
      a.hash = '';
      a.username = ''; a.password = '';
      return a.href;
    }
    // 跨源只发**发起方**的 origin（v1 曾错写成目标 origin，被 session-test A10d 抓到）
    return a.origin + '/';
  } catch { return ''; }
}

/**
 * 生成一次出站请求应带的浏览器头。返回**新对象**（调用方可再覆盖单项）。
 *
 * @param {object} o
 * @param {'document'|'script'|'style'|'image'|'font'|'xhr'} o.type  请求类型（决定 Accept/Dest/Priority）
 * @param {string} [o.url]       目标 URL（用于判 same-origin / cross-site）
 * @param {string} [o.referer]   发起方文档 URL（同源发全 URL，跨源只发 origin）
 * @param {'navigate'|'cors'|'no-cors'|'same-origin'} [o.mode] 覆盖 Sec-Fetch-Mode
 * @param {boolean} [o.origin]   是否附 Origin 头（CORS 跨源请求 Chrome 才发）
 * @param {string} [o.accept]    覆盖 Accept
 */
export function requestHeaders(o = {}) {
  const type = ACCEPT[o.type] ? o.type : 'xhr';
  const url = o.url || '';
  const referer = o.referer || '';
  const h = {
    // Chrome 的线上顺序；注意 CF 边缘会把顺序重排（实测到源站变字母序），此顺序仅为可读性
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${CH_PLATFORM}"`,
  };
  if (type === 'document') h['Upgrade-Insecure-Requests'] = '1';
  h['User-Agent'] = BROWSER_UA;
  h.Accept = o.accept || ACCEPT[type];
  // Sec-Fetch-Site：有 referer 才是同源/跨源，顶层导航是 none
  let site = 'none';
  if (referer && url) {
    try {
      const a = new URL(referer), b = new URL(url);
      site = a.origin === b.origin ? 'same-origin' : (sameSiteApprox(a.hostname, b.hostname) ? 'same-site' : 'cross-site');
    } catch { site = 'cross-site'; }
  }
  h['Sec-Fetch-Site'] = site;
  h['Sec-Fetch-Mode'] = o.mode || (type === 'document' ? 'navigate' : 'cors');
  h['Sec-Fetch-Dest'] = DEST[type];
  if (type === 'document') h['Sec-Fetch-User'] = '?1';
  const ref = refererValueFor(referer, url);
  if (ref) h.Referer = ref;
  // Origin 只在 CORS 模式且跨源时发（实测：同源 fetch 不带 Origin，跨源 module script 带）
  if (o.origin && site !== 'same-origin') {
    try { h.Origin = new URL(referer || url).origin; } catch { /* 忽略 */ }
  }
  h['Accept-Language'] = ACCEPT_LANGUAGE;
  // 导航请求实测带 Cache-Control: max-age=0；子资源不带
  if (type === 'document') h['Cache-Control'] = 'max-age=0';
  h.Priority = PRIORITY[type];
  // Accept-Encoding 由 CF 边缘强制覆盖为 "gzip, br"（实测），设了也没用，故意不设：
  // 留着眼睛看得见——这是本项目唯一无法伪装的请求头。
  return h;
}

/** 从 URL 扩展名/资源类型猜请求类型（截图阶段的资源补抓用） */
export function guessType(url, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  if (/^(text\/css)/.test(ct)) return 'style';
  if (/^image\//.test(ct)) return 'image';
  if (/font|woff/.test(ct)) return 'font';
  if (/javascript|ecmascript/.test(ct)) return 'script';
  if (/^text\/html/.test(ct)) return 'document';
  const path = String(url).split(/[?#]/)[0].toLowerCase();
  if (/\.(css)$/.test(path)) return 'style';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(path)) return 'image';
  if (/\.(woff2?|ttf|otf|eot)$/.test(path)) return 'font';
  if (/\.(m?js|jsx|ts)$/.test(path)) return 'script';
  if (/\.(html?|php|aspx?)$/.test(path) || path.endsWith('/')) return 'document';
  return 'xhr';
}
