# In-memory resource batches

A document load now has an ID and a `pending`, `complete`, or `failed` state.
The Durable Object retains its DOM, engine, downloaded renderer resources,
prepared script sources and module graph in memory. It uses no persistent storage.

`Page.navigate({url, resourceBatch:40})` downloads at most 40 resource requests
in its first batch (default 32). Read the returned `loading` object, or call
`Browser.getLoadingState`. While it is pending, call:

```js
let loading = (await cdp.send('Page.navigate', {url, resourceBatch:40})).loading;
while (loading.status === 'pending') {
  loading = await cdp.send('Browser.continueLoading', {id:loading.id, requests:40});
}
if (loading.status === 'failed') throw new Error(JSON.stringify(loading.page.errors));
```

The caller controls each batch; no background downloading or automatic reload is
scheduled. `remainingResources` counts currently discovered renderer URLs; CSS
imports can discover more later. `cachedScripts` and `remainingScripts` count
script elements whose sources are prepared, not all transitive module URLs.

An authenticated HTTP alternative is
`POST /s/<same-session-id>/continue?key=<key>` with `{id,requests:40}`.
It returns the same loading object and can be mixed with CDP commands.
HTTP requests and commands from all CDP connections serialize within the session.

Stylesheets, images and fonts load first, then script sources and module
preparation. Scripts execute only after preparation completes, once per document.
Batch exhaustion and platform subrequest exhaustion suspend preparation rather
than rolling back the page. Only terminal completion emits the load lifecycle
events; screenshots of pending loads show partial content. A completed continuation
is idempotent. New navigation or reset invalidates old IDs. Eviction or deployment
loses memory: an old ID fails explicitly and the caller must navigate again.

The batch size is an application request budget, not an exact Cloudflare
subrequest counter: redirects and transport work can consume additional platform
requests. The smaller default reserves headroom. Platform quota errors suspend
preparation; the next incoming command/request supplies the next invocation.
Source size, execution, module-depth, memory and network deadlines remain separate
limits. Batch loading does not implement missing Web APIs or bypass script errors.
Page JavaScript now runs by default on linux.do too; the old site-specific disable policy is removed. Source memory and API compatibility checks remain independent.

Validation: the local integration test loads 45 stylesheets and 43 scripts in
40/40/8 batches, checks one fetch per URL, exactly-once ordered execution, retained
engine and geometry, no premature load event, mixed HTTP/CDP continuation,
concurrent continuation, module dependency suspension and invalid IDs. The real
Worker regression repeats the 88-resource flow on one CDP WebSocket.

## Deployed verification, 2026-10-16

Worker version `1bad7eb5-3c64-4a02-80e2-6979992ee056`, code `9ecba45`:
all six deployed scenarios passed with fresh session names. The 88-resource case
used one WebSocket and returned these measured progress snapshots:

| Batch | Renderer resources cached | Scripts prepared | Status |
| --- | ---: | ---: | --- |
| 1 | 40 | 0 | pending/resources |
| 2 | 45 | 35 | pending/scripts |
| 3 | 45 | 43 | complete |

The final DOM reported 43 script runs and a CSS width of 123px. Repeating the
completed continuation left the script count at 43. Existing interactive click,
link navigation, module loading, direct example.com, invalid explicit proxy and
linux.do through the selected SNI relay also passed. That historical linux.do case validated the then-existing static policy, not full Discourse application execution.

Cloudflare documents [subrequests per invocation](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
and [Durable Object CPU limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
CPU reset documentation alone does not establish subrequest behavior; the deployed
88-resource test verifies continuation across messages with this implementation.
