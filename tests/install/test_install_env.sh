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
        export WEGENT_BIN_DIR="$tmp_dir/bin"
        export WEGENT_HOST_EXECUTOR_HOME="$tmp_dir/host-executor"
        export WEGENT_STANDALONE_STATE_FILE="$tmp_dir/standalone/config.env"
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

test_standard_compose_accepts_wegent_image_tag() {
    local compose_json

    compose_json="$(
        cd "$REPO_ROOT"
        WEGENT_IMAGE_TAG=edge INTERNAL_SERVICE_TOKEN=dummy \
            docker compose --profile rag -f docker-compose.yml config --format json
    )"

    python3 - "$compose_json" <<'PY'
import json
import sys

config = json.loads(sys.argv[1])
expected_images = {
    "backend": "ghcr.io/wecode-ai/wegent-backend:edge",
    "frontend": "ghcr.io/wecode-ai/wegent-web:edge",
    "chat_shell": "ghcr.io/wecode-ai/wegent-chat-shell:edge",
    "executor_manager": "ghcr.io/wecode-ai/wegent-executor-manager:edge",
    "knowledge_runtime": "ghcr.io/wecode-ai/wegent-knowledge-runtime:edge",
    "knowledge_doc_converter": "ghcr.io/wecode-ai/wegent-knowledge-doc-converter:edge",
}

services = config.get("services", {})
for service_name, expected_image in expected_images.items():
    actual_image = services.get(service_name, {}).get("image")
    if actual_image != expected_image:
        print(f"{service_name} image = {actual_image!r}, expected {expected_image!r}")
        sys.exit(1)

executor_env = services.get("executor_manager", {}).get("environment", {})
executor_image = executor_env.get("EXECUTOR_IMAGE")
expected_executor_image = "ghcr.io/wecode-ai/wegent-executor:edge"
if executor_image != expected_executor_image:
    print(f"EXECUTOR_IMAGE = {executor_image!r}, expected {expected_executor_image!r}")
    sys.exit(1)
PY
}

test_standalone_accepts_wegent_image_tag() {
    WEGENT_IMAGE_TAG=edge source_installer_without_main

    [[ "$STANDALONE_IMAGE" == "ghcr.io/wecode-ai/wegent-standalone:edge" ]]
}

test_standalone_image_override_takes_precedence_over_tag() {
    WEGENT_IMAGE_TAG=edge \
        WEGENT_STANDALONE_IMAGE=example.test/wegent-standalone:test \
        source_installer_without_main

    [[ "$STANDALONE_IMAGE" == "example.test/wegent-standalone:test" ]]
}

test_parse_args_accepts_edge_shortcut() {
    source_installer_without_main

    IMAGE_TAG="latest"
    STANDALONE_IMAGE="ghcr.io/wecode-ai/wegent-standalone:latest"

    parse_args --edge
    resolve_image_config

    [[ "$IMAGE_TAG" == "edge" ]]
    [[ "$STANDALONE_IMAGE" == "ghcr.io/wecode-ai/wegent-standalone:edge" ]]
}

test_parse_args_accepts_image_tag_value() {
    source_installer_without_main

    IMAGE_TAG="latest"
    STANDALONE_IMAGE="ghcr.io/wecode-ai/wegent-standalone:latest"

    parse_args --image-tag edge
    resolve_image_config

    [[ "$IMAGE_TAG" == "edge" ]]
    [[ "$STANDALONE_IMAGE" == "ghcr.io/wecode-ai/wegent-standalone:edge" ]]
}

