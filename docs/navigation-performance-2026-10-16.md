# linux.do navigation performance, 2026-10-16

CDP navigation for `https://linux.do/t/topic/3029893` dropped from 14.592 seconds to 0.548–0.863 seconds. The screenshots before and after have identical PNG bytes. Deployed Worker version: `c021428b-8849-4bc6-9ffa-17c1f32939cb`.

## Cause and measurements

The HTTP screenshot route already applied the linux.do policy that disables page JavaScript. CDP bypassed that policy and called the full page-script pipeline, downloading classic scripts and module dependencies and scheduling module evaluation in QuickJS/WASM. Stylesheet discovery and resource loading happen later, in `paint()`, so the navigation delay cannot be attributed to that CSS loading phase.

A Codespace benchmark used the previously captured original HTML and cached script responses. Cache replay excludes outbound network waiting while still exercising the original script pipeline. Timers use Node's monotonic `performance.now()`, rather than Workers' frozen synchronous clock.

| Old pipeline, one replay | Elapsed |
| --- | ---: |
| Whole pipeline | 7,112 ms |
| `QjsEngine.drainJobs()` | 6,566 ms |
| VM dispatch calls, including DOM construction | 149 ms |
| Classic script execution | 220 ms |
| Module source registration | 19 ms |
| Import-specifier scans | 11 ms |
| DOM serialization | 30 ms |

A separate replay attributed 6,247 ms to the job drain following the import of `https://cdn3.ldstatic.com/assets/br/discourse-e3m83dzf.digested.js` (3,825,007 source characters). The locale import accounted for 47 ms. This identifies the costly module-loading/evaluation task; it does not claim to split native QuickJS compilation from JavaScript execution inside that task. This benchmark is separate from the production CPU measurements below.

## Changes

- Apply the existing site policy inside the shared page-script pipeline, so CDP also skips linux.do page scripts. The full DOM, CSS, CDP evaluate operations and injected automation scripts remain available. This is an intentional behavior change for CDP on that site; it is not a claim that its full Discourse application now runs in the VM.
- Avoid serializing the live DOM at the end of CDP navigation. CaptureScreenshot serializes it when needed.
- Fetch independent classic scripts with bounded concurrency on sites where page scripts remain enabled. Execute them in document order; download duplicate URLs once.
- Connect the existing render-resource filter to the fetch loop. Stylesheets, fonts and images remain eligible; unused script preloads and tracking resources are excluded. This is not the main source of the measured speedup.

No CSS, floats or DOM content were removed to achieve these results. The renderer WASM is unchanged from the earlier float-layout repair.

## Production comparison

Each run used a fresh session on the same deployed Worker hostname. Client times below come from the Codespace. The baseline immediately preceded deployment.

| Run | Navigate | CaptureScreenshot | PNG bytes | Platform main-call CPU |
| --- | ---: | ---: | ---: | ---: |
| Before | 14,592 ms | 1,187 ms | 106,453 | 13,774 ms |
| After 1 | 749 ms | 911 ms | 106,453 | 1,394 ms |
| After 2 | 863 ms | 945 ms | 106,453 | 1,415 ms |
| After 3 | 548 ms | 738 ms | 106,453 | 1,153 ms |

Platform CPU records cover the main Durable Object call carrying navigation and screenshot work; they are not screenshot-only CPU measurements. All listed calls had outcome `ok`, with no CPU-limit reset.

All four PNGs have SHA-256 `82b0cef96dab419bfd6556894526cbeccf8fc54682e41034bd67ee7e491e776a`. The previous screenshot is in [the float repair validation](validation-2026-10-16.md).

Additional deployed CDP checks passed: example.com (44 ms navigation, 360 ms capture) and the inline-float regression (19 ms navigation, 222 ms capture).

## Direct HTTP screenshots and remaining network limitation

Three further direct HTTP screenshot requests, with page JavaScript disabled, produced two valid PNGs in 2.694 and 6.313 seconds. The third returned an error: direct origin fetch was challenged with 403 and the relay received 429. It did not reach rendering or hit the CPU limit. These HTTP results are not reported as three passing screenshot tests. Platform records for the two successful HTTP calls show 1,562 ms CPU / 1,956 ms wall and 779 ms CPU / 5,460 ms wall respectively. The rejected call used 26 ms CPU / 149 ms wall. In particular, the slower successful call spends most of its wall time outside CPU execution. The remaining variable delay/access failure involves the upstream fetch/relay path; this change does not resolve upstream anti-bot challenges or rate limiting.

## Local validation

`npm test` passed all 129 existing assertions, three new navigation/resource regression groups, and the six renderer cases plus float/CSS placement checks. The new tests verify that CDP site policy preserves the DOM, CSS links, early automation scripts and lifecycle events; concurrent script fetching preserves execution order and de-duplicates downloads; and rendering still fetches CSS while excluding script preloads.
