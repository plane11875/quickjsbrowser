#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
REV=84e723f1ace5e3823cef8149dd0f890fe74b77ce
mkdir -p vendor/quickjs
if [[ ! -d vendor/quickjs/.git ]]; then
  git -C vendor/quickjs init -q
  git -C vendor/quickjs remote add origin https://github.com/bellard/quickjs.git
fi
if ! git -C vendor/quickjs cat-file -e "$REV^{commit}" 2>/dev/null; then
  git -C vendor/quickjs fetch --depth=1 origin "$REV"
fi
git -C vendor/quickjs checkout -q "$REV"
