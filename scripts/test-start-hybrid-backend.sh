#!/usr/bin/env bash
# Regression tests for start.sh keeping the Backend health check open while the
# hybrid Backend is still starting up (backend-rs builds its Rust gateway with
# `cargo build --release` before the public port can accept traffic).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
START_SH="$PROJECT_ROOT/start.sh"
HYBRID_START_SH="$PROJECT_ROOT/backend-rs/scripts/start-hybrid-backend.sh"
FIXTURE_ROOT="$(mktemp -d)"

PID_DIR="$FIXTURE_ROOT/pids"
STATE_FILE="$PID_DIR/backend-hybrid.state"
STUB_BIN="$FIXTURE_ROOT/bin"
HEALTHY_BIN="$FIXTURE_ROOT/healthy-bin"
PROBE_COUNT_FILE="$FIXTURE_ROOT/probes"
BACKEND_PORT=65500

mkdir -p "$PID_DIR" "$STUB_BIN" "$HEALTHY_BIN"

cleanup() {
    for fixture_pid in ${LIVE_PIDS:-}; do
        kill "$fixture_pid" 2>/dev/null || true
    done
    rm -rf "$FIXTURE_ROOT"
}
trap cleanup EXIT

LIVE_PIDS=""

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

if ! grep -Fq -- '--timeout-keep-alive 2400' "$HYBRID_START_SH"; then
    fail "Python upstream keep-alive must outlive the longest hybrid E2E job"
fi

extract_function() {
    local function_name="$1"

    awk -v function_name="$function_name" '
        $0 ~ "^" function_name "\\(\\) \\{" {
            in_function = 1
            depth = 1
            print
            next
        }
        in_function {
            print
            opens = gsub(/\{/, "{")
            closes = gsub(/\}/, "}")
            depth += opens - closes
            if (depth == 0) {
                exit
            }
        }
    ' "$START_SH"
}

state_field_body="$(extract_function read_hybrid_backend_state_field)"
startup_stage_body="$(extract_function hybrid_backend_startup_stage)"
readiness_body="$(extract_function probe_service_readiness)"
health_check_body="$(extract_function check_service_health)"

for body in "$state_field_body" "$startup_stage_body" "$readiness_body" "$health_check_body"; do
    if [ -z "$body" ]; then
        fail "unable to extract a start.sh function body"
    fi
done

# Never touch real ports and never wait for real time, so the health check loop
# is asserted on its iteration count instead of its wall-clock duration.
write_stub() {
    local directory="$1"
    local name="$2"
    local status="$3"

    printf '%s\n' '#!/usr/bin/env bash' "exit $status" > "$directory/$name"
    chmod +x "$directory/$name"
}

write_stub "$STUB_BIN" sleep 0
write_stub "$STUB_BIN" nc 1

# The failing curl stub records every probe so the test can assert how many
# times the health check retried.
cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf '.' >> "$PROBE_COUNT_FILE"
exit 1
STUB
chmod +x "$STUB_BIN/curl"

write_stub "$HEALTHY_BIN" sleep 0
write_stub "$HEALTHY_BIN" curl 0
write_stub "$HEALTHY_BIN" nc 1

# Stand-in for a live launcher child. Its stdio is detached so the caller's
# command substitution returns immediately instead of waiting for the process.
start_live_process() {
    sleep 60 >/dev/null 2>&1 &
    LIVE_PIDS="$LIVE_PIDS $!"
    echo $!
}

# Run check_service_health with the fixture PATH and no stubbed dependencies.
run_health_check() {
    local stub_bin="$1"
    local service_name="$2"
    local wait_timeout="$3"

    : > "$PROBE_COUNT_FILE"
    PID_DIR="$PID_DIR" \
        PROBE_COUNT_FILE="$PROBE_COUNT_FILE" \
        WEGENT_HYBRID_BACKEND_WAIT_TIMEOUT="$wait_timeout" \
        PATH="$stub_bin:/usr/bin:/bin" \
        bash -c '
            eval "$1"
            eval "$2"
            eval "$3"
            eval "$4"
            check_service_health "$5" "$6" "/health"
        ' _ "$state_field_body" "$startup_stage_body" "$readiness_body" \
        "$health_check_body" "$service_name" "$BACKEND_PORT" 2>&1
}

# probe_service_readiness calls curl twice per probe.
probe_count() {
    local bytes
    bytes="$(wc -c < "$PROBE_COUNT_FILE" | tr -d ' ')"
    echo $((bytes / 2))
}

write_state_file() {
    local parent_pid="$1"
    local build_pid="$2"
    local python_pid="$3"
    local rust_pid="$4"

    {
        echo "parent=$parent_pid"
        echo "build=$build_pid"
        echo "python=$python_pid"
        echo "rust=$rust_pid"
        echo "python_port=8004"
    } > "$STATE_FILE"
}

live_build_pid="$(start_live_process)"
live_python_pid="$(start_live_process)"
dead_pid="$(start_live_process)"
kill "$dead_pid" 2>/dev/null || true
wait "$dead_pid" 2>/dev/null || true

