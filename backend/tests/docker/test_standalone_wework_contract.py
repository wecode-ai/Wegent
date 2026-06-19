# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for the standalone Wework launch path."""

from pathlib import Path

REPO_ROOT: Path = Path(__file__).resolve().parents[3]
STANDALONE_DOCKERFILE: Path = REPO_ROOT / "docker" / "standalone" / "Dockerfile"
STANDALONE_START: Path = REPO_ROOT / "docker" / "standalone" / "start.sh"
INSTALL_SCRIPT: Path = REPO_ROOT / "install.sh"
BUILD_STANDALONE_SCRIPT: Path = REPO_ROOT / "scripts" / "build-standalone.sh"
VERIFY_STANDALONE_SCRIPT: Path = REPO_ROOT / "scripts" / "verify-standalone-image.sh"


def test_standalone_image_includes_wework_executor_and_workspace_volume() -> None:
    """Standalone image should expose Wework, Backend, and workspace paths."""
    dockerfile = STANDALONE_DOCKERFILE.read_text(encoding="utf-8")

    assert "AS wework-builder" in dockerfile
    assert "pnpm install --frozen-lockfile --filter wework..." in dockerfile
    assert "pnpm run build" in dockerfile
    assert "COPY --from=wework-builder /app/wework/dist /app/wework/dist" in dockerfile
    assert "ttyd" not in dockerfile
    assert "ENV WEWORK_PORT=3001" in dockerfile
    assert "ENV WEGENT_WORKSPACE_ROOT=/workspace" in dockerfile
    assert "DEVICE_SESSION_GATEWAY_PORT" not in dockerfile
    assert "EXPOSE 3000 3001 8000" in dockerfile
    assert 'VOLUME ["/app/data", "/workspace"]' in dockerfile
    assert "http://localhost:7681" not in dockerfile


def test_standalone_start_registers_executor_as_admin_cloud_device() -> None:
    """Startup should launch a real executor registered through the device WebSocket."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert "ensure_standalone_executor_token" in start_script
    assert "app.scripts.ensure_standalone_executor_token" in start_script
    assert "start_executor" in start_script
    assert "EXECUTOR_MODE=local" in start_script
    assert "DEVICE_TYPE=cloud" in start_script
    assert "DEVICE_ID=standalone-admin-device" in start_script
    assert "WEGENT_AUTH_TOKEN" in start_script
    assert "WEGENT_BACKEND_URL=http://127.0.0.1:${BACKEND_PORT}" in start_script
    assert "WORKSPACE_ROOT=/workspace" in start_script
    assert "WEGENT_EXECUTOR_PROJECTS_DIR=/workspace/projects" in start_script
    assert "WEGENT_EXECUTOR_CHATS_DIR=/workspace/chats" in start_script
    assert "python -m executor.main" in start_script


def test_standalone_start_can_skip_container_executor() -> None:
    """Standalone startup should support host-only executor mode."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert 'STANDALONE_EXECUTOR_ENABLED="${STANDALONE_EXECUTOR_ENABLED:-true}"' in start_script
    assert 'if [ "$STANDALONE_EXECUTOR_ENABLED" != "false" ]; then' in start_script
    assert 'echo "[4/8] Skipping Standalone Executor' in start_script
    assert '${EXECUTOR_PID:-}' in start_script
    assert 'WAIT_PIDS=("$REDIS_PID" "$BACKEND_PID" "$FRONTEND_PID" "$WEWORK_PID")' in start_script
    assert 'if [ -n "${EXECUTOR_PID:-}" ]; then' in start_script


def test_standalone_start_serves_wework_without_public_ttyd() -> None:
    """Startup should serve Wework Web without a fixed public shell service."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert "start_wework" in start_script
    assert "WEWORK_PORT" in start_script
    assert "python3 -m http.server ${WEWORK_PORT}" in start_script
    assert "DEVICE_SESSION_GATEWAY_ENABLED=false" in start_script
    assert "DEVICE_SESSION_GATEWAY_HOST" not in start_script
    assert "DEVICE_SESSION_GATEWAY_PORT" not in start_script
    assert "DEVICE_PUBLIC_BASE_URL" not in start_script
    assert "start_ttyd" not in start_script
    assert "TTYD_PORT" not in start_script
    assert "TTYD_CREDENTIALS" not in start_script
    assert "ttyd --writable" not in start_script
    assert 'wait_for_http "Wework" "http://localhost:${WEWORK_PORT}"' in start_script
    assert "Terminal:" not in start_script


def test_standalone_start_uses_hardened_readiness_and_exit_status() -> None:
    """Startup should fail readiness on HTTP errors and preserve service exit code."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert 'curl -fsS --connect-timeout 2 --max-time 5 "$url"' in start_script
    assert 'shutdown "$EXIT_CODE"' in start_script
    assert 'exit "$exit_code"' in start_script


