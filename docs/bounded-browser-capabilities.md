# Browser capabilities within a performance budget

The browser now executes small page applications within explicit limits. It does not attempt to boot an arbitrarily large application and wait for the Worker CPU limit.

## Execution and result metadata

- HTTP `POST /s/:sid/shot` with `js:false` uses static rendering. `js:true` explicitly requests bounded page JavaScript, including on linux.do.
- CDP keeps the site's existing default policy. linux.do remains static by default. `Emulation.setScriptExecutionDisabled({value:false})` explicitly requests bounded scripts; `value:true` disables them.
- `GET /s/:sid/state` includes `page`: mode, execution status, rendering classification, consumed resources and structured errors. PNG responses expose `x-browser-status` and compact `x-js-info` headers.
- `rendering: fallback` explicitly identifies the known noscript fallback document. `scripted` means the bounded script pipeline completed, not a claim of Chrome-equivalent rendering or a guarantee that an arbitrary framework fully hydrated.
- If page code has run, a script failure, unsupported capability or budget violation discards the VM and rebuilds the original DOM and trusted automation scripts. A preflight refusal keeps the untouched DOM without rebuilding Wasm or repeating automation side effects. Partially executed application DOM and pending jobs are not retained.

## Budgets

| Work | Limit |
| --- | --- |
| Main document network, including relay and body | 2,500 ms |
| Main document input | 1 MiB; oversized documents fail explicitly |
| Page-script network window | 900 ms shared, with abort signals |
| Page-script/fetch requests | 8 |
| Individual executable source | 48 KiB |
| Total executable source | 128 KiB |
| Module graph | depth 8; at most 32 specifiers per source |
| Script elements | 32 |
| Script/Promise instruction budget | 150 QuickJS interrupt-handler calls, shared across the page |
| Page task settling | 64 tasks, 12 rounds, 128 microtasks per drain |
| Timers | bounded one-shot timers up to 32 ms; longer timers/intervals decline the attempt |
| Render-resource network window | 2,000 ms shared |

Known over-budget script manifests are declined before making any script requests. Response size is checked before reading advertised large bodies and while streaming unadvertised ones. Module compilation has an additional native source-size guard. A JavaScript timeout is not presented as a way to preempt synchronous Wasm compilation: the size checks happen before compilation, and QuickJS's interrupt handler bounds interpreted execution. These are performance policies, not a universal wall-clock guarantee for every native parser, layout operation or upstream condition. Network deadline failures return a clear error rather than waiting ten seconds.

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

Blitz layout results are not yet connected back to the script DOM. Page use of the current getComputedStyle shim or the placeholder ResizeObserver/IntersectionObserver is reported as an unsupported capability and declines bounded execution rather than silently claiming correctness. Computed dynamic imports that were not prefetched, long-lived application timers, general async/defer semantics, iframe browsing contexts and full CSSOM integration remain incomplete.

The multi-megabyte Discourse application still exceeds this deployment's budget. linux.do's noscript view remains a documented fallback, not the full sidebar/avatar/timeline interface. Raising budgets to force that bundle through would reintroduce the expensive path this policy is designed to avoid.

`test/capabilities-test.mjs` covers the implemented behavior and the oversized-source, error, runaway-job and stalled-network boundaries. `test/fixtures/capability-app.html` is a small actual module application used for deployed validation.
