// Proxy parsing/negotiation. Session routing permits safe SNI-only direct fallback.
const enc = new TextEncoder(), dec = new TextDecoder();
export function normalizeProxy(input) {
  if (input == null || input === '' || input === 'direct') return null;
  let p;
  if (typeof input === 'string') {
    const u = new URL(input.includes('://')?input:'sni://'+input);
    if (!['','/'].includes(u.pathname) || u.search || u.hash) throw new Error('proxy URL must contain only protocol, host and port');
    p = {type:u.protocol.slice(0,-1),host:u.hostname.replace(/^\[|\]$/g,''),port:u.port ? Number(u.port) : u.protocol==='sni:'?443:u.protocol==='socks5:'?1080:80,username:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};
  } else p = {type:input.type || input.protocol || 'sni',host:input.host || input.ip,port:Number(input.port),username:input.username || '',password:input.password || ''};
  p.type = p.type.replace(/:$/,'').toLowerCase();
  if (!['http','socks5','sni'].includes(p.type)) throw new Error('unsupported proxy protocol');
  if (typeof p.host !== 'string' || !p.host || /[\s\/@?#]/.test(p.host)) throw new Error('invalid proxy host');
  if (!Number.isInteger(p.port) || p.port<1 || p.port>65535) throw new Error('invalid proxy port');
  for(const k of ['username','password']) if(typeof p[k]!=='string' || /[\r\n]/.test(p[k])) throw new Error('invalid proxy credentials');
  return Object.freeze(p);
}
export function publicProxy(p) { return p ? {type:p.type,host:p.host,port:p.port,authenticated:!!(p.username || p.password)} : {type:'direct'}; }
export async function negotiateProxy(stream, proxy, target) {
  let pending=new Uint8Array(0);
  const take=async(n)=>{
    while(pending.length<n){const b=await stream.read();if(!b)throw new Error('proxy closed during handshake');const out=new Uint8Array(pending.length+b.length);out.set(pending);out.set(b,pending.length);pending=out;if(pending.length>65536)throw new Error('proxy handshake too large');}
    const out=pending.slice(0,n);pending=pending.slice(n);return out;
  };
  const port=Number(target.port || (target.protocol==='https:'?443:80));
  const hostname=target.hostname.replace(/^\[|\]$/g,'');
  if(proxy.type==='socks5'){
    const auth=!!(proxy.username || proxy.password);
    await stream.write(new Uint8Array([5,1,auth?2:0]));
    const hello=await take(2);if(hello[0]!==5 || hello[1] !== (auth?2:0))throw new Error('SOCKS5 authentication method rejected');
    if(auth){
      const u=enc.encode(proxy.username),p=enc.encode(proxy.password);
      if(!u.length || u.length>255 || p.length>255)throw new Error('SOCKS5 credentials exceed protocol limits');
      const data=new Uint8Array(3+u.length+p.length);data.set([1,u.length]);data.set(u,2);data[2+u.length]=p.length;data.set(p,3+u.length);await stream.write(data);
      const r=await take(2);if(r[0]!==1||r[1]!==0)throw new Error('SOCKS5 authentication failed');
    }
    const name=enc.encode(hostname);if(name.length>255)throw new Error('SOCKS5 hostname too long');
    const req=new Uint8Array(7+name.length);req.set([5,1,0,3,name.length]);req.set(name,5);new DataView(req.buffer).setUint16(5+name.length,port);await stream.write(req);
    const r=await take(4);if(r[0]!==5||r[1]!==0||r[2]!==0)throw new Error('SOCKS5 CONNECT rejected ('+r[1]+')');
    if(r[3]===1)await take(6);else if(r[3]===4)await take(18);else if(r[3]===3){const len=await take(1);await take(len[0]+2);}else throw new Error('invalid SOCKS5 address type');
  }else if(proxy.type==='http'){
    const authority=(hostname.includes(':')?'['+hostname+']':hostname)+':'+port;
    let auth='';if(proxy.username || proxy.password){let bin='';for(const b of enc.encode(proxy.username+':'+proxy.password))bin+=String.fromCharCode(b);auth='Proxy-Authorization: Basic '+btoa(bin)+'\r\n';}
    await stream.write(enc.encode('CONNECT '+authority+' HTTP/1.1\r\nHost: '+authority+'\r\n'+auth+'\r\n'));
    const head=[];let state=0;
    while(state!==4){const b=(await take(1))[0];head.push(b);state=b===[13,10,13,10][state]?state+1:b===13?1:0;if(head.length>16384)throw new Error('proxy headers too large');}
    const status=/^HTTP\/1\.[01] (\d{3})/.exec(dec.decode(new Uint8Array(head)));
    if(!status||Number(status[1])<200||Number(status[1])>=300)throw new Error('HTTP proxy CONNECT rejected ('+(status?.[1]||'invalid response')+')');
  }
  return {write:d=>stream.write(d),destroy:()=>stream.destroy(),release(){if(pending.length)throw new Error('unexpected data before TLS upgrade');stream.release();},async read(){if(pending.length){const b=pending;pending=new Uint8Array(0);return b;}return stream.read();}};
}