test_image_tag_rejects_invalid_value() {
    if (
        source_installer_without_main
        IMAGE_TAG="bad tag"
        resolve_image_config
    ) >/tmp/wegent-invalid-image-tag.out 2>&1; then
        cat /tmp/wegent-invalid-image-tag.out
        return 1
    fi

    grep -q "Invalid image tag" /tmp/wegent-invalid-image-tag.out
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

test_executor_mode_default_function_prefers_host_for_interactive_macos() {
    source_installer_without_main

    NO_PROMPT="0"
    OS="macos"

    [[ "$(default_standalone_executor_mode)" == "host" ]]
}

test_executor_mode_defaults_to_container_for_non_interactive() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE=""
    WEGENT_STANDALONE_EXECUTOR_MODE=""
    NO_PROMPT="1"
    OS="macos"

    select_standalone_executor_mode >/dev/null

    [[ "$STANDALONE_EXECUTOR_MODE" == "container" ]]
}

test_executor_mode_accepts_explicit_hybrid_env() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE=""
    WEGENT_STANDALONE_EXECUTOR_MODE="hybrid"
    NO_PROMPT="1"
    OS="linux"

    select_standalone_executor_mode >/dev/null

    [[ "$STANDALONE_EXECUTOR_MODE" == "hybrid" ]]
}

test_executor_mode_rejects_invalid_value() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE="invalid"
    NO_PROMPT="1"
    OS="linux"

    if select_standalone_executor_mode >/tmp/wegent-invalid-mode.out 2>&1; then
        cat /tmp/wegent-invalid-mode.out
        return 1
    fi

    grep -q "Invalid standalone executor mode" /tmp/wegent-invalid-mode.out
}

test_executor_mode_reuses_persisted_mode_for_non_interactive_start() {
    source_installer_without_main

    local tmp_state_dir
    tmp_state_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_state_dir"' RETURN

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE=""
    WEGENT_STANDALONE_EXECUTOR_MODE=""
    NO_PROMPT="1"
    OS="macos"
    STANDALONE_STATE_FILE="${tmp_state_dir}/standalone.env"

    cat > "$STANDALONE_STATE_FILE" <<'EOF'
STANDALONE_EXECUTOR_MODE=host
STANDALONE_IMAGE=ghcr.io/wecode-ai/wegent-standalone:latest
STANDALONE_CONTAINER_NAME=wegent-standalone
EOF

    select_standalone_executor_mode >/tmp/wegent-persisted-mode.out

    [[ "$STANDALONE_EXECUTOR_MODE" == "host" ]]
    grep -q "Using previously selected standalone executor mode: host" \
        /tmp/wegent-persisted-mode.out
}

test_standalone_dry_run_recreates_existing_container_for_host_mode() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE="host"
    DRY_RUN="1"
    NO_PROMPT="1"
    SOCKET_URL="http://localhost:8000"
    ACCESS_HOST="localhost"

    docker() {
        case "$*" in
            "ps -a --format {{.Names}}")
                echo "wegent-standalone"
                ;;
            "ps --format {{.Names}}")
                echo "wegent-standalone"
                ;;
            "inspect --format {{range .Config.Env}}{{println .}}{{end}} wegent-standalone")
                echo "STANDALONE_EXECUTOR_ENABLED=true"
                ;;
            "volume ls --format {{.Name}}")
                echo "wegent-data"
                echo "wegent-workspace"
                ;;
            *)
                echo "unexpected docker command: $*" >&2
                return 1
                ;;
        esac
    }

    start_standalone_service >/tmp/wegent-host-recreate.out

    grep -q "Selected executor mode changes container executor setting from true to false" \
        /tmp/wegent-host-recreate.out
    grep -q "\\[DRY RUN\\] Would remove existing container: wegent-standalone" \
        /tmp/wegent-host-recreate.out
    grep -q -- "-e STANDALONE_EXECUTOR_ENABLED=false" /tmp/wegent-host-recreate.out
}

