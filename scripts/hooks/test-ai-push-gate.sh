#!/usr/bin/env bash
# Regression tests for the AI push gate hook.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
CALL_LOG="$TMP_DIR/calls.log"
DEFAULT_TEST_OUT="$(mktemp "${TMP_DIR}/default-test.XXXXXX")"
FULL_TEST_OUT="$(mktemp "${TMP_DIR}/full-test.XXXXXX")"
WEWORK_TEST_OUT="$(mktemp "${TMP_DIR}/wework-test.XXXXXX")"
ROOT_NODE_MODULES_CREATED=0
WEWORK_NODE_MODULES_CREATED=0

cleanup() {
    if [ "$ROOT_NODE_MODULES_CREATED" = "1" ]; then
        rmdir "$PROJECT_ROOT/node_modules" 2>/dev/null || true
    fi
    if [ "$WEWORK_NODE_MODULES_CREATED" = "1" ]; then
        rmdir "$PROJECT_ROOT/wework/node_modules" 2>/dev/null || true
    fi
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

for cmd in cargo uv black isort pytest npm npx pnpm; do
    create_stub "$cmd"
done

export CALL_LOG

ensure_wework_node_modules() {
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        mkdir "$PROJECT_ROOT/node_modules"
        ROOT_NODE_MODULES_CREATED=1
    fi

    if [ ! -d "$PROJECT_ROOT/wework/node_modules" ]; then
        mkdir "$PROJECT_ROOT/wework/node_modules"
        WEWORK_NODE_MODULES_CREATED=1
    fi
}

# This historical range changes only backend Python files. It exercises the
# Python module branch without pulling frontend or executor checks into the
# regression test.
REMOTE_SHA="32219870e7b781dfaa4b0046db9e4ac5aeb02aa4"
LOCAL_SHA="6342ce3b9624f3ce05f831d52b2b3b56edf2c36c"

AI_VERIFIED=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$DEFAULT_TEST_OUT" 2>&1
refs/heads/topic $LOCAL_SHA refs/heads/topic $REMOTE_SHA
EOF

if grep -qE '(^| )pytest tests/' "$CALL_LOG"; then
    echo "Expected pre-push hook to avoid full Python pytest suites by default."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if grep -qE '^pnpm --filter wework typecheck$' "$CALL_LOG"; then
    echo "Expected non-Wework changes not to run the Wework TypeScript check."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

: > "$CALL_LOG"

AI_VERIFIED=1 \
AI_PUSH_FULL_TESTS=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$FULL_TEST_OUT" 2>&1
refs/heads/topic $LOCAL_SHA refs/heads/topic $REMOTE_SHA
EOF

if ! grep -qE '(^| )pytest tests/' "$CALL_LOG"; then
    echo "Expected AI_PUSH_FULL_TESTS=1 to run the full Python pytest suite."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

: > "$CALL_LOG"

# This historical range changes only Wework files. It verifies the pre-push
# gate runs Wework's project-reference TypeScript check when Wework changes.
WEWORK_REMOTE_SHA="6e79ac169145a729973c9b7b231f47acba72b50c"
WEWORK_LOCAL_SHA="2f77b34aae02d0e9d5254530b503655835072cc7"

ensure_wework_node_modules

AI_VERIFIED=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$WEWORK_TEST_OUT" 2>&1
refs/heads/topic $WEWORK_LOCAL_SHA refs/heads/topic $WEWORK_REMOTE_SHA
EOF

if ! grep -qE '^pnpm --filter wework typecheck$' "$CALL_LOG"; then
    echo "Expected Wework changes to run the Wework TypeScript check."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE '^pnpm --filter wework test --coverage --passWithNoTests$' "$CALL_LOG"; then
    echo "Expected Wework changes to run unit tests through the Wework package script."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

echo "ai-push-gate regression tests passed"
