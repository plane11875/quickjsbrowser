# Explicit proxy routing and an interactive browser session

This change prioritizes a working small browser: navigate, load CSS and JavaScript,
read layout, click, update the page, navigate again and capture the current page.
The default CDP/HTTP viewport is 1024 by 768; larger sizes are opt-in.

## Select the route before navigation

Direct access is the default. There is no automatic relay fallback. A selected
proxy applies to documents, redirects, scripts, page fetches, CSS, fonts and images.
Proxy failure returns an error and never triggers a direct request.

Pass a URL-encoded proxy URL when opening the CDP WebSocket:

```js
const endpoint = new URL('wss://quickjsbrowser.berry55.workers.dev/cdp');
endpoint.searchParams.set('key', key);
endpoint.searchParams.set('s', crypto.randomUUID());
endpoint.searchParams.set('proxy', 'http://203.0.113.10:8080');
```

Or send the project-specific CDP extension before navigation:

```js
await client.send('Browser.setProxy', {
  proxy: {type: 'socks5', host: '203.0.113.10', port: 1080,
          username: 'user', password: 'password'}
});
```

Supported proxy protocols are HTTP CONNECT, SOCKS5 with remote DNS and the existing
SNI relay (`sni://host:port`). Authentication is optional for HTTP/SOCKS5. HTTPS
websites through HTTP/SOCKS5 use `Socket.startTls({expectedServerHostname})` and
runtime certificate validation. TLS-encrypted proxy endpoints (`https://proxy`)
are not implemented. The explicit SNI mode retains the old user-space TLS path,
which does not provide complete browser certificate authentication.

Prefer the command for credentials so they are not in a connection URL. Public
state reports protocol, host, port and an authentication flag, never passwords.
Use a new session ID to change proxy after navigation. Reconnecting retains the
route while the session remains in memory; process eviction still loses state.

## DOM and rendering

A synchronous QuickJS host call connects `getComputedStyle`, bounding rectangles,
basic dimension queries and `elementFromPoint` to Blitz style/layout. Stable node
IDs are attached to a cloned render tree, not to the page DOM. HTML/resource
changes invalidate the cached renderer document. Queries without changes reuse it.

Resource discovery resolves layout without painting intermediate images. Final
painting reuses the layout document. Screenshots reuse session assets, and switching
sessions switches the renderer resource table. The old document is released before
building a replacement to reduce peak memory.

`Input.dispatchMouseEvent` hit-tests coordinates and dispatches mouse events,
button callbacks and normal anchor activation, including `preventDefault`.
`HTMLElement.click()` also activates links. Script/timer navigation loads a new
page and emits CDP lifecycle events. Old timers and fetch results cannot mutate
the replacement page. Unsupported Input/DOM commands return errors.

## Validation and remaining work

`npm test` includes an actual WebSocket CDP client, an HTTP CONNECT proxy, and a
fixture serving HTML, external CSS/JS and a second page. It checks real geometry,
DOM and PNG changes after coordinate clicks, link navigation and return, event
cancellation, asynchronous navigation, old-timer isolation, proxy authentication,
and no direct fallback. SOCKS5 tests cover fragmented negotiation and authentication.
Existing native/module/navigation and float/CSS renderer suites also run.

An additional Codespace integration check accessed https://example.com through an
HTTP CONNECT proxy using certificate-verified native TLS. These checks do not prove
that the Cloudflare edge handles tunnel TLS identically. Deployment credentials
are required for the separate on-Worker validation; do not label local results as
production results.

This remains a browser subset. Client/offset box metrics and inline client-rect
fragments are simplified. Observers, iframe contexts, forms, keyboard automation,
full cookie/storage policies and async/defer semantics remain incomplete. Large
Discourse applications are not claimed to work.

The script policy now permits 512 KiB per source, 2 MiB total, 32 requests, a 5 second
network window, 1,000 QuickJS interrupt callbacks, 256 tasks and 32 settling rounds.
One-shot timers up to 1 second can settle during startup. Longer timers/intervals
still decline bounded startup. Document network timeout is 10 seconds. These are
project policies, separate from the platform CPU limit.