def test_standalone_start_writes_wework_runtime_config() -> None:
    """Wework static assets need runtime API/socket URLs for remote standalone access."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert "write_wework_runtime_config" in start_script
    assert "WEWORK_PUBLIC_BACKEND_URL" in start_script
    assert "WEWORK_PUBLIC_API_URL" in start_script
    assert "WEWORK_PUBLIC_SOCKET_URL" in start_script
    assert "/app/wework/dist/runtime-config.js" in start_script


def test_standalone_frontend_defaults_to_wework_url() -> None:
    """Standalone frontend should default coding entry points to bundled Wework."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert (
        "export RUNTIME_WEWORK_CODE_URL="
        '"${RUNTIME_WEWORK_CODE_URL:-http://localhost:${WEWORK_PORT}}"'
        in start_script
    )
    assert (
        'docker_run_cmd+=" -e RUNTIME_WEWORK_CODE_URL=http://${ACCESS_HOST}:3001"'
        in install_script
    )
    assert (
        "-e RUNTIME_WEWORK_CODE_URL=http://${ACCESS_HOST}:3001"
        in install_script
    )


def test_installer_exposes_wework_backend_and_workspace_volume() -> None:
    """The public installer should expose only browser-facing standalone ports."""
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert 'STANDALONE_WORKSPACE_VOLUME_NAME="wegent-workspace"' in install_script
    assert 'docker_run_cmd+=" -p 3001:3001"' in install_script
    assert 'docker_run_cmd+=" -p 8000:8000"' in install_script
    assert 'docker_run_cmd+=" -p 7681:7681"' not in install_script
    assert 'docker_run_cmd+=" -p 17888:17888"' not in install_script
    assert (
        'docker_run_cmd+=" -v ${STANDALONE_WORKSPACE_VOLUME_NAME}:/workspace"'
        in install_script
    )
    assert 'ui_kv "Wework URL" "http://${ACCESS_HOST}:3001"' in install_script
    assert (
        'ui_kv "Workspace volume" "$STANDALONE_WORKSPACE_VOLUME_NAME"' in install_script
    )
    assert (
        'docker_run_cmd+=" -e WEWORK_PUBLIC_BACKEND_URL=${SOCKET_URL}"'
        in install_script
    )
    assert "DEVICE_PUBLIC_BASE_URL=http://${ACCESS_HOST}:17888" not in install_script
    assert "TTYD_CREDENTIALS" not in install_script
    assert "WEGENT_TTYD_CREDENTIALS" not in install_script
    assert (
        "Open ${BLUE}${BOLD}http://${ACCESS_HOST}:3001${NC} for Wework"
        in install_script
    )
    assert 'if [[ "$DEPLOY_MODE" == "standalone" ]]; then' in install_script
    assert 'ui_kv "Terminal URL"' not in install_script


def test_installer_maps_executor_mode_to_container_env() -> None:
    """Installer should pass the correct container executor switch."""
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert "standalone_container_executor_enabled()" in install_script
    assert (
        'docker_run_cmd+=" -e STANDALONE_EXECUTOR_ENABLED=$(standalone_container_executor_enabled)"'
        in install_script
    )
    assert 'ui_kv "Executor mode" "$STANDALONE_EXECUTOR_MODE"' in install_script
    assert 'ui_kv "Host executor" "$HOST_EXECUTOR_BINARY"' in install_script


def test_build_script_outputs_complete_standalone_run_command() -> None:
    """The standalone build helper should print a runnable Wework-enabled command."""
    build_script = BUILD_STANDALONE_SCRIPT.read_text(encoding="utf-8")

    assert "-p 3000:3000 -p 3001:3001 -p 8000:8000" in build_script
    assert "-p 7681:7681" not in build_script
    assert "-p 17888:17888" not in build_script
    assert "-v wegent-data:/app/data" in build_script
    assert "-v wegent-workspace:/workspace" in build_script


def test_verify_script_checks_wework_readiness_without_terminal_ports() -> None:
    """Published standalone images should not expose direct terminal ports."""
    verify_script = VERIFY_STANDALONE_SCRIPT.read_text(encoding="utf-8")

    assert 'WEWORK_PORT="${WEWORK_PORT:-13001}"' in verify_script
    assert "TTYD_PORT" not in verify_script
    assert "SESSION_GATEWAY_PORT" not in verify_script
    assert "TTYD_CREDENTIALS" not in verify_script
    assert '-p "127.0.0.1:${WEWORK_PORT}:3001"' in verify_script
    assert ":7681" not in verify_script
    assert ":17888" not in verify_script
    assert 'wait_for_url "Wework" "http://localhost:${WEWORK_PORT}/"' in verify_script
