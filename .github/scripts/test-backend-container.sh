#!/usr/bin/env bash

# Real image/Compose regression. Run only in CI with isolated Docker resources.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
report="${BACKEND_CONTAINER_REPORT_DIR:?Set BACKEND_CONTAINER_REPORT_DIR}"
mkdir -p "$report"
git rev-parse HEAD > "$report/sha.txt"
printf '%s\n' 'bash .github/scripts/test-backend-container.sh' > "$report/command.txt"

compose=(docker compose -f docker-compose.yml -f docker-compose.build.yml
    -f .github/fixtures/backend-container-e2e.yml --profile rag)
cases=0
cleanup() {
    local status=$?
    trap - EXIT
    "${compose[@]}" logs --no-color > "$report/containers.log" 2>&1 || true
    if ! "${compose[@]}" down -v --remove-orphans; then
        status=1
    fi
    printf '{"tests":%s,"exit_code":%s,"success":%s}\n' \
        "$cases" "$status" "$([ "$status" -eq 0 ] && echo true || echo false)" \
        > "$report/result.json"
    exit "$status"
}
trap cleanup EXIT

pass() {
    cases=$((cases + 1))
    printf 'PASS: %s\n' "$1"
}

wait_ready() {
    local deadline=$((SECONDS + 180))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if curl -fsS http://127.0.0.1:8000/api/health > "$report/health.json"; then
            jq -e '.status == "healthy"' "$report/health.json" >/dev/null
            return
        fi
        if [ "$(docker inspect --format '{{.State.Status}}' wegent-backend)" = exited ]; then
            echo 'Backend exited before readiness' >&2
            return 1
        fi
        sleep 1
    done
    echo 'Backend readiness timed out' >&2
    return 1
}

assert_processes() {
    docker exec wegent-backend bash -euc '
        source /tmp/wegent-backend.state
        test "$parent" = 1
        kill -0 "$python" "$rust"
        test "$python_port" = 8004
        tr "\0" "\n" < "/proc/$python/cmdline" > /tmp/python-args
        ! grep -Fx -- --reload /tmp/python-args
        grep -Fx -- --timeout-graceful-shutdown /tmp/python-args
        test "$(readlink /proc/$python/cwd)" = /app
        test "$(readlink /proc/$rust/exe)" = /usr/local/bin/wegent-backend-rs
    '
}

"${compose[@]}" up -d --build backend
wait_ready
assert_processes
docker inspect --format '{{json .HostConfig.PortBindings}}' wegent-backend \
    | jq -e 'keys == ["8000/tcp"] and .["8000/tcp"][0].HostPort == "8000"' >/dev/null
pass 'both processes run in the existing backend container; only port 8000 is published'

# Python has no root GET handler; its 200 response proves the Rust-owned path.
curl -fsS http://127.0.0.1:8000/ > "$report/root.json"
jq -e '.name == "Task Manager Backend" and .api_prefix == "/api"' "$report/root.json" >/dev/null
pass 'Rust handles its selected root route'
# /api/health is not selected in routes.toml and therefore exercises forwarding.
curl -fsS http://127.0.0.1:8000/api/health | jq -e '.status == "healthy"' >/dev/null
pass 'the Rust public listener forwards the Python-owned health route'

for role in rust python; do
    previous="$(docker inspect --format '{{.RestartCount}}' wegent-backend)"
    # Detach so correct supervisor teardown cannot interrupt the exec client.
    docker exec --detach -e FAILED_ROLE="$role" wegent-backend bash -euc '
        source /tmp/wegent-backend.state
        kill -KILL "${!FAILED_ROLE}"
    '
    deadline=$((SECONDS + 60))
    until [ "$(docker inspect --format '{{.RestartCount}}' wegent-backend)" -gt "$previous" ]; do
        test "$SECONDS" -lt "$deadline"
        sleep 1
    done
    wait_ready
    assert_processes
    pass "$role termination exits the supervisor; the existing restart policy restores both processes"
done

"${compose[@]}" stop -t 20 backend
test "$(docker inspect --format '{{.State.Running}}' wegent-backend)" = false
test "$(docker inspect --format '{{.State.ExitCode}}' wegent-backend)" = 143
pass 'Compose stop forwards SIGTERM and terminates both processes without SIGKILL'
test "$cases" -eq 6