# A healthy Backend returns before any startup wait is considered.
write_state_file "$$" "$live_build_pid" "" ""
healthy_output="$(run_health_check "$HEALTHY_BIN" backend 180)" || true
case "$healthy_output" in
    *"✓ healthy (port $BACKEND_PORT)"*) ;;
    *) fail "expected a healthy Backend, got: $healthy_output" ;;
esac
case "$healthy_output" in
    *"backend-rs is"*) fail "healthy Backend must not report a startup stage" ;;
esac

# A running `cargo build --release` keeps the check open for the configured wait.
write_state_file "$$" "$live_build_pid" "" ""
build_output="$(run_health_check "$STUB_BIN" backend 4)" || true
build_probes="$(probe_count)"
case "$build_output" in
    *"backend-rs is compiling the Rust gateway (cargo build --release)"*) ;;
    *) fail "expected the cargo build stage to be reported, got: $build_output" ;;
esac
case "$build_output" in
    *"Waiting... (4s/4s)"*) ;;
    *) fail "expected the startup wait to be bounded by 4s, got: $build_output" ;;
esac
case "$build_output" in
    *"✗ failed (port $BACKEND_PORT not responding)"*) ;;
    *) fail "expected a failed health check after the wait, got: $build_output" ;;
esac
case "$build_output" in
    *"Increase WEGENT_HYBRID_BACKEND_WAIT_TIMEOUT"*) ;;
    *) fail "expected the timeout hint to name the wait variable, got: $build_output" ;;
esac

# The build stage is reported on the first probe, before the retry budget is spent.
expected_first_lines=$'  Checking backend...\n    backend-rs is compiling the Rust gateway (cargo build --release), waiting up to 4s...'
actual_first_lines="$(head -n 2 <<< "$build_output")"
if [ "$actual_first_lines" != "$expected_first_lines" ]; then
    fail "expected the build stage up front, got: $actual_first_lines"
fi

# Progress is reported every 10s, so a 4s wait prints only its final iteration.
waiting_lines="$(grep -c 'Waiting\.\.\.' <<< "$build_output" || true)"
if [ "$waiting_lines" != "1" ]; then
    fail "expected 1 startup wait line for a 4s wait, got $waiting_lines"
fi

# The startup wait is a cap, not a fixed wait: a 4s wait spends 2 probes on the
# build stage and then gets its own 15 retries once the launcher stops reporting.
if [ "$build_probes" != "18" ]; then
    fail "expected 2 startup probes plus 15 retries before giving up, got $build_probes probes"
fi

# The wait defaults to 180s and stays gated on the live startup stage.
write_state_file "$$" "$live_build_pid" "" ""
default_output="$(run_health_check "$STUB_BIN" backend "")" || true
case "$default_output" in
    *"Waiting... (180s/180s)"*) ;;
    *) fail "expected the default 180s startup wait, got: $default_output" ;;
esac
default_waiting_lines="$(grep -c 'Waiting\.\.\.' <<< "$default_output" || true)"
if [ "$default_waiting_lines" != "18" ]; then
    fail "expected 18 startup wait lines for the default 180s wait, got $default_waiting_lines"
fi

# Without a live launcher the check reports the plain failure after the retries.
rm -f "$STATE_FILE"
missing_state_output="$(run_health_check "$STUB_BIN" backend 180)" || true
missing_state_probes="$(probe_count)"
case "$missing_state_output" in
    *"backend-rs is"*) fail "a missing state file must not report a startup stage" ;;
esac
case "$missing_state_output" in
    *"Waiting..."*) fail "a missing state file must not extend the health check" ;;
esac
if [ "$missing_state_probes" != "16" ]; then
    fail "expected 15 retries plus a final probe without a launcher, got $missing_state_probes probes"
fi

# A live launcher is reported even between its stages, when no child is running yet.
write_state_file "$$" "" "" ""
between_stages_output="$(run_health_check "$STUB_BIN" backend 4)" || true
case "$between_stages_output" in
    *"backend-rs is starting the Backend services"*) ;;
    *) fail "expected a launcher-only stage, got: $between_stages_output" ;;
esac

# A dead launcher must not extend the health check either.
write_state_file "$dead_pid" "$live_build_pid" "" ""
dead_launcher_output="$(run_health_check "$STUB_BIN" backend 180)" || true
case "$dead_launcher_output" in
    *"backend-rs is"*) fail "a dead launcher must not report a startup stage" ;;
esac

# Only the Backend waits for the hybrid startup stage.
write_state_file "$$" "$live_build_pid" "" ""
other_service_output="$(run_health_check "$STUB_BIN" chat_shell 180)" || true
case "$other_service_output" in
    *"backend-rs is"*) fail "chat_shell must not wait for the hybrid Backend" ;;
esac
case "$other_service_output" in
    *"Waiting..."*) fail "chat_shell must not extend the health check" ;;
esac

# After the build, the Python upstream startup is reported instead.
write_state_file "$$" "" "$live_python_pid" ""
python_stage_output="$(run_health_check "$STUB_BIN" backend 4)" || true
case "$python_stage_output" in
    *"backend-rs is starting the Python Backend upstream"*) ;;
    *) fail "expected the Python upstream stage, got: $python_stage_output" ;;
esac

echo "start.sh hybrid Backend wait tests passed"
