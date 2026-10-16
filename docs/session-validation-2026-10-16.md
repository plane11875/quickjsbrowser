# Interactive CDP validation — 2026-10-16

Branch: `browser-session-flow`. This is Codespace validation, not a production deployment.

- Both QuickJS C/WASM and Rust renderer WASM rebuilt successfully.
- Final `npm test` exit code: 0. All nine local suites and six renderer cases passed, including float direction and external CSS assertions.
- An actual WebSocket CDP connection loaded HTML, CSS and JS through an HTTP CONNECT proxy with authentication.
- Computed CSS color/width, viewport-relative resize and synchronous layout reads matched the fixture.
- Coordinate clicks changed DOM, geometry and PNG output; ordinary links navigated and returned.
- Cancellation, timer navigation without an extra command, old-document timer isolation and relative page fetches passed.
- Proxy failure made zero direct requests. SOCKS5 fragmented negotiation and authentication passed.
- A separate real HTTPS example.com request through HTTP CONNECT passed using native TLS and certificate validation in Node's socket shim.

The public Worker was not updated: the old temporary deployment credential file no longer exists. Native tunnel TLS and proxy reachability still require Cloudflare-edge validation with deployment credentials and an externally reachable proxy. Full Discourse, Puppeteer selector-based clicking and complete browser compatibility are not claimed.

## Captured fixture images

Before clicking:

![Before click](images/session-before.png)

After clicking the change button (red 120px box becomes a green 240px box):

![After click](images/session-after-click.png)

After clicking the navigation link:

![Next page](images/session-next-page.png)
