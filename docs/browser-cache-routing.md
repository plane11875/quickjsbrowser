# Session resources, mixed SNI routing and real application execution

A selected SNI endpoint remains the first route. A failed GET/HEAD can use native
fetch; successful direct origins are remembered for five minutes. Routing is
reconsidered for every redirect destination. Cancellation, platform subrequest
exhaustion and non-idempotent requests are not replayed. Explicit HTTP CONNECT
and SOCKS5 configurations remain strict. `/state` exposes route counts and
`/log` records the attempted relay, fallback reason and final response route.

The DO owns a 32 MiB / 512-entry LRU cache of complete, fresh GET responses.
Headers partition identities and negotiated variants; complete URLs preserve
queries. Referer is omitted from the key only when the response does not vary on
it. No-store/no-cache, Set-Cookie, Vary: *, expired responses and redirect aliases
are not retained. Concurrent eligible loads share a transfer. Failures do not
become permanent negative entries. Cache hits occur before consuming a network
batch allowance. Bytes, MIME and response URL are retained in memory only.

Each document gets a new QuickJS runtime and DOM. The same WASM instance's linear
memory is reused within that DO, after freeing the old runtime. This prevents
old globals, module instances, DOM effects and timers from leaking into the next
document without allocating a second large linear memory. Browser.close clears
the browser session; transport disconnection alone does not. Restart/reset or
platform eviction loses the memory cache. No KV or persistent cache was added.

Static imports are prepared before execution. A lexical rewrite routes runtime
`import(expression)` through the host resolver, then invokes native import after
its dependency graph is ready. Module namespaces and side effects remain native
QuickJS semantics. Resource-batch continuation retains pending import promises
and the live document, without rerunning initial scripts. Unused dynamic modules
are not eagerly fetched. Compiled modules release their transport source copies;
the host drops decoded source references once registration/execution permits it.

Browser startup additions include Stylo-backed CSS.supports, CSS.escape,
referrer, DOMParser HTML fragment normalization, document creation/adoption,
Window identity, document focus, Headers, asynchronous XHR and MessageChannel,
geometry-backed resize/intersection observers and session navigation history.
Long timers are scheduled and are cancelled with old document work. This is
still a browser/CDP subset: general async/defer ordering, iframe contexts,
transferable ports and complete CSSOM remain outside the tested behavior.

Geometry input keeps the actual DOM intact. A render projection excludes script
and JSON bodies and adds node identifiers only in serialized input, with no DOM
cloning or observable attribute mutations. Bootstrap data remains readable by
the application. CSS, images, fonts and floats remain enabled.

## CPU and memory investigation

Fixed-resource replay separated QuickJS calls, microtasks and host layout.
A V8/WASM CPU profile attributed about seven seconds of one replay to
`get_line_col_cached` and `get_line_col`: nested functions revisit positions
backwards across long minified lines. A bounded source-position index replaces
those repeated scans while keeping debug information. Regression fixtures retain
upstream stack lines/columns for UTF-8, nested/minified functions and an exact
256 KiB boundary. The build applies this patch to the pinned upstream source.

The WASI build also inherited Emscripten's allocation-size stub, which returns
zero. QuickJS consequently counted allocation headers rather than actual bytes,
affecting GC thresholds and memory limits. The build now uses WASI libc's real
malloc_usable_size. Tests verify backing-store accounting, release, rejection at
a native allocation limit and recovery. `/state.engineMemory` separates native
allocation accounting from WASM's non-shrinking linear memory size.

-O3 was evaluated against -Oz. Whole-page local results overlapped rather than
showing a reliable twofold improvement, so the default remains -Oz with an
explicit optimization override. Local Node CPU/profile figures are not Worker
CPU measurements. The real Worker acceptance report records platform CPU by
individual Durable Object and keeps cold/hot phases separate in time.

## Reproduce

Run `npm test` before deployment. Rebuild C with `bash engine/build.sh` and Rust
with `npm run build:renderer` after corresponding changes. Use the installed
Wrangler and a private complete production configuration.

For live verification, provide QJSB_KEY and QJSB_RELAY_IP privately, then run:

```sh
QJSB_TEST_OUTPUT=.cache/real-browser node test/real-site-cache-remote.mjs
```

The runner requires real Discourse posts, cooked body text, header and removal
of the splash screen. It uses one DO for A → B → A, records cache/network deltas,
activates a real second-topic anchor, returns through CDP history and captures
actual screenshots. QJSB_PHASE_IDLE_MS=65000 separates platform CPU reporting
periods; this idle time is excluded from per-navigation wall measurements.
Raw session identifiers, logs and source snapshots stay outside Git.

## Acceptance status

The complete live website test failed on deployed version
`deca889d-d769-4666-99a5-34d79756b23c`: the cold load exceeded platform memory
before A/B/A or interaction could complete. Observed cumulative CPU was
10.709972 seconds; it is not a successful complete-page cost. The platform
reported two memory-limit events and no CPU-limit events. Real hot-navigation
CPU/cache/screenshot acceptance remains outstanding. The PR stays draft.

A separate real Worker network probe passed for the Linux.do document (selected
SNI route) and Stripe/Google scripts (native direct fallback). Counters were
relay=3, direct=4, fallback=2; repeating Stripe avoided another relay attempt.
This checks resource reachability only, not application execution. Reproduce
with private QJSB_KEY/QJSB_RELAY_IP and `node test/route-fallback-remote.mjs`.