test_standalone_dry_run_recreates_existing_container_for_image_change() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE="container"
    STANDALONE_IMAGE="ghcr.io/wecode-ai/wegent-standalone:edge"
    DRY_RUN="1"
    NO_PROMPT="1"
    SOCKET_URL="http://localhost:8000"
    ACCESS_HOST="localhost"

    docker() {
        case "$*" in
            "ps -a --format {{.Names}}")
                echo "wegent-standalone"
                ;;
            "ps --format {{.Names}}")
                echo "wegent-standalone"
                ;;
            "inspect --format {{range .Config.Env}}{{println .}}{{end}} wegent-standalone")
                echo "STANDALONE_EXECUTOR_ENABLED=true"
                ;;
            "inspect --format {{.Config.Image}} wegent-standalone")
                echo "ghcr.io/wecode-ai/wegent-standalone:latest"
                ;;
            "volume ls --format {{.Name}}")
                echo "wegent-data"
                echo "wegent-workspace"
                ;;
            *)
                echo "unexpected docker command: $*" >&2
                return 1
                ;;
        esac
    }

    start_standalone_service >/tmp/wegent-image-recreate.out

    grep -q "Selected image changes container image from ghcr.io/wecode-ai/wegent-standalone:latest to ghcr.io/wecode-ai/wegent-standalone:edge" \
        /tmp/wegent-image-recreate.out
    grep -q "\\[DRY RUN\\] Would remove existing container: wegent-standalone" \
        /tmp/wegent-image-recreate.out
    grep -q "\\[DRY RUN\\] Would run: docker pull ghcr.io/wecode-ai/wegent-standalone:edge" \
        /tmp/wegent-image-recreate.out
    grep -q "ghcr.io/wecode-ai/wegent-standalone:edge" \
        /tmp/wegent-image-recreate.out
}

test_standalone_starts_existing_stopped_container_without_recreating() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE="host"
    DRY_RUN="0"
    NO_PROMPT="1"
    SOCKET_URL="http://localhost:8000"
    ACCESS_HOST="localhost"

    docker() {
        case "$*" in
            "ps -a --format {{.Names}}")
                echo "wegent-standalone"
                ;;
            "ps --format {{.Names}}")
                ;;
            "inspect --format {{range .Config.Env}}{{println .}}{{end}} wegent-standalone")
                echo "STANDALONE_EXECUTOR_ENABLED=false"
                ;;
            "start wegent-standalone")
                echo "wegent-standalone"
                ;;
            *)
                echo "unexpected docker command: $*" >&2
                return 1
                ;;
        esac
    }

    start_standalone_service >/tmp/wegent-start-existing.out

    grep -q "Starting existing container" /tmp/wegent-start-existing.out
    grep -q "Container started" /tmp/wegent-start-existing.out
}

test_standalone_pull_progress_is_visible() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE="container"
    STANDALONE_IMAGE="example.test/wegent:latest"
    STANDALONE_CONTAINER_NAME="wegent-standalone"
    STANDALONE_VOLUME_NAME="wegent-data"
    STANDALONE_WORKSPACE_VOLUME_NAME="wegent-workspace"
    DRY_RUN="0"
    NO_PROMPT="1"
    SOCKET_URL="http://localhost:8000"
    ACCESS_HOST="localhost"

    docker() {
        case "$*" in
            "ps -a --format {{.Names}}")
                ;;
            "pull example.test/wegent:latest")
                echo "layer-a: Downloading [====>      ] 12.3MB/45.6MB"
                ;;
            "volume ls --format {{.Name}}")
                ;;
            "volume create wegent-data")
                echo "wegent-data"
                ;;
            "volume create wegent-workspace")
                echo "wegent-workspace"
                ;;
            "run -d --name wegent-standalone "*)
                echo "container-id"
                ;;
            *)
                echo "unexpected docker command: $*" >&2
                return 1
                ;;
        esac
    }

    start_standalone_service >/tmp/wegent-pull-progress.out

    grep -Fq "layer-a: Downloading [====>      ] 12.3MB/45.6MB" \
        /tmp/wegent-pull-progress.out
}

