# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for the standalone Wework launch path."""

from pathlib import Path

REPO_ROOT: Path = Path(__file__).resolve().parents[3]
STANDALONE_DOCKERFILE: Path = REPO_ROOT / "docker" / "standalone" / "Dockerfile"
STANDALONE_START: Path = REPO_ROOT / "docker" / "standalone" / "start.sh"
STANDALONE_NGINX_CONFIG: Path = REPO_ROOT / "docker" / "standalone" / "nginx.conf"
INSTALL_SCRIPT: Path = REPO_ROOT / "install.sh"
BUILD_STANDALONE_SCRIPT: Path = REPO_ROOT / "scripts" / "build-standalone.sh"
VERIFY_STANDALONE_SCRIPT: Path = REPO_ROOT / "scripts" / "verify-standalone-image.sh"


def test_standalone_image_includes_wework_executor_and_workspace_volume() -> None:
    """Standalone image should include Wework, executor, Nginx, and workspace paths."""
    dockerfile = STANDALONE_DOCKERFILE.read_text(encoding="utf-8")

    assert "AS wework-builder" in dockerfile
    assert "pnpm install --frozen-lockfile --filter wework..." in dockerfile
    assert "pnpm run build" in dockerfile
    assert "COPY --from=wework-builder /app/wework/dist /app/wework/dist" in dockerfile
    assert "nginx" in dockerfile
    assert (
        "COPY docker/standalone/nginx.conf /etc/nginx/conf.d/default.conf" in dockerfile
    )
    assert "ttyd" not in dockerfile
    assert "ENV WEWORK_PORT=3001" not in dockerfile
    assert "ENV WEGENT_WORKSPACE_ROOT=/workspace" in dockerfile
    assert "DEVICE_SESSION_GATEWAY_PORT" not in dockerfile
    assert "EXPOSE 3000" in dockerfile
    assert "EXPOSE 3000 3001 8000" not in dockerfile
    assert 'VOLUME ["/app/data", "/workspace"]' in dockerfile
    assert "http://localhost:7681" not in dockerfile
    assert "COPY executor /app/executor" not in dockerfile
    assert "cd /app/executor && uv pip install" not in dockerfile
    assert (
        "PYTHONPATH=/app:/app/backend:/app/chat_shell:/app/executor" not in dockerfile
    )


def test_standalone_image_installs_codex_runtime_dependencies() -> None:
    """Container executor needs both the Codex CLI and Python SDK in Linux."""
    dockerfile = STANDALONE_DOCKERFILE.read_text(encoding="utf-8")

    assert "@openai/codex@0.137.0" in dockerfile
    assert (
        "uv pip install --system --no-cache --no-deps openai-codex==0.1.0b3"
        in dockerfile
    )


def test_standalone_runtime_prepares_persistent_codex_home() -> None:
    """Codex SDK startup requires CODEX_HOME to point at an existing directory."""
    dockerfile = STANDALONE_DOCKERFILE.read_text(encoding="utf-8")
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert "ENV CODEX_HOME=/app/data/codex" in dockerfile
    assert 'export CODEX_HOME="${CODEX_HOME:-/app/data/codex}"' in start_script
    assert 'mkdir -p "$CODEX_HOME"' in start_script


def test_standalone_start_registers_executor_as_admin_cloud_device() -> None:
    """Startup should launch a real executor registered through the device WebSocket."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert "ensure_standalone_executor_token" in start_script
    assert "app.scripts.ensure_standalone_executor_token" in start_script
    assert "start_executor" in start_script
    assert "DEVICE_TYPE=cloud" in start_script
    assert (
        'STANDALONE_EXECUTOR_DEVICE_ID="${STANDALONE_EXECUTOR_DEVICE_ID:-standalone-admin-device}"'
        in start_script
    )
    assert 'DEVICE_ID="$STANDALONE_EXECUTOR_DEVICE_ID"' in start_script
    assert "WEGENT_AUTH_TOKEN" in start_script
    assert "WEGENT_BACKEND_URL=http://127.0.0.1:${BACKEND_PORT}" in start_script
    assert "EXECUTOR_STARTUP_MODE=socket" in start_script
    assert "WORKSPACE_ROOT=/workspace" in start_script
    assert "WEGENT_EXECUTOR_PROJECTS_DIR=/workspace/projects" in start_script
    assert "WEGENT_EXECUTOR_CHATS_DIR=/workspace/chats" in start_script
    assert "/app/wegent-executor" in start_script


def test_standalone_start_can_skip_container_executor() -> None:
    """Standalone startup should support host-only executor mode."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert (
        'STANDALONE_EXECUTOR_ENABLED="${STANDALONE_EXECUTOR_ENABLED:-true}"'
        in start_script
    )
    assert 'if [ "$STANDALONE_EXECUTOR_ENABLED" != "false" ]; then' in start_script
    assert 'echo "[4/8] Skipping Standalone Executor' in start_script
    assert "${EXECUTOR_PID:-}" in start_script
    assert (
        'WAIT_PIDS=("$REDIS_PID" "$BACKEND_PID" "$FRONTEND_PID" "$NGINX_PID")'
        in start_script
    )
    assert 'if [ -n "${EXECUTOR_PID:-}" ]; then' in start_script


