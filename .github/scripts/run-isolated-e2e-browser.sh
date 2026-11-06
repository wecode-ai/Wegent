#!/usr/bin/env bash
set -euo pipefail

# Only the test container's hosts file is changed; runner services keep their URLs.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runner_gateway="$(node "$script_dir/e2e-runner-network.mjs")"
export E2E_BROWSER_HOST_GATEWAY="$runner_gateway"
exec "$@"
