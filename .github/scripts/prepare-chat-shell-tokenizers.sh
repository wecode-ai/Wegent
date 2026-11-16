#!/usr/bin/env bash

set -euo pipefail

cache_dir="${TIKTOKEN_CACHE_DIR:-${RUNNER_TEMP:?RUNNER_TEMP is required}/tiktoken}"
export TIKTOKEN_CACHE_DIR="$cache_dir"

mkdir -p "$TIKTOKEN_CACHE_DIR"
python - <<'PY'
import ssl

import tiktoken

print(f"Chat Shell tokenizer SSL runtime: {ssl.OPENSSL_VERSION}")
for encoding_name in ("cl100k_base", "o200k_base"):
    tiktoken.get_encoding(encoding_name).encode("warmup")
PY

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "TIKTOKEN_CACHE_DIR=$TIKTOKEN_CACHE_DIR" >>"$GITHUB_ENV"
fi
