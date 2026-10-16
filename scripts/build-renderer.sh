#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
REV=4507cd7e2261a439e727aacc0a65cb1d3a2434f9
mkdir -p .cache/blitz
if [[ ! -d .cache/blitz/.git ]]; then
  git -C .cache/blitz init -q
  git -C .cache/blitz remote add origin https://github.com/DioxusLabs/blitz.git
fi
if ! git -C .cache/blitz cat-file -e "$REV^{commit}" 2>/dev/null; then
  git -C .cache/blitz fetch --depth=1 origin "$REV"
fi
if [[ $(git -C .cache/blitz rev-parse HEAD 2>/dev/null || true) != "$REV" ]]; then
  git -C .cache/blitz checkout -q "$REV"
fi
# The upstream constructor must not emit float-only yields in non-float builds.
python3 scripts/patch-blitz.py

rustup target add wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null || [[ $(wasm-bindgen --version) != 'wasm-bindgen 0.2.100' ]]; then
  cargo install wasm-bindgen-cli --version 0.2.100 --locked
fi
cargo build --manifest-path renderer/Cargo.toml --target wasm32-unknown-unknown --release
wasm-bindgen renderer/target/wasm32-unknown-unknown/release/quickjsbrowser_renderer.wasm \
  --target web --out-dir src/vendor/pkg --out-name kitesurf_clone
