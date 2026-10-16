# Explicit proxy routing and an interactive browser session

This change prioritizes a working small browser: navigate, load CSS and JavaScript,
read layout, click, update the page, navigate again and capture the current page.
The default CDP/HTTP viewport is 1024 by 768; larger sizes are opt-in.

## Select the route before navigation

Direct access is the default. There is no automatic relay fallback. A selected
proxy applies to documents, redirects, scripts, page fetches, CSS, fonts and images.
Proxy failure returns an error and never triggers a direct request.

The default proxy configuration wraps this project's existing self-implemented
SNI/TLS relay. An IP and port identify the relay endpoint; they do not imply that
the endpoint speaks HTTP CONNECT or SOCKS5.

Pass an endpoint in the CDP WebSocket URL:

```js
const endpoint = new URL('wss://quickjsbrowser.berry55.workers.dev/cdp');
endpoint.searchParams.set('key', key);
endpoint.searchParams.set('s', crypto.randomUUID());
endpoint.searchParams.set('proxy', '203.0.113.10:2096');
```

Or send this project-specific CDP extension before navigation:

```js
await client.send('Browser.setProxy', {ip: '203.0.113.10', port: 2096});
```

`?proxy_ip=203.0.113.10&proxy_port=2096` is also supported. `sni://host:port` is
an explicit spelling of the same transport. The selected endpoint is shared by
documents, redirects, scripts, page fetches, CSS, fonts and images. `proxy=direct`
explicitly selects direct access; omitting a proxy on a new session is also direct.

The interface has proxy semantics while transport remains our own TCP + TLS/SNI +
HTTP implementation. This legacy TLS path does not provide complete browser
certificate authentication. Separately, explicitly specifying `type: "http"` or
`type: "socks5"` selects standard protocol support. These are opt-in alternatives;
they are not required of a custom relay. HTTPS proxy endpoints themselves are not
implemented. Native tunnel TLS for those alternatives still needs separate edge
validation with a compatible endpoint.

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
that the Cloudflare edge handles tunnel TLS identically. The actual Worker interaction and explicit custom-relay tests are recorded in
[the validation report](session-validation-2026-10-16.md). Standard-protocol tunnel
TLS has not been claimed as verified on the edge.

This remains a browser subset. Client/offset box metrics and inline client-rect
fragments are simplified. Observers, iframe contexts, forms, keyboard automation,
full cookie/storage policies and async/defer semantics remain incomplete. Large
Discourse applications are not claimed to work.

The script policy now permits 32 MiB of total source memory, 256 requests, a 30 second
network window, 30,000 QuickJS interrupt callbacks, 256 tasks and 32 settling rounds.
One-shot timers up to 1 second can settle during startup. Longer timers/intervals
are still reported as unsupported. Document network timeout is 10 seconds. These are
project policies, separate from the platform CPU limit.
