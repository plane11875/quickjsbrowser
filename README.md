# quickjsbrowser

Cloudflare Workers browser service: QuickJS/WASM executes JavaScript, linkedom supplies the DOM, and Blitz renders screenshots. Includes an HTTP screenshot API and a subset of CDP.

Development and builds run in GitHub Codespaces. Credentials belong in private environment variables or Cloudflare secrets, never in this repository.

## Current repair

Reproduce and fix an inline-float line-breaking hang in the deployed Blitz/Parley renderer. The minimal regression is `<p><span style="float:left">X</span>Text</p>`. Disabling CSS or floats is not the intended fix.

The imported source archive omitted runtime WASM/fonts and renderer build sources. These are being restored with pinned dependencies and reproducible build scripts.
