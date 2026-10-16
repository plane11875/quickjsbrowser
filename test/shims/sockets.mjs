// test/shims/sockets.mjs — node 侧的 cloudflare:sockets 替身，只为让本地测试能 import
// session.js（它现在经 src/net/relay.js 用到 connect）。
//
// 本地测试不打真网，也不需要走反代，所以这里只实现 connect 返回的流形状：
// opened / readable / writable / close。startTls 不实现——本地路径不经过它。
import net from 'node:net';
import { Readable, Writable } from 'node:stream';

export function connect(address, _options = {}) {
  const host = typeof address === 'string' ? address.replace(/:\d+$/, '') : address.hostname;
  const port = typeof address === 'string'
    ? (parseInt(address.split(':')[1], 10) || 443)
    : (address.port || 443);

  const sock = net.connect({ host, port });
  const opened = new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  // error 事件没人监听时 node 会抛未捕获异常，挂个空监听兜住
  sock.on('error', () => {});

  return {
    opened,
    readable: Readable.toWeb(sock),
    writable: Writable.toWeb(sock),
    startTls() { throw new Error('startTls: node shim 未实现（本地测试不走这条路）'); },
    close() { try { sock.destroy(); } catch {} },
  };
}
