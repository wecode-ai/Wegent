#!/usr/bin/env bash
set -euo pipefail

# Only the test container's hosts file is changed; runner services keep their URLs.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runner_gateway="$(node "$script_dir/e2e-runner-network.mjs")"
export E2E_BROWSER_HOST_GATEWAY="$runner_gateway"
# Runner processes (Backend, Executors) reach fixture servers through this address.
container_address="$(node "$script_dir/e2e-runner-network.mjs" --container-address)"
export E2E_TEST_CONTAINER_ADDRESS="$container_address"
exec "$@"