def test_standalone_start_ensures_token_before_optional_executor() -> None:
    """Host-only mode still needs the standalone executor token for host setup."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    backend_ready_index = start_script.index(
        'wait_for_http "Backend" "http://localhost:${BACKEND_PORT}/health"'
    )
    token_ensure_index = start_script.index("\nensure_standalone_executor_token\n")
    executor_branch_index = start_script.index(
        'if [ "$STANDALONE_EXECUTOR_ENABLED" != "false" ]; then'
    )

    assert backend_ready_index < token_ensure_index < executor_branch_index


def test_standalone_nginx_routes_frontend_backend_and_wework() -> None:
    """Nginx should expose Frontend, Backend, and Wework through one public port."""
    nginx_config = STANDALONE_NGINX_CONFIG.read_text(encoding="utf-8")

    assert "listen 3000;" in nginx_config
    assert "listen 3001" not in nginx_config
    assert "listen 8000" not in nginx_config
    assert "upstream wegent_frontend" in nginx_config
    assert "server 127.0.0.1:3002;" in nginx_config
    assert "upstream wegent_backend" in nginx_config
    assert "server 127.0.0.1:8000;" in nginx_config
    assert "location = /health" in nginx_config
    assert "proxy_pass http://wegent_backend/health;" in nginx_config
    assert "location ^~ /wework/api/" in nginx_config
    assert "proxy_pass http://wegent_backend/api/;" in nginx_config
    assert "location ^~ /wework/socket.io/" in nginx_config
    assert "proxy_set_header Upgrade $http_upgrade;" in nginx_config
    assert "location ^~ /wework/" in nginx_config
    assert "alias /app/wework/dist/;" in nginx_config
    assert "try_files $uri $uri/ /wework/index.html;" in nginx_config
    assert "location / {" in nginx_config
    assert "proxy_pass http://wegent_frontend;" in nginx_config


def test_standalone_start_serves_wework_without_public_ttyd() -> None:
    """Startup should serve Wework through Nginx without a fixed public shell service."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert "start_nginx" in start_script
    assert "start_wework" not in start_script
    assert "write_wework_runtime_config" in start_script
    assert "nginx -t" in start_script
    assert 'nginx -g "daemon off;"' in start_script
    assert "WEWORK_PORT" not in start_script
    assert "python3 -m http.server" not in start_script
    assert "DEVICE_SESSION_GATEWAY_ENABLED=false" in start_script
    assert "DEVICE_SESSION_GATEWAY_HOST" not in start_script
    assert "DEVICE_SESSION_GATEWAY_PORT" not in start_script
    assert "DEVICE_PUBLIC_BASE_URL" not in start_script
    assert "start_ttyd" not in start_script
    assert "TTYD_PORT" not in start_script
    assert "TTYD_CREDENTIALS" not in start_script
    assert "ttyd --writable" not in start_script
    assert 'wait_for_http "Wework" "http://localhost:3000/wework/"' in start_script
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
        '"${RUNTIME_WEWORK_CODE_URL:-/wework}"' in start_script
    )
    assert (
        'docker_run_cmd+=" -e RUNTIME_WEWORK_CODE_URL=http://${ACCESS_HOST}:3000/wework"'
        in install_script
    )
    assert (
        "-e RUNTIME_WEWORK_CODE_URL=http://${ACCESS_HOST}:3000/wework" in install_script
    )


