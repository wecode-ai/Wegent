#!/usr/bin/env bash
# Regression tests for the AI push gate hook.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
CALL_LOG="$TMP_DIR/calls.log"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_DIR/bin"
touch "$CALL_LOG"

create_stub() {
    local name="$1"
    local path="$TMP_DIR/bin/$name"
    cat > "$path" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$CALL_LOG"
exit 0
STUB
    chmod +x "$path"
}

for cmd in uv black isort pytest npm npx; do
    create_stub "$cmd"
done

export CALL_LOG

# This historical range changes only executor Python files. It exercises the
# Python module branch without pulling frontend or backend-only auxiliary checks
# into the regression test.
REMOTE_SHA="e0cb1f2e0663fdc9a1d878e6952cacc27201f307"
LOCAL_SHA="85d48d64437aefebe0c0fa156d2e403f35d3d103"

AI_VERIFIED=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >/tmp/ai-push-gate-test.out 2>&1
refs/heads/topic $LOCAL_SHA refs/heads/topic $REMOTE_SHA
EOF

if grep -qE '(^| )pytest tests/' "$CALL_LOG"; then
    echo "Expected pre-push hook to avoid full Python pytest suites by default."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

> "$CALL_LOG"

AI_VERIFIED=1 \
AI_PUSH_FULL_TESTS=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >/tmp/ai-push-gate-test-full.out 2>&1
refs/heads/topic $LOCAL_SHA refs/heads/topic $REMOTE_SHA
EOF

if ! grep -qE '(^| )pytest tests/' "$CALL_LOG"; then
    echo "Expected AI_PUSH_FULL_TESTS=1 to run the full Python pytest suite."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

echo "ai-push-gate regression tests passed"
