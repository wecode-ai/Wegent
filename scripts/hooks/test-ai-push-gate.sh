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
WEWORK_FULL_TEST_OUT="$(mktemp "${TMP_DIR}/wework-full-test.XXXXXX")"
WEWORK_ELECTRON_TEST_OUT="$(mktemp "${TMP_DIR}/wework-electron-test.XXXXXX")"
WEWORK_MIXED_TEST_OUT="$(mktemp "${TMP_DIR}/wework-mixed-test.XXXXXX")"
FRONTEND_TEST_OUT="$(mktemp "${TMP_DIR}/frontend-test.XXXXXX")"
EXECUTOR_TEST_OUT="$(mktemp "${TMP_DIR}/executor-test.XXXXXX")"
EXECUTOR_FULL_TEST_OUT="$(mktemp "${TMP_DIR}/executor-full-test.XXXXXX")"
ROOT_NODE_MODULES_CREATED=0
WEWORK_NODE_MODULES_CREATED=0
FRONTEND_NODE_MODULES_CREATED=0

cleanup() {
    if [ "$ROOT_NODE_MODULES_CREATED" = "1" ]; then
        rmdir "$PROJECT_ROOT/node_modules" 2>/dev/null || true
    fi
    if [ "$WEWORK_NODE_MODULES_CREATED" = "1" ]; then
        rmdir "$PROJECT_ROOT/wework/node_modules" 2>/dev/null || true
    fi
    if [ "$FRONTEND_NODE_MODULES_CREATED" = "1" ]; then
        rmdir "$PROJECT_ROOT/frontend/node_modules" 2>/dev/null || true
    fi
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_DIR/bin"
touch "$CALL_LOG"

# Read repository history, but keep synthetic fixture objects in the test directory.
REPOSITORY_OBJECTS=$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-path objects)
mkdir -p "$TMP_DIR/git-objects"
export GIT_OBJECT_DIRECTORY="$TMP_DIR/git-objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$REPOSITORY_OBJECTS"

create_stub() {
    local name="$1"
    local path="$TMP_DIR/bin/$name"
    cat > "$path" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$CALL_LOG"
if [ "$(basename "$0")" = "pnpm" ]; then
    case "$*" in
        '--filter wework typecheck'|'--filter wework lint'|'--filter wework run lint:task-lifecycle')
            # Keep static checks active long enough to expose an overlapping test start.
            sleep 0.2
            printf 'completed pnpm %s\n' "$*" >> "$CALL_LOG"
            ;;
        '--filter wework run prepare:electron')
            rm -f "$CALL_LOG.electron-typecheck-complete"
            ;;
        '--dir wework/electron typecheck')
            # Keep the shared staging directory busy until typechecking finishes.
            sleep 0.2
            touch "$CALL_LOG.electron-typecheck-complete"
            ;;
        '--dir wework/electron test'*)
            if [ ! -f "$CALL_LOG.electron-typecheck-complete" ]; then
                echo 'Electron tests started before typechecking finished staging process-explorer' >&2
                exit 1
            fi
            ;;
    esac
fi
exit 0
STUB
    chmod +x "$path"
}

for cmd in cargo uv black isort pytest npm npx pnpm caffeinate; do
    create_stub "$cmd"
done

cat > "$TMP_DIR/bin/uname" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${PUSH_GATE_TEST_PLATFORM:-Linux}"
STUB
chmod +x "$TMP_DIR/bin/uname"

export CALL_LOG
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Wegent Push Gate Test}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-push-gate-test@localhost}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"

assert_renderer_tests_follow_static_checks() {
    local test_line
    local check
    local completed_line
    local lint_check='--filter wework run lint:task-lifecycle'
    if grep -q '^pnpm --filter wework lint$' "$CALL_LOG"; then
        lint_check='--filter wework lint'
    fi
    test_line=$(awk '/^pnpm --filter wework exec vitest / { print NR; exit }' "$CALL_LOG")
    for check in '--filter wework typecheck' "$lint_check"; do
        completed_line=$(awk -v event="completed pnpm $check" '$0 == event { print NR; exit }' "$CALL_LOG")
        if [ -z "$completed_line" ] || [ -z "$test_line" ] ||
            [ "$completed_line" -ge "$test_line" ]; then
            echo "Expected Wework renderer tests to start after static checks complete: $check"
            cat "$CALL_LOG"
            exit 1
        fi
    done
}

# This historical range changes only backend Python files. It exercises the
# Python module branch without pulling frontend or executor checks into the
# regression test.
REMOTE_SHA="32219870e7b781dfaa4b0046db9e4ac5aeb02aa4"
LOCAL_SHA="6342ce3b9624f3ce05f831d52b2b3b56edf2c36c"

