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

test_standard_compose_uses_prebuilt_images_only() {
    local compose_json

    compose_json="$(
        cd "$REPO_ROOT"
        INTERNAL_SERVICE_TOKEN=dummy docker compose --profile rag -f docker-compose.yml config --format json
    )"

    python3 - "$compose_json" <<'PY'
import json
import sys

config = json.loads(sys.argv[1])
services_with_build = sorted(
    name
    for name, service in config.get("services", {}).items()
    if "build" in service
)

if services_with_build:
    print(
        "standard docker-compose.yml must not require local build contexts: "
        + ", ".join(services_with_build)
    )
    sys.exit(1)
PY
}

test_default_standard_compose_keeps_rag_services_optional() {
    local compose_json

    compose_json="$(
        cd "$REPO_ROOT"
        INTERNAL_SERVICE_TOKEN=dummy docker compose -f docker-compose.yml config --format json
    )"

    python3 - "$compose_json" <<'PY'
import json
import sys

config = json.loads(sys.argv[1])
services = config.get("services", {})
default_rag_services = sorted(
    name
    for name in ("knowledge_runtime", "knowledge_doc_converter")
    if name in services
)

if default_rag_services:
    print(
        "default standard compose should keep RAG services behind a profile: "
        + ", ".join(default_rag_services)
    )
    sys.exit(1)
PY
}

test_knowledge_service_images_are_published() {
    local image_name
    local image_names=(
        "wegent-knowledge-runtime"
        "wegent-knowledge-doc-converter"
    )

    for image_name in "${image_names[@]}"; do
        grep -q "ghcr.io/wecode-ai/${image_name}:\${VERSION}" \
            "$REPO_ROOT/build_image.sh"
        grep -q "ghcr.io/wecode-ai/${image_name}:\${VERSION}" \
            "$REPO_ROOT/build_image_mac.sh"
        grep -q "create_manifest \"${image_name}\"" \
            "$REPO_ROOT/.github/workflows/publish-image.yml"
    done

    grep -q "file: docker/knowledge_runtime/Dockerfile" \
        "$REPO_ROOT/.github/workflows/publish-image.yml"
    grep -q "file: docker/knowledge_doc_converter/Dockerfile" \
        "$REPO_ROOT/.github/workflows/publish-image.yml"
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
run_test "standard compose uses prebuilt images only" \
    test_standard_compose_uses_prebuilt_images_only
run_test "default standard compose keeps RAG services optional" \
    test_default_standard_compose_keeps_rag_services_optional
run_test "knowledge service images are published" \
    test_knowledge_service_images_are_published
