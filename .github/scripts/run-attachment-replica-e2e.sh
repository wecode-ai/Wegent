#!/usr/bin/env bash

set -euo pipefail

: "${E2E_DOCKER_NETWORK:?Platform E2E container network is required}"
: "${E2E_REPORT_DIR:?Evidence directory is required}"
mkdir -p "$E2E_REPORT_DIR"
containers=()

cleanup() {
  local status=$?
  trap - EXIT
  local container
  for container in "${containers[@]}"; do
    docker logs "$container" > "$E2E_REPORT_DIR/$container.log" 2>&1 || status=1
    docker rm -f "$container" > /dev/null || status=1
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_container() {
  local container="$1"
  local deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    local state
    state="$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container")"
    case "$state" in
      'running healthy') return ;;
      'exited '* | 'dead '* | *' unhealthy') break ;;
    esac
    sleep 1
  done
  printf 'Attachment fixture did not become healthy: %s\n' "$container" >&2
  return 1
}

replica="attachment-replica-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
broker="attachment-redis-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
# The entrypoint's temporary socket-only server must not satisfy readiness.
docker run -d --name "$replica" --network "$E2E_DOCKER_NETWORK" \
  --network-alias mysql-replica \
  -e MYSQL_ROOT_PASSWORD=test123 -e MYSQL_DATABASE=wegent_test \
  --health-cmd='MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=TCP --host=127.0.0.1 --user=root --execute="SELECT 1"' \
  --health-interval=2s \
  --health-timeout=5s --health-start-period=5s --health-retries=30 \
  mysql:8.0 > /dev/null
containers+=("$replica")
docker run -d --name "$broker" --network "$E2E_DOCKER_NETWORK" \
  --network-alias attachment-redis \
  --health-cmd='redis-cli ping' --health-interval=2s \
  --health-timeout=5s --health-retries=15 redis:7-alpine > /dev/null
containers+=("$broker")
wait_for_container "$replica"
wait_for_container "$broker"
uv run --no-sync python tests/e2e/attachment_upload_replica.py