if PATH="$TMP_DIR/bin:$PATH" \
    bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" >"$TMP_DIR/unverified-test.out" 2>&1 <<EOF; then
refs/heads/topic $LOCAL_SHA refs/heads/topic $REMOTE_SHA
EOF
    echo "Expected a push without AI_VERIFIED=1 to be blocked."
    exit 1
fi

if [ -s "$CALL_LOG" ]; then
    echo "Expected a push without AI_VERIFIED=1 to skip every pre-push check."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -q 'AI_VERIFIED=1 git push' "$TMP_DIR/unverified-test.out"; then
    echo "Expected an unverified push to print the verified push command."
    cat "$TMP_DIR/unverified-test.out"
    exit 1
fi

if ! grep -q 'Documentation reminders' "$TMP_DIR/unverified-test.out"; then
    echo "Expected an unverified push to show documentation reminders."
    cat "$TMP_DIR/unverified-test.out"
    exit 1
fi

if grep -q 'Running Quality Checks' "$TMP_DIR/unverified-test.out"; then
    echo "Expected an unverified push to stop before quality checks."
    cat "$TMP_DIR/unverified-test.out"
    exit 1
fi

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

ensure_frontend_node_modules() {
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        mkdir "$PROJECT_ROOT/node_modules"
        ROOT_NODE_MODULES_CREATED=1
    fi

    if [ ! -d "$PROJECT_ROOT/frontend/node_modules" ]; then
        mkdir "$PROJECT_ROOT/frontend/node_modules"
        FRONTEND_NODE_MODULES_CREATED=1
    fi
}

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

if ! grep -qE '^pnpm --filter wework exec eslint src/features/workbench/WorkbenchProvider.test.tsx src/features/workbench/runtimeModelSelection.test.ts src/features/workbench/runtimeModelSelection.ts$' "$CALL_LOG"; then
    echo "Expected Wework changes to lint only changed TypeScript files."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if grep -qE '^pnpm --filter wework lint$' "$CALL_LOG"; then
    echo "Expected ordinary Wework changes to avoid the full lint suite."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE '^pnpm --filter wework exec vitest run --pool=threads --maxWorkers 2 src/features/workbench/WorkbenchProvider.test.tsx src/features/workbench/runtimeModelSelection.test.ts$' "$CALL_LOG"; then
    echo "Expected renderer source changes to run changed and sibling test files."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if grep -qE '^pnpm --filter wework test$' "$CALL_LOG"; then
    echo "Expected renderer source changes to avoid the full Wework test suite."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE 'Running focused renderer unit tests with 2 workers' "$WEWORK_TEST_OUT"; then
    echo "Expected focused Wework pre-push tests to use two workers by default."
    cat "$WEWORK_TEST_OUT"
    exit 1
fi

assert_renderer_tests_follow_static_checks

: > "$CALL_LOG"

# Build a synthetic commit changing renderer-wide Vitest configuration. Full
# renderer checks must stay inside src/ so Electron tests remain package-owned.
WEWORK_FULL_BASE_SHA=$(git rev-parse HEAD)
WEWORK_FULL_FIXTURE="$TMP_DIR/vite.config.ts.fixture"
cp "$PROJECT_ROOT/wework/vite.config.ts" "$WEWORK_FULL_FIXTURE"
printf '\n' >> "$WEWORK_FULL_FIXTURE"
WEWORK_FULL_BLOB=$(git hash-object -w "$WEWORK_FULL_FIXTURE")
WEWORK_FULL_INDEX="$TMP_DIR/wework-full.index"
GIT_INDEX_FILE="$WEWORK_FULL_INDEX" git read-tree "$WEWORK_FULL_BASE_SHA"
GIT_INDEX_FILE="$WEWORK_FULL_INDEX" git update-index --cacheinfo \
    100644 "$WEWORK_FULL_BLOB" wework/vite.config.ts
WEWORK_FULL_TREE=$(GIT_INDEX_FILE="$WEWORK_FULL_INDEX" git write-tree)
WEWORK_FULL_LOCAL_SHA=$(printf 'full renderer pre-push fixture\n' |
    git commit-tree "$WEWORK_FULL_TREE" -p "$WEWORK_FULL_BASE_SHA")

AI_VERIFIED=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$WEWORK_FULL_TEST_OUT" 2>&1
refs/heads/topic $WEWORK_FULL_LOCAL_SHA refs/heads/topic $WEWORK_FULL_BASE_SHA
EOF