test_standalone_installs_management_command() {
    source_installer_without_main

    local tmp_state_dir tmp_bin_dir
    tmp_state_dir="$(mktemp -d)"
    tmp_bin_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_state_dir" "$tmp_bin_dir"' RETURN

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE="host"
    STANDALONE_IMAGE="example.test/wegent:latest"
    STANDALONE_CONTAINER_NAME="wegent-standalone"
    STANDALONE_VOLUME_NAME="wegent-data"
    STANDALONE_WORKSPACE_VOLUME_NAME="wegent-workspace"
    STANDALONE_STATE_FILE="${tmp_state_dir}/config.env"
    STANDALONE_COMMAND_PATH="${tmp_bin_dir}/wegent-standalone"
    HOST_EXECUTOR_HOME="${tmp_state_dir}/executor"
    HOST_EXECUTOR_BINARY="${HOST_EXECUTOR_HOME}/bin/wegent-executor"
    HOST_EXECUTOR_PID_FILE="${HOST_EXECUTOR_HOME}/wegent-executor.pid"
    HOST_EXECUTOR_LOG_FILE="${HOST_EXECUTOR_HOME}/logs/standalone-host-executor.log"
    HOST_EXECUTOR_INSTALL_URL="https://example.test/local_executor_install.sh"
    ACCESS_HOST="localhost"
    DRY_RUN="0"

    write_standalone_state >/tmp/wegent-write-state.out
    install_standalone_command >/tmp/wegent-install-command.out

    grep -q '^STANDALONE_EXECUTOR_MODE=host$' "$STANDALONE_STATE_FILE"
    grep -Fq 'STANDALONE_IMAGE=example.test/wegent:latest' "$STANDALONE_STATE_FILE"
    [[ -x "$STANDALONE_COMMAND_PATH" ]]
    grep -q "STATE_FILE=" "$STANDALONE_COMMAND_PATH"
    grep -q "start_host_executor" "$STANDALONE_COMMAND_PATH"
    grep -q "current_container_image" "$STANDALONE_COMMAND_PATH"
    grep -q "apply image" "$STANDALONE_COMMAND_PATH"
    grep -Fq 'case "${1:-start}"' "$STANDALONE_COMMAND_PATH"
    bash -n "$STANDALONE_COMMAND_PATH"
}

test_standalone_completion_mentions_management_command() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE="host"
    STANDALONE_COMMAND_PATH="/tmp/wegent-standalone-test"
    STANDALONE_CONTAINER_NAME="wegent-standalone"
    STANDALONE_VOLUME_NAME="wegent-data"
    STANDALONE_WORKSPACE_VOLUME_NAME="wegent-workspace"
    HOST_EXECUTOR_BINARY="/tmp/wegent-executor"
    ACCESS_HOST="localhost"

    print_completion >/tmp/wegent-completion.out

    grep -q "Management command" /tmp/wegent-completion.out
    grep -q "/tmp/wegent-standalone-test status" /tmp/wegent-completion.out
    grep -q "/tmp/wegent-standalone-test start" /tmp/wegent-completion.out
    grep -q "/tmp/wegent-standalone-test logs host" /tmp/wegent-completion.out
    if grep -q "docker start wegent-standalone" /tmp/wegent-completion.out; then
        echo "standalone completion should prefer the management command over docker start"
        return 1
    fi
}

