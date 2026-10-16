# Browser capabilities within a performance budget

The browser executes page applications with memory and instruction guardrails. Source size alone is not a CPU measurement; real-site CPU must be measured on the deployed Worker.

## Execution and result metadata

- HTTP `POST /s/:sid/shot` with `js:false` uses static rendering. `js:true` explicitly requests bounded page JavaScript, including on linux.do.
- CDP executes scripts by default on every site, including linux.do. `Emulation.setScriptExecutionDisabled({value:true})` explicitly disables them.
- `GET /s/:sid/state` includes `page`: mode, execution status, rendering classification, consumed resources and structured errors. PNG responses expose `x-browser-status` and compact `x-js-info` headers.
- `rendering: fallback` explicitly identifies the known noscript fallback document. `scripted` means the bounded script pipeline completed, not a claim of Chrome-equivalent rendering or a guarantee that an arbitrary framework fully hydrated.
- A failed download or ordinary script exception does not block independent scripts or discard their DOM mutations. Exhausted instruction/settling budgets still replace the VM to drop runaway jobs. Script-enabled loads exclude noscript content and its resources before rendering; failures are reported as partial/uninitialized output rather than silently showing the noscript view.

## Budgets

| Work | Limit |
| --- | --- |
| Main document network, including relay and body | 10,000 ms |
| Main document input | 1 MiB; oversized documents fail explicitly |
| Page-script network window | 30,000 ms per preparation batch, with abort signals |
| Page-script/fetch requests | 256 total; preparation batches default to 32 |
| Individual executable source | bounded by the 32 MiB total source memory allowance |
| Total executable source | 32 MiB |
| Module graph | depth 8; at most 1024 specifiers per source |
| Script elements | 128 |
| Script/Promise instruction budget | 30,000 QuickJS interrupt-handler calls, shared across the page |
| Page task settling | 256 tasks, 32 rounds, 128 microtasks per drain |
| Timers | bounded one-shot timers up to 1,000 ms; longer timers/intervals are reported as unsupported |
| Render-resource network window | 5,000 ms shared |

Known over-budget script manifests are declined before making any script requests. Response size is checked before reading advertised large bodies and while streaming unadvertised ones. Module compilation has an additional native source-size guard. A JavaScript timeout is not presented as a way to preempt synchronous Wasm compilation: the size checks happen before compilation, and QuickJS's interrupt handler bounds interpreted execution. These are performance policies, not a universal wall-clock guarantee for every native parser, layout operation or upstream condition. Network deadline failures return a clear error rather than waiting indefinitely.

The existing CSS, float layout and font rendering stay enabled. Render resource expiry is reported as `resources: limited`, and individual request failures as `resources: partial`; neither is represented as fully loaded.

## Capabilities implemented

- DOM-based script manifest extraction; inert noscript/template descendants are excluded and application/json bootstrap data is preserved.
- Real JavaScript dependency lexing using the CSP-compatible minimal JS build of es-module-lexer, without runtime Wasm compilation or eval in the Worker host.
- Import-map exact/prefix mappings, scoped mappings, blocked entries, document base URLs and prefix-escape rejection.
- One resolver in the host registers exact `(referrer, specifier) -> URL` aliases with the native module loader. Browser bare imports do not become speculative npm/CDN fetches.
- Real linkedom MutationObserver and HTML element constructor identities; document URL/base/cookie accessors, currentScript and readiness transitions.
- Bounded page fetch and short timers; compiled modules and dependency cycles are resolved from the prefetched graph.
- Structured classic/module errors and unhandled Promise rejections, with names, messages, source URLs where available and stacks.

## Deliberate remaining limitations

Blitz style/layout results are now connected synchronously to the script DOM for computed properties, bounding rectangles and coordinate hit testing. See [interactive session design and proxy usage](session-browser-flow.md). ResizeObserver/IntersectionObserver remain unsupported. Box/client-rect fragments are still simplified. Computed dynamic imports that were not prefetched, long-lived application timers, general async/defer semantics, iframe browsing contexts and full CSSOM integration remain incomplete.

Multi-megabyte Discourse sources now reach compilation and execution. Full application compatibility remains unproven: actual real-site results and CPU measurements are recorded in [the linux.do test report](real-site-2999210.md). The old 512 KiB/2 MiB defaults were policy choices, not measured Worker limits.

`test/capabilities-test.mjs` covers the implemented behavior and the oversized-source, error, runaway-job and stalled-network boundaries. `test/fixtures/capability-app.html` is a small actual module application used for deployed validation.
