#!/usr/bin/env bash

set -euo pipefail

readonly max_attempts="${PLAYWRIGHT_INSTALL_MAX_ATTEMPTS:-3}"
readonly timeout_seconds="${PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS:-180}"

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  echo "Installing Playwright Chromium (attempt $attempt/$max_attempts)"

  if timeout \
    --signal=TERM \
    --kill-after=15s \
    "${timeout_seconds}s" \
    pnpm exec playwright install chromium; then
    exit 0
  fi

  if [[ "$attempt" -eq "$max_attempts" ]]; then
    echo "Playwright Chromium installation failed after $max_attempts attempts" >&2
    exit 1
  fi

  sleep $((attempt * 5))
done
