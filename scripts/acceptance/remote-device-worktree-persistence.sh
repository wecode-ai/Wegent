#!/usr/bin/env bash
set -euo pipefail

fail() {
    echo "Remote Docker Worktree acceptance failed: $*" >&2
    exit 1
}

DOCKER_BIN="${DOCKER_BIN:-docker}"
IMAGE="${WEGENT_REMOTE_DEVICE_ACCEPTANCE_IMAGE:-${REMOTE_DEVICE_DOCKER_IMAGE:-ghcr.io/wecode-ai/wegent-device:latest}}"
REBUILD_IMAGE="${WEGENT_REMOTE_DEVICE_REBUILD_IMAGE:-$IMAGE}"
RUN_ID="${WEGENT_ACCEPTANCE_RUN_ID:-$(date +%Y%m%d%H%M%S)-$$}"
DEVICE_ID="${WEGENT_ACCEPTANCE_DEVICE_ID:-acceptance-device-$RUN_ID}"
PROBE_ID="${WEGENT_ACCEPTANCE_PROBE_ID:-git-worktree-$RUN_ID}"
CONTAINER_PREFIX="${WEGENT_ACCEPTANCE_CONTAINER_PREFIX:-wegent-worktree-$RUN_ID}"
VOLUME_NAME="${WEGENT_ACCEPTANCE_VOLUME_NAME:-$CONTAINER_PREFIX-home}"
KEEP_ARTIFACTS="${WEGENT_ACCEPTANCE_KEEP_ARTIFACTS:-0}"
ALLOW_EXISTING_VOLUME="${WEGENT_ACCEPTANCE_ALLOW_EXISTING_VOLUME:-0}"
EXECUTOR_HOME="/home/wegent/.wecode/wegent-executor"
PROBE_TARGET="/opt/wegent-acceptance/executor-home-persistence-probe.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROBE_SCRIPT="$SCRIPT_DIR/executor-home-persistence-probe.sh"

for value in "$RUN_ID" "$PROBE_ID" "$CONTAINER_PREFIX" "$VOLUME_NAME"; do
    [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || {
        fail "acceptance identifiers contain unsupported characters: $value"
    }
done
[[ "$DEVICE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || {
    fail "logical device ID contains unsupported characters: $DEVICE_ID"
}
[ -x "$PROBE_SCRIPT" ] || fail "persistence probe is not executable: $PROBE_SCRIPT"
command -v "$DOCKER_BIN" >/dev/null 2>&1 || {
    fail "Docker CLI not found: $DOCKER_BIN"
}
"$DOCKER_BIN" info >/dev/null 2>&1 || fail "Docker daemon is unavailable"

containers=()
volume_created=0
VOLUME_ID=""

run_docker() {
    "$DOCKER_BIN" "$@"
}

cleanup() {
    local status=$?
    trap - EXIT
    set +e
    if [ "$KEEP_ARTIFACTS" != "1" ]; then
        local container
        for container in "${containers[@]}"; do
            run_docker rm -f "$container" >/dev/null 2>&1 || true
        done
        if [ "$volume_created" = "1" ]; then
            run_docker volume rm -f "$VOLUME_NAME" >/dev/null 2>&1 || true
        fi
    else
        echo "Acceptance artifacts retained with prefix: $CONTAINER_PREFIX" >&2
        echo "Acceptance volume retained: $VOLUME_NAME" >&2
    fi
    exit "$status"
}
trap cleanup EXIT

ensure_image() {
    local image="$1"
    if ! run_docker image inspect "$image" >/dev/null 2>&1; then
        run_docker pull "$image" >/dev/null
    fi
}

start_container() {
    local name="$1"
    local image="$2"
    local instance_id="$3"
    local current_volume_id
    current_volume_id="$(
        run_docker volume inspect \
            --format '{{.Name}}|{{.CreatedAt}}' \
            "$VOLUME_NAME"
    )"
    [ "$current_volume_id" = "$VOLUME_ID" ] || {
        fail "Docker volume identity changed during container replacement"
    }
    containers+=("$name")
    run_docker run -d \
        --name "$name" \
        -e DEVICE_TYPE=remote \
        -e DEVICE_ID="$DEVICE_ID" \
        -e EXECUTOR_MODE=local \
        -e WEGENT_EXECUTOR_HOME_ID="$DEVICE_ID" \
        -e WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true \
        -e WEGENT_ACCEPTANCE_INSTANCE_ID="$instance_id" \
        -e WEGENT_ACCEPTANCE_VOLUME_ID="$VOLUME_ID" \
        -e WEGENT_ACCEPTANCE_PROBE_ID="$PROBE_ID" \
        --mount "type=volume,src=$VOLUME_NAME,dst=$EXECUTOR_HOME" \
        --mount "type=bind,src=$PROBE_SCRIPT,dst=$PROBE_TARGET,readonly" \
        "$image" \
        >/dev/null
}

wait_until_running() {
    local name="$1"
    local attempt
    local state
    for attempt in $(seq 1 30); do
        state="$(run_docker inspect --format '{{.State.Status}}' "$name")"
        case "$state" in
            running) return ;;
            exited | dead)
                run_docker logs "$name" >&2 || true
                fail "container exited before becoming ready: $name"
                ;;
        esac
        sleep 1
    done
    run_docker logs "$name" >&2 || true
    fail "container did not become ready: $name"
}