def test_installer_exposes_wework_backend_and_workspace_volume() -> None:
    """The public installer should expose one browser-facing standalone port."""
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert 'STANDALONE_WORKSPACE_VOLUME_NAME="wegent-workspace"' in install_script
    assert 'docker_run_cmd+=" -p 3000:3000"' in install_script
    assert 'docker_run_cmd+=" -p 3001:3001"' not in install_script
    assert 'docker_run_cmd+=" -p 8000:8000"' not in install_script
    assert 'docker_run_cmd+=" -p 7681:7681"' not in install_script
    assert 'docker_run_cmd+=" -p 17888:17888"' not in install_script
    assert (
        'docker_run_cmd+=" -v ${STANDALONE_WORKSPACE_VOLUME_NAME}:/workspace"'
        in install_script
    )
    assert 'ui_kv "Wework URL" "http://${ACCESS_HOST}:3000/wework"' in install_script
    assert (
        'ui_kv "Workspace volume" "$STANDALONE_WORKSPACE_VOLUME_NAME"' in install_script
    )
    assert (
        'docker_run_cmd+=" -e RUNTIME_PUBLIC_API_URL=http://${ACCESS_HOST}:3000/api"'
        in install_script
    )
    assert 'docker_run_cmd+=" -e WEWORK_PUBLIC_APP_BASE_PATH=/wework"' in install_script
    assert 'docker_run_cmd+=" -e WEWORK_PUBLIC_API_URL=/wework/api"' in install_script
    assert (
        'docker_run_cmd+=" -e WEWORK_PUBLIC_SOCKET_PATH=/wework/socket.io"'
        in install_script
    )
    assert "DEVICE_PUBLIC_BASE_URL=http://${ACCESS_HOST}:17888" not in install_script
    assert "TTYD_CREDENTIALS" not in install_script
    assert "WEGENT_TTYD_CREDENTIALS" not in install_script
    assert (
        "Open ${BLUE}${BOLD}http://${ACCESS_HOST}:3000/wework${NC} for Wework"
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


def test_installer_uses_release_installer_for_host_executor() -> None:
    """Host executor setup should download release artifacts, not build locally."""
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert "install_host_executor_from_release()" in install_script
    assert "HOST_EXECUTOR_INSTALL_URL" in install_script
    assert "local_executor_install.sh" in install_script
    assert 'curl -fsSL "$HOST_EXECUTOR_INSTALL_URL" | bash' in install_script


def test_installer_ensures_standalone_executor_token_when_reading_it() -> None:
    """Host executor setup should not depend on the container executor being enabled."""
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert (
        install_script.count("python -m app.scripts.ensure_standalone_executor_token")
        >= 2
    )
    assert "configure_host_executor()" in install_script
    assert '"backend_url": "http://127.0.0.1:3000"' in install_script
    assert "start_host_executor()" in install_script
    assert "setup_host_executor_if_needed()" in install_script
    assert "executor/.venv/bin/python executor/main.py" not in install_script
    assert "./local.sh all" not in install_script


def test_build_script_outputs_complete_standalone_run_command() -> None:
    """The standalone build helper should print a runnable Wework-enabled command."""
    build_script = BUILD_STANDALONE_SCRIPT.read_text(encoding="utf-8")

    assert "-p 3000:3000" in build_script
    assert "-p 3001:3001" not in build_script
    assert "-p 8000:8000" not in build_script
    assert "-p 7681:7681" not in build_script
    assert "-p 17888:17888" not in build_script
    assert "-v wegent-data:/app/data" in build_script
    assert "-v wegent-workspace:/workspace" in build_script
    assert "RUNTIME_WEWORK_CODE_URL=http://localhost:3000/wework" in build_script
    assert "WEWORK_PUBLIC_API_URL=/wework/api" in build_script


def test_verify_script_checks_wework_readiness_without_terminal_ports() -> None:
    """Published standalone images should not expose direct terminal ports."""
    verify_script = VERIFY_STANDALONE_SCRIPT.read_text(encoding="utf-8")

    assert 'STANDALONE_PORT="${STANDALONE_PORT:-13000}"' in verify_script
    assert "WEWORK_PORT" not in verify_script
    assert "TTYD_PORT" not in verify_script
    assert "SESSION_GATEWAY_PORT" not in verify_script
    assert "TTYD_CREDENTIALS" not in verify_script
    assert '-p "127.0.0.1:${STANDALONE_PORT}:3000"' in verify_script
    assert ":3001" not in verify_script
    assert ":8000" not in verify_script
    assert ":7681" not in verify_script
    assert ":17888" not in verify_script
    assert (
        'wait_for_url "Wework" "http://localhost:${STANDALONE_PORT}/wework/"'
        in verify_script
    )
