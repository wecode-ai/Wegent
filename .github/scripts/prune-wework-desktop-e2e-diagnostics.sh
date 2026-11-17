#!/usr/bin/env bash

set -euo pipefail

exec node "$(dirname "$0")/../../wework/e2e/desktop/result-retention.mjs" \
  "${1:-wework/test-results/desktop-e2e}"