if ! grep -qE '^pnpm --filter wework exec vitest run --dir src --pool=threads --maxWorkers 1 --testTimeout 15000 --shard=1/2$' "$CALL_LOG" ||
    ! grep -qE '^pnpm --filter wework exec vitest run --dir src --pool=threads --maxWorkers 1 --testTimeout 15000 --shard=2/2$' "$CALL_LOG"; then
    echo "Expected full renderer tests to exclude Electron-owned test files and use two shards."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE 'Running full renderer unit tests in 2 shards with 1 worker each' "$WEWORK_FULL_TEST_OUT"; then
    echo "Expected full Wework renderer tests to stay within two workers across both shards."
    cat "$WEWORK_FULL_TEST_OUT"
    exit 1
fi

assert_renderer_tests_follow_static_checks

: > "$CALL_LOG"

# Build an unreferenced synthetic commit that changes only Electron host code.
# This keeps the regression fixture independent from repository history without
# modifying the working tree or creating a branch.
ELECTRON_BASE_SHA=$(git rev-parse HEAD)
ELECTRON_FIXTURE_FILE="$TMP_DIR/pre-push-scope-fixture.ts"
cat > "$ELECTRON_FIXTURE_FILE" <<'EOF'
export const prePushScopeFixture = true
EOF
ELECTRON_FIXTURE_BLOB=$(git hash-object -w "$ELECTRON_FIXTURE_FILE")
ELECTRON_INDEX="$TMP_DIR/electron.index"
GIT_INDEX_FILE="$ELECTRON_INDEX" git read-tree "$ELECTRON_BASE_SHA"
GIT_INDEX_FILE="$ELECTRON_INDEX" git update-index --add --cacheinfo \
    100644 "$ELECTRON_FIXTURE_BLOB" wework/electron/src/pre-push-scope-fixture.ts
GIT_INDEX_FILE="$ELECTRON_INDEX" git update-index --add --cacheinfo \
    100644 "$ELECTRON_FIXTURE_BLOB" wework/e2e/desktop/pre-push-scope-fixture.mjs
ELECTRON_TREE=$(GIT_INDEX_FILE="$ELECTRON_INDEX" git write-tree)
ELECTRON_LOCAL_SHA=$(printf 'electron pre-push fixture\n' |
    git commit-tree "$ELECTRON_TREE" -p "$ELECTRON_BASE_SHA")

AI_VERIFIED=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$WEWORK_ELECTRON_TEST_OUT" 2>&1
refs/heads/topic $ELECTRON_LOCAL_SHA refs/heads/topic $ELECTRON_BASE_SHA
EOF

if ! grep -qE '^pnpm --filter wework run prepare:electron$' "$CALL_LOG"; then
    echo "Expected Electron changes to prepare the Electron package."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE '^pnpm --dir wework/electron typecheck$' "$CALL_LOG" ||
    ! grep -qE '^pnpm --dir wework/electron test --maxWorkers 2$' "$CALL_LOG"; then
    echo "Expected Electron changes to run Electron-owned checks."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if grep -qE '^pnpm --filter wework (typecheck|test)$|^pnpm --filter wework exec vitest ' "$CALL_LOG"; then
    echo "Expected Electron-only changes to skip unrelated renderer checks."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

: > "$CALL_LOG"

# Build a merge-like synthetic commit containing Electron code, package metadata,
# and renderer files with direct tests. Package metadata must not promote these
# already-focused checks into the full renderer suite.
MIXED_BASE_SHA=$(git rev-parse HEAD)
MIXED_INDEX="$TMP_DIR/mixed.index"
GIT_INDEX_FILE="$MIXED_INDEX" git read-tree "$MIXED_BASE_SHA"
for source_file in \
    wework/package.json \
    wework/src/api/changeRequests.ts \
    wework/src/api/changeRequests.test.ts; do
    fixture_file="$TMP_DIR/$(basename "$source_file").fixture"
    cp "$PROJECT_ROOT/$source_file" "$fixture_file"
    printf '\n' >> "$fixture_file"
    fixture_blob=$(git hash-object -w "$fixture_file")
    GIT_INDEX_FILE="$MIXED_INDEX" git update-index --cacheinfo \
        100644 "$fixture_blob" "$source_file"
done
GIT_INDEX_FILE="$MIXED_INDEX" git update-index --add --cacheinfo \
    100644 "$ELECTRON_FIXTURE_BLOB" wework/electron/src/pre-push-mixed-fixture.ts