wait_until_exited() {
    local name="$1"
    local attempt
    local state
    for attempt in $(seq 1 30); do
        state="$(run_docker inspect --format '{{.State.Status}}' "$name")"
        case "$state" in
            exited | dead) return ;;
        esac
        sleep 1
    done
    fail "container did not exit as required: $name"
}

assert_volume_mount() {
    local name="$1"
    local mount
    mount="$(
        run_docker inspect \
            --format '{{range .Mounts}}{{if eq .Destination "/home/wegent/.wecode/wegent-executor"}}{{printf "%s|%s" .Type .Name}}{{end}}{{end}}' \
            "$name"
    )"
    [ "$mount" = "volume|$VOLUME_NAME" ] || {
        fail "container does not use the expected named Executor Home volume"
    }
}

assert_image_binary_refreshed() {
    local name="$1"
    run_docker exec "$name" \
        bash -lc 'cmp -s /app/executor "$WEGENT_EXECUTOR_HOME/bin/wegent-executor"' \
        || fail "persisted Executor binary was not refreshed from the current image"
}

initialize_runtime_identity() {
    local name="$1"
    run_docker exec "$name" bash -lc '
        log_path="$WEGENT_EXECUTOR_HOME/logs/acceptance-runtime-bootstrap.log"
        "$WEGENT_EXECUTOR_HOME/bin/wegent-executor" >"$log_path" 2>&1 &
        runtime_pid=$!
        ready=0
        for _attempt in $(seq 1 50); do
            if [ -s "$WEGENT_EXECUTOR_HOME/device-config.json" ]; then
                ready=1
                break
            fi
            if ! kill -0 "$runtime_pid" 2>/dev/null; then
                break
            fi
            sleep 0.1
        done
        kill "$runtime_pid" 2>/dev/null || true
        wait "$runtime_pid" 2>/dev/null || true
        if [ "$ready" != "1" ]; then
            cat "$log_path" >&2 || true
            exit 1
        fi
    ' || fail "Executor did not persist its Runtime instance identity"
}

run_probe() {
    local name="$1"
    local phase="$2"
    run_docker exec "$name" bash "$PROBE_TARGET" "$phase"
}

assert_expected_failure() {
    local name="$1"
    local expected_log="$2"
    wait_until_exited "$name"
    local exit_code
    exit_code="$(run_docker inspect --format '{{.State.ExitCode}}' "$name")"
    [ "$exit_code" != "0" ] || fail "container unexpectedly exited successfully: $name"
    run_docker logs "$name" 2>&1 | grep -Fq "$expected_log" || {
        run_docker logs "$name" >&2 || true
        fail "container did not report the expected failure: $expected_log"
    }
}

