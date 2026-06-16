#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source_installer_without_main() {
    local installer_copy
    installer_copy="$(mktemp)"
    sed '/^main "\$@"$/d' "$REPO_ROOT/install.sh" > "$installer_copy"
    # shellcheck disable=SC1090
    source "$installer_copy"
    rm -f "$installer_copy"
}

assert_internal_token_present() {
    local env_file="$1"
    local token_count
    token_count="$(grep -c '^INTERNAL_SERVICE_TOKEN=' "$env_file" || true)"

    if [[ "$token_count" != "1" ]]; then
        echo "expected exactly one INTERNAL_SERVICE_TOKEN entry, found $token_count"
        cat "$env_file"
        return 1
    fi

    if ! grep -Eq '^INTERNAL_SERVICE_TOKEN=[0-9a-f]{64}$' "$env_file"; then
        echo "expected INTERNAL_SERVICE_TOKEN to be a 64-character hex token"
        cat "$env_file"
        return 1
    fi
}

with_temp_dir() {
    local test_fn="$1"
    local tmp_dir
    local status
    tmp_dir="$(mktemp -d)"

    (
        cd "$tmp_dir"
        "$test_fn"
    )
    status=$?

    rm -rf "$tmp_dir"
    return "$status"
}

test_new_standard_env_includes_internal_service_token() {
    source_installer_without_main

    DEPLOY_MODE="standard"
    DRY_RUN="0"
    NO_PROMPT="1"
    OS="linux"

    configure_environment >/dev/null

    grep -q '^RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000$' .env
    assert_internal_token_present .env
}

test_existing_standard_env_backfills_internal_service_token() {
    source_installer_without_main

    cat > .env <<'EOF'
RUNTIME_SOCKET_DIRECT_URL=http://example.test:8000
EOF

    DEPLOY_MODE="standard"
    DRY_RUN="0"
    NO_PROMPT="1"
    OS="linux"

    configure_environment >/dev/null

    grep -q '^RUNTIME_SOCKET_DIRECT_URL=http://example.test:8000$' .env
    assert_internal_token_present .env
}

run_test() {
    local name="$1"
    local test_fn="$2"

    if with_temp_dir "$test_fn"; then
        printf 'ok - %s\n' "$name"
    else
        printf 'not ok - %s\n' "$name"
        return 1
    fi
}

run_test "new standard .env includes internal service token" \
    test_new_standard_env_includes_internal_service_token
run_test "existing standard .env backfills internal service token" \
    test_existing_standard_env_backfills_internal_service_token
