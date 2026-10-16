# Project instructions

- Work in this repository's GitHub Codespace.
- Use the installed `wrangler` binary; do not use npx or wrangler dev.
- Run all local suites and renderer regression checks before deploying.
- Use a fresh CDP session name for each deployed regression test.
- Never commit credentials, private deployment configuration, or session logs.
- Do not introduce KV without the user's authorization.
- Keep renderer fixes at the Rust layout boundary; do not disable page CSS or floats as a substitute.