test_standalone_uses_nginx_single_browser_port() {
    local dockerfile="$REPO_ROOT/docker/standalone/Dockerfile"
    local startup="$REPO_ROOT/docker/standalone/start.sh"
    local installer="$REPO_ROOT/install.sh"
    local build_script="$REPO_ROOT/scripts/build-standalone.sh"

    grep -q "nginx" "$dockerfile"
    grep -q "docker/standalone/nginx.conf" "$dockerfile"
    grep -q "^EXPOSE 3000$" "$dockerfile"

    grep -q "WEWORK_PUBLIC_APP_BASE_PATH=.*:-/wework" "$startup"
    grep -q "WEWORK_PUBLIC_API_URL=.*:-/wework/api" "$startup"
    grep -q "WEWORK_PUBLIC_SOCKET_PATH=.*:-/wework/socket.io" "$startup"
    grep -q "RUNTIME_WEWORK_CODE_URL=.*:-/wework" "$startup"
    grep -q "nginx" "$startup"

    grep -q -- "-p 3000:3000" "$installer"
    if grep -q -- "-p 3001:3001" "$installer"; then
        echo "standalone installer must not expose Wework on a separate port"
        return 1
    fi
    if grep -q -- "-p 8000:8000" "$installer"; then
        echo "standalone installer must not expose Backend on a separate browser port"
        return 1
    fi
    grep -q "RUNTIME_SOCKET_DIRECT_URL=http://\${ACCESS_HOST}:3000" "$installer"
    grep -q "RUNTIME_WEWORK_CODE_URL=http://\${ACCESS_HOST}:3000/wework" "$installer"
    grep -q "WEWORK_PUBLIC_APP_BASE_PATH=/wework" "$installer"
    grep -q "WEWORK_PUBLIC_API_URL=/wework/api" "$installer"
    grep -q "WEWORK_PUBLIC_SOCKET_PATH=/wework/socket.io" "$installer"

    if grep -q -- "-p 3001:3001" "$build_script"; then
        echo "standalone build script must not print the old Wework port"
        return 1
    fi
    if grep -q -- "-p 8000:8000" "$build_script"; then
        echo "standalone build script must not print the old Backend port"
        return 1
    fi
    grep -q "RUNTIME_WEWORK_CODE_URL=http://localhost:3000/wework" "$build_script"
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

run_test "executor mode default function prefers host for interactive macOS" \
    test_executor_mode_default_function_prefers_host_for_interactive_macos
run_test "executor mode defaults to container for non-interactive" \
    test_executor_mode_defaults_to_container_for_non_interactive
run_test "executor mode accepts explicit hybrid env" \
    test_executor_mode_accepts_explicit_hybrid_env
run_test "executor mode rejects invalid value" \
    test_executor_mode_rejects_invalid_value
run_test "executor mode reuses persisted mode for non-interactive start" \
    test_executor_mode_reuses_persisted_mode_for_non_interactive_start
run_test "standalone dry-run recreates existing container for host mode" \
    test_standalone_dry_run_recreates_existing_container_for_host_mode
run_test "standalone dry-run recreates existing container for image change" \
    test_standalone_dry_run_recreates_existing_container_for_image_change
run_test "standalone starts existing stopped container without recreating" \
    test_standalone_starts_existing_stopped_container_without_recreating
run_test "standalone pull progress is visible" \
    test_standalone_pull_progress_is_visible
run_test "standalone installs management command" \
    test_standalone_installs_management_command
run_test "standalone completion mentions management command" \
    test_standalone_completion_mentions_management_command
run_test "new standard .env includes internal service token" \
    test_new_standard_env_includes_internal_service_token
run_test "existing standard .env backfills internal service token" \
    test_existing_standard_env_backfills_internal_service_token
run_test "standard compose uses prebuilt images only" \
    test_standard_compose_uses_prebuilt_images_only
run_test "default standard compose keeps RAG services optional" \
    test_default_standard_compose_keeps_rag_services_optional
run_test "standard compose accepts WEGENT_IMAGE_TAG" \
    test_standard_compose_accepts_wegent_image_tag
run_test "standalone accepts WEGENT_IMAGE_TAG" \
    test_standalone_accepts_wegent_image_tag
run_test "standalone image override takes precedence over tag" \
    test_standalone_image_override_takes_precedence_over_tag
run_test "parse args accepts edge shortcut" \
    test_parse_args_accepts_edge_shortcut
run_test "parse args accepts image tag value" \
    test_parse_args_accepts_image_tag_value
run_test "image tag rejects invalid value" \
    test_image_tag_rejects_invalid_value
run_test "knowledge service images are published" \
    test_knowledge_service_images_are_published
run_test "standalone uses nginx single browser port" \
    test_standalone_uses_nginx_single_browser_port
