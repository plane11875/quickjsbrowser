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
The existing linux.do default script policy is unchanged; explicitly enabling JS
still encounters independent bundle-size and compatibility checks.

Validation: the local integration test loads 45 stylesheets and 43 scripts in
40/40/8 batches, checks one fetch per URL, exactly-once ordered execution, retained
engine and geometry, no premature load event, mixed HTTP/CDP continuation,
concurrent continuation, module dependency suspension and invalid IDs. The real
Worker regression repeats the 88-resource flow on one CDP WebSocket.
