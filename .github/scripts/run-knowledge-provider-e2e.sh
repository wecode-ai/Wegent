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
    docker inspect --format '{{json .State}}' "$container" \
      > "$E2E_REPORT_DIR/$container-state.json" || status=1
    docker inspect --format '{{json .Config.Healthcheck}}' "$container" \
      > "$E2E_REPORT_DIR/$container-healthcheck.json" || status=1
    docker logs "$container" > "$E2E_REPORT_DIR/$container.log" 2>&1 || status=1
    docker rm -f "$container" > /dev/null || status=1
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Preserve the original 30s start period plus 30 five-second health checks.
deadline=$((SECONDS + 180))
wait_for_url() {
  local name="$1" url="$2" container="${3:-}"
  while ((SECONDS < deadline)); do
    if [[ -n "$container" ]]; then
      local state
      state="$(docker inspect --format '{{.State.Status}}' "$container")"
      if [[ "$state" != running ]]; then
        printf '%s exited before readiness: %s\n' "$name" "$state" >&2
        return 1
      fi
    fi
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 3 \
      "$url" > "$E2E_REPORT_DIR/$name-readiness.log" 2>&1; then
      return
    fi
    sleep 1
  done
  printf '%s did not become ready within the startup budget\n' "$name" >&2
  cat "$E2E_REPORT_DIR/$name-readiness.log" >&2
  return 1
}

etcd="knowledge-etcd-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
milvus="knowledge-milvus-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
containers+=("$etcd")
docker run -d --name "$etcd" --network "$E2E_DOCKER_NETWORK" --network-alias etcd \
  -e ETCD_ADVERTISE_CLIENT_URLS=http://etcd:2379 \
  -e ETCD_LISTEN_CLIENT_URLS=http://0.0.0.0:2379 -e ETCD_DATA_DIR=/etcd \
  quay.io/coreos/etcd:v3.5.16 > /dev/null
wait_for_url etcd http://etcd:2379/health "$etcd"
wait_for_url minio http://minio:9000/minio/health/ready
containers+=("$milvus")
docker run -d --name "$milvus" --network "$E2E_DOCKER_NETWORK" --network-alias milvus \
  -e ETCD_ENDPOINTS=etcd:2379 -e MINIO_ADDRESS=minio:9000 \
  -e MINIO_ACCESS_KEY_ID=wegent-e2e -e MINIO_SECRET_ACCESS_KEY=wegent-e2e-secret \
  --health-cmd='curl -f http://localhost:9091/healthz' --health-interval=5s \
  --health-timeout=5s --health-start-period=30s --health-retries=30 \
  milvusdb/milvus:v2.5.4 milvus run standalone > /dev/null
wait_for_url milvus http://milvus:9091/healthz "$milvus"
uv run --no-sync python tests/e2e/knowledge_remote_index.py
uv run --no-sync python tests/e2e/knowledge_milvus_e2e.py
