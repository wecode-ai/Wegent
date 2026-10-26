#!/usr/bin/env bash

set -euo pipefail

cache_dir="${TIKTOKEN_CACHE_DIR:-${RUNNER_TEMP:?RUNNER_TEMP is required}/tiktoken}"
export TIKTOKEN_CACHE_DIR="$cache_dir"

mkdir -p "$TIKTOKEN_CACHE_DIR"
python - <<'PY'
import hashlib
import os
import subprocess

import tiktoken

try:
    import ssl

    print(f"Chat Shell tokenizer SSL runtime: {ssl.OPENSSL_VERSION}")
except ImportError as error:  # some runner images ship Python without libssl
    print(f"Chat Shell tokenizer SSL unavailable: {error!r}", flush=True)

cache_dir = os.environ["TIKTOKEN_CACHE_DIR"]
encodings_url = "https://openaipublic.blob.core.windows.net/encodings"

# Fetch through curl, which carries its own TLS stack, then let tiktoken read
# the cached file so the warmup does not depend on the interpreter's ssl module.
for encoding_name in ("cl100k_base", "o200k_base"):
    url = f"{encodings_url}/{encoding_name}.tiktoken"
    cache_path = os.path.join(cache_dir, hashlib.sha1(url.encode()).hexdigest())
    if not os.path.exists(cache_path):
        subprocess.run(
            [
                "curl",
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--retry",
                "5",
                "--retry-delay",
                "2",
                "--output",
                cache_path,
                url,
            ],
            check=True,
        )
    tiktoken.get_encoding(encoding_name).encode("warmup")
PY

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "TIKTOKEN_CACHE_DIR=$TIKTOKEN_CACHE_DIR" >>"$GITHUB_ENV"
fi
