#!/usr/bin/env bash

set -euo pipefail

cache_dir="${TIKTOKEN_CACHE_DIR:-${RUNNER_TEMP:?RUNNER_TEMP is required}/tiktoken}"
export TIKTOKEN_CACHE_DIR="$cache_dir"

mkdir -p "$TIKTOKEN_CACHE_DIR"
python - <<'PY'
import time

import tiktoken

# The encodings come from a public blob store that occasionally stalls; a
# single slow response must not fail every E2E shard.
for encoding_name in ("cl100k_base", "o200k_base"):
    for attempt in range(5):
        try:
            tiktoken.get_encoding(encoding_name).encode("warmup")
            break
        except Exception as error:  # noqa: BLE001 - download failures vary
            if attempt == 4:
                raise
            delay = 2 * (attempt + 1)
            print(
                f"Retrying {encoding_name} download after {error!r} in {delay}s",
                flush=True,
            )
            time.sleep(delay)
PY

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "TIKTOKEN_CACHE_DIR=$TIKTOKEN_CACHE_DIR" >>"$GITHUB_ENV"
fi
