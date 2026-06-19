# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for the standalone Wework launch path."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
STANDALONE_DOCKERFILE = REPO_ROOT / "docker" / "standalone" / "Dockerfile"
STANDALONE_START = REPO_ROOT / "docker" / "standalone" / "start.sh"
INSTALL_SCRIPT = REPO_ROOT / "install.sh"
BUILD_STANDALONE_SCRIPT = REPO_ROOT / "scripts" / "build-standalone.sh"
VERIFY_STANDALONE_SCRIPT = REPO_ROOT / "scripts" / "verify-standalone-image.sh"


def test_standalone_image_includes_wework_web_ttyd_and_workspace_volume() -> None:
    """Standalone image should expose Wework and terminal-ready workspace paths."""
    dockerfile = STANDALONE_DOCKERFILE.read_text(encoding="utf-8")

    assert "AS wework-builder" in dockerfile
    assert "pnpm install --frozen-lockfile --filter wework..." in dockerfile
    assert "pnpm run build" in dockerfile
    assert "COPY --from=wework-builder /app/wework/dist /app/wework/dist" in dockerfile
    assert "ttyd" in dockerfile
    assert "ENV WEWORK_PORT=3001" in dockerfile
    assert "ENV WEGENT_WORKSPACE_ROOT=/workspace" in dockerfile
    assert "EXPOSE 3000 3001 8000 7681 17888" in dockerfile
    assert 'VOLUME ["/app/data", "/workspace"]' in dockerfile


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


def test_standalone_start_serves_wework_and_ttyd() -> None:
    """Startup should serve Wework Web and provide terminal access in standalone."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert "start_wework" in start_script
    assert "WEWORK_PORT" in start_script
    assert "python3 -m http.server ${WEWORK_PORT}" in start_script
    assert "start_ttyd" in start_script
    assert "TTYD_PORT" in start_script
    assert "ttyd --writable -p ${TTYD_PORT}" in start_script
    assert 'wait_for_http "Wework" "http://localhost:${WEWORK_PORT}"' in start_script
    assert 'wait_for_http "Terminal" "http://localhost:${TTYD_PORT}"' in start_script


def test_standalone_start_writes_wework_runtime_config() -> None:
    """Wework static assets need runtime API/socket URLs for remote standalone access."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert "write_wework_runtime_config" in start_script
    assert "WEWORK_PUBLIC_BACKEND_URL" in start_script
    assert "WEWORK_PUBLIC_API_URL" in start_script
    assert "WEWORK_PUBLIC_SOCKET_URL" in start_script
    assert "/app/wework/dist/runtime-config.js" in start_script


def test_installer_exposes_wework_terminal_gateway_and_workspace_volume() -> None:
    """The public installer should start standalone with all user-facing ports."""
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert 'STANDALONE_WORKSPACE_VOLUME_NAME="wegent-workspace"' in install_script
    assert 'docker_run_cmd+=" -p 3001:3001"' in install_script
    assert 'docker_run_cmd+=" -p 7681:7681"' in install_script
    assert 'docker_run_cmd+=" -p 17888:17888"' in install_script
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
    assert (
        'docker_run_cmd+=" -e DEVICE_PUBLIC_BASE_URL=http://${ACCESS_HOST}:17888"'
        in install_script
    )


def test_build_script_outputs_complete_standalone_run_command() -> None:
    """The standalone build helper should print a runnable Wework-enabled command."""
    build_script = BUILD_STANDALONE_SCRIPT.read_text(encoding="utf-8")

    assert "-p 3000:3000 -p 3001:3001 -p 8000:8000" in build_script
    assert "-p 7681:7681 -p 17888:17888" in build_script
    assert "-v wegent-data:/app/data" in build_script
    assert "-v wegent-workspace:/workspace" in build_script


def test_verify_script_checks_wework_and_ttyd_readiness() -> None:
    """Published standalone images should be gated on Wework and terminal startup."""
    verify_script = VERIFY_STANDALONE_SCRIPT.read_text(encoding="utf-8")

    assert 'WEWORK_PORT="${WEWORK_PORT:-13001}"' in verify_script
    assert 'TTYD_PORT="${TTYD_PORT:-17681}"' in verify_script
    assert 'SESSION_GATEWAY_PORT="${SESSION_GATEWAY_PORT:-17888}"' in verify_script
    assert '-p "127.0.0.1:${WEWORK_PORT}:3001"' in verify_script
    assert '-p "127.0.0.1:${TTYD_PORT}:7681"' in verify_script
    assert '-p "127.0.0.1:${SESSION_GATEWAY_PORT}:17888"' in verify_script
    assert 'wait_for_url "Wework" "http://localhost:${WEWORK_PORT}/"' in verify_script
    assert 'wait_for_url "Terminal" "http://localhost:${TTYD_PORT}/"' in verify_script
