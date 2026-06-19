#!/usr/bin/env bash
# Start a Wegent standalone image and verify Backend, Frontend, Wework, and terminal are reachable.

set -euo pipefail

IMAGE="${1:-}"

if [ -z "$IMAGE" ]; then
    echo "Usage: $0 IMAGE" >&2
    exit 2
fi

BACKEND_PORT="${BACKEND_PORT:-18000}"
FRONTEND_PORT="${FRONTEND_PORT:-13000}"
WEWORK_PORT="${WEWORK_PORT:-13001}"
TTYD_PORT="${TTYD_PORT:-17681}"
SESSION_GATEWAY_PORT="${SESSION_GATEWAY_PORT:-17888}"
CONTAINER_NAME="${CONTAINER_NAME:-wegent-standalone-verify-$$}"
TIMEOUT_SECONDS="${STANDALONE_VERIFY_TIMEOUT_SECONDS:-180}"
INTERVAL_SECONDS="${STANDALONE_VERIFY_INTERVAL_SECONDS:-2}"

container_exists() {
    docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"
}

print_container_logs() {
    if container_exists; then
        echo ""
        echo "===== Standalone container logs ====="
        docker logs "$CONTAINER_NAME" || true
        echo "===== End standalone container logs ====="
    fi
}

cleanup() {
    local status=$?

    if [ "$status" -ne 0 ]; then
        print_container_logs
    fi

    if container_exists; then
        docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
    return "$status"
}
trap cleanup EXIT

is_container_running() {
    [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" = "true" ]
}

wait_for_url() {
    local label="$1"
    local url="$2"
    local deadline=$((SECONDS + TIMEOUT_SECONDS))

    echo "Waiting for ${label}: ${url}"
    while true; do
        if curl -fsS "$url" >/dev/null 2>&1; then
            echo "${label} is reachable"
            return 0
        fi

        if ! is_container_running; then
            echo "${label} failed readiness check: container exited before ${url} became reachable." >&2
            return 1
        fi

        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "${label} failed readiness check: ${url} was not reachable within ${TIMEOUT_SECONDS}s." >&2
            return 1
        fi

        sleep "$INTERVAL_SECONDS"
    done
}

echo "Starting standalone verification container ${CONTAINER_NAME} from ${IMAGE}"
docker run -d \
    --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${BACKEND_PORT}:8000" \
    -p "127.0.0.1:${FRONTEND_PORT}:3000" \
    -p "127.0.0.1:${WEWORK_PORT}:3001" \
    -p "127.0.0.1:${TTYD_PORT}:7681" \
    -p "127.0.0.1:${SESSION_GATEWAY_PORT}:17888" \
    "$IMAGE"

wait_for_url "Backend" "http://localhost:${BACKEND_PORT}/health"
wait_for_url "Frontend" "http://localhost:${FRONTEND_PORT}/"
wait_for_url "Wework" "http://localhost:${WEWORK_PORT}/"
wait_for_url "Terminal" "http://localhost:${TTYD_PORT}/"

echo "Standalone image verification succeeded for ${IMAGE}"