ensure_image "$IMAGE"
if [ "$REBUILD_IMAGE" != "$IMAGE" ]; then
    ensure_image "$REBUILD_IMAGE"
fi

if run_docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    [ "$ALLOW_EXISTING_VOLUME" = "1" ] || {
        fail "volume already exists; set WEGENT_ACCEPTANCE_ALLOW_EXISTING_VOLUME=1 to reuse it"
    }
else
    run_docker volume create "$VOLUME_NAME" >/dev/null
    volume_created=1
fi
VOLUME_ID="$(
    run_docker volume inspect \
        --format '{{.Name}}|{{.CreatedAt}}' \
        "$VOLUME_NAME"
)"
[ -n "$VOLUME_ID" ] || fail "Docker volume does not expose a stable identity"

first_container="$CONTAINER_PREFIX-first"
first_instance="$RUN_ID-instance-a"
start_container "$first_container" "$IMAGE" "$first_instance"
wait_until_running "$first_container"
assert_volume_mount "$first_container"
assert_image_binary_refreshed "$first_container"
initialize_runtime_identity "$first_container"
run_probe "$first_container" seed
first_container_id="$(run_docker inspect --format '{{.Id}}' "$first_container")"

writer_conflict="$CONTAINER_PREFIX-writer-conflict"
start_container "$writer_conflict" "$IMAGE" "$RUN_ID-instance-conflict"
assert_expected_failure \
    "$writer_conflict" \
    "Another Executor is already using WEGENT_EXECUTOR_HOME"
run_docker rm -f "$writer_conflict" >/dev/null

run_docker rm -f "$first_container" >/dev/null

rebuilt_container="$CONTAINER_PREFIX-rebuilt"
rebuilt_instance="$RUN_ID-instance-b"
start_container "$rebuilt_container" "$REBUILD_IMAGE" "$rebuilt_instance"
wait_until_running "$rebuilt_container"
assert_volume_mount "$rebuilt_container"
assert_image_binary_refreshed "$rebuilt_container"
initialize_runtime_identity "$rebuilt_container"
rebuilt_container_id="$(run_docker inspect --format '{{.Id}}' "$rebuilt_container")"
[ "$first_container_id" != "$rebuilt_container_id" ] || {
    fail "container instance was not replaced"
}
run_probe "$rebuilt_container" verify
run_docker rm -f "$rebuilt_container" >/dev/null

wrong_identity="$CONTAINER_PREFIX-wrong-identity"
original_device_id="$DEVICE_ID"
DEVICE_ID="$DEVICE_ID-other"
start_container "$wrong_identity" "$REBUILD_IMAGE" "$RUN_ID-instance-wrong"
DEVICE_ID="$original_device_id"
assert_expected_failure \
    "$wrong_identity" \
    "Executor Home identity does not match WEGENT_EXECUTOR_HOME_ID"
run_docker rm -f "$wrong_identity" >/dev/null

final_container="$CONTAINER_PREFIX-final"
start_container "$final_container" "$REBUILD_IMAGE" "$RUN_ID-instance-c"
wait_until_running "$final_container"
initialize_runtime_identity "$final_container"
run_probe "$final_container" verify
run_probe "$final_container" cleanup

echo "ACCEPTANCE_TARGET=remote-docker-worktree-persistence"
echo "ACCEPTANCE_RESULT=passed"
echo "ACCEPTANCE_DEVICE_ID=$DEVICE_ID"
echo "ACCEPTANCE_VOLUME=$VOLUME_NAME"
echo "ACCEPTANCE_INITIAL_IMAGE=$IMAGE"
echo "ACCEPTANCE_REBUILD_IMAGE=$REBUILD_IMAGE"