MIXED_TREE=$(GIT_INDEX_FILE="$MIXED_INDEX" git write-tree)
MIXED_LOCAL_SHA=$(printf 'mixed pre-push fixture\n' |
    git commit-tree "$MIXED_TREE" -p "$MIXED_BASE_SHA")

AI_VERIFIED=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$WEWORK_MIXED_TEST_OUT" 2>&1
refs/heads/topic $MIXED_LOCAL_SHA refs/heads/topic $MIXED_BASE_SHA
EOF

if ! grep -qE '^pnpm --filter wework exec vitest run --pool=threads --maxWorkers 2 src/api/changeRequests.test.ts$' "$CALL_LOG"; then
    echo "Expected merge-like Wework changes to run only the related renderer test."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE '^pnpm --filter wework lint$' "$CALL_LOG"; then
    echo "Expected Wework package metadata changes to run the full lint suite."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if grep -qE '^pnpm --filter wework test$' "$CALL_LOG"; then
    echo "Expected package metadata changes not to force the full renderer suite."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE '^pnpm --dir wework/electron test --maxWorkers 2$' "$CALL_LOG"; then
    echo "Expected merge-like Wework changes to retain Electron-owned tests."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

assert_renderer_tests_follow_static_checks

: > "$CALL_LOG"

# This range moved a Next.js route and verifies stale generated route types are
# refreshed before the frontend TypeScript check.
FRONTEND_REMOTE_SHA="1a08f48e8^"
FRONTEND_LOCAL_SHA="1a08f48e8"

ensure_frontend_node_modules

AI_VERIFIED=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$FRONTEND_TEST_OUT" 2>&1
refs/heads/topic $FRONTEND_LOCAL_SHA refs/heads/topic $FRONTEND_REMOTE_SHA
EOF

if ! grep -qE '^pnpm --filter wecode-ai-assistant run test --passWithNoTests --maxWorkers 2$' "$CALL_LOG"; then
    echo "Expected frontend pre-push tests to bound JSDOM concurrency to two workers."
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE '^pnpm --filter wecode-ai-assistant exec next typegen$' "$CALL_LOG"; then
    echo "Expected frontend changes to regenerate Next.js route types."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if ! grep -qE '^pnpm --filter wecode-ai-assistant exec tsc --noEmit$' "$CALL_LOG"; then
    echo "Expected frontend changes to run the TypeScript check after route type generation."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

: > "$CALL_LOG"

# This range includes executor changes. It verifies pre-push keeps Rust checks
# lightweight by default and reserves the full integration suite for opt-in runs.
EXECUTOR_REMOTE_SHA="f296d3881^"
EXECUTOR_LOCAL_SHA="f296d3881"

ensure_wework_node_modules

AI_VERIFIED=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$EXECUTOR_TEST_OUT" 2>&1
refs/heads/topic $EXECUTOR_LOCAL_SHA refs/heads/topic $EXECUTOR_REMOTE_SHA
EOF

if ! grep -qE '^cargo test --all-features --lib$' "$CALL_LOG"; then
    echo "Expected Executor changes to run the lightweight Rust library tests by default."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

if grep -qE '^cargo test --all-features$' "$CALL_LOG"; then
    echo "Expected Executor changes to skip the full Rust test suite by default."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

: > "$CALL_LOG"

AI_VERIFIED=1 \
AI_PUSH_FULL_TESTS=1 \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$EXECUTOR_FULL_TEST_OUT" 2>&1
refs/heads/topic $EXECUTOR_LOCAL_SHA refs/heads/topic $EXECUTOR_REMOTE_SHA
EOF

if ! grep -qE '^cargo test --all-features$' "$CALL_LOG"; then
    echo "Expected AI_PUSH_FULL_TESTS=1 to run the full Rust test suite."
    echo "Calls:"
    cat "$CALL_LOG"
    exit 1
fi

: > "$CALL_LOG"

AI_VERIFIED=1 \
PUSH_GATE_TEST_PLATFORM=Darwin \
PATH="$TMP_DIR/bin:$PATH" \
bash "$PROJECT_ROOT/scripts/hooks/ai-push-gate.sh" <<EOF >"$TMP_DIR/macos-sleep.out" 2>&1
refs/heads/topic $LOCAL_SHA refs/heads/topic $REMOTE_SHA
EOF

if ! grep -qE '^caffeinate -is -w [0-9]+$' "$CALL_LOG"; then
    echo "Expected macOS checks to hold a sleep assertion for the hook lifetime."
    cat "$CALL_LOG"
    exit 1
fi

node --test "$SCRIPT_DIR/serialized-push-gate.test.mjs"

echo "ai-push-gate regression tests passed"
