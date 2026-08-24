# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal remote device startup command provider."""

import re
import shlex
from urllib.parse import unquote, urlparse, urlunparse

from fastapi import HTTPException, status

from app.core.config import settings
from app.schemas.device import DeviceType
from app.services.device.remote_device_startup import (
    RemoteDeviceCommandContext,
    RemoteDeviceCommandResult,
    RemoteDeviceStartupCommandData,
)
from wecode.config.remote_device_config import RemoteDeviceSettings


def _validate_url(
    value: str,
    field_name: str,
    *,
    allowed_schemes: set[str],
) -> str:
    normalized = value.strip()
    decoded = unquote(normalized)
    if (
        not normalized
        or any(character in decoded for character in "<>{}")
        or re.search(r"\s", decoded)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} must be a concrete URL, not a placeholder",
        )
    try:
        parsed = urlparse(normalized)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} is not a valid URL",
        ) from exc
    if parsed.scheme not in allowed_schemes or not hostname:
        schemes = ", ".join(sorted(allowed_schemes))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} must be an absolute URL using {schemes}",
        )
    if parsed.username or parsed.password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} must not contain user information",
        )
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} must not contain a path, query, or fragment",
        )
    return normalized.rstrip("/")


def _validate_image(image: str) -> str:
    normalized = image.strip()
    image_name = normalized.rsplit("/", 1)[-1]
    is_pinned = "@sha256:" in normalized or (
        ":" in image_name and not image_name.endswith(":latest")
    )
    if (
        not normalized
        or not normalized.startswith("registry.api.weibo.com/")
        or not is_pinned
        or re.search(r"[<>{}\s]", normalized)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "REMOTE_DEVICE_DOCKER_IMAGE must be a pinned internal registry image"
            ),
        )
    return normalized


def _strip_api_suffix(url: str) -> str:
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    if path == "/api":
        path = ""
    elif path.endswith("/api"):
        path = path[: -len("/api")]
    return urlunparse(
        parsed._replace(path=path, params="", query="", fragment="")
    ).rstrip("/")


def _build_docker_command(
    context: RemoteDeviceCommandContext,
    image: str,
    env: dict[str, str],
) -> str:
    env_lines = [f"  -e {key}={shlex.quote(value)} \\" for key, value in env.items()]
    lines = [
        "docker run -d \\",
        f"  --name {shlex.quote(context.container_name)} \\",
        "  --restart unless-stopped \\",
        "  --pull always \\",
        "  --network host \\",
        *env_lines,
        f"  -v {shlex.quote(context.container_name)}-home:/home/wegent/.wecode/wegent-executor \\",
        f"  {shlex.quote(image)}",
    ]
    return "\n".join(lines)


def _build_process_command(env: dict[str, str], install_url: str) -> str:
    env_lines = [f"export {key}={shlex.quote(value)}" for key, value in env.items()]
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        f"INSTALL_URL={shlex.quote(install_url.strip())}",
        'EXECUTOR_HOME="${WEGENT_EXECUTOR_HOME:-$HOME/.wegent-executor}"',
        'EXECUTOR_BIN="${WEGENT_EXECUTOR_BIN:-$EXECUTOR_HOME/bin/wegent-executor}"',
        'LOG_DIR="${WEGENT_EXECUTOR_LOG_DIR:-$EXECUTOR_HOME/logs}"',
        'mkdir -p "$LOG_DIR"',
        "",
        'if [ ! -x "$EXECUTOR_BIN" ]; then',
        "  if command -v curl >/dev/null 2>&1; then",
        '    curl -fsSL "$INSTALL_URL" | bash',
        "  elif command -v wget >/dev/null 2>&1; then",
        '    wget -qO- "$INSTALL_URL" | bash',
        "  else",
        '    echo "curl or wget is required to install wegent-executor." >&2',
        "    exit 1",
        "  fi",
        "fi",
        "",
        *env_lines,
        'export DEVICE_SESSION_GATEWAY_ENABLED="${DEVICE_SESSION_GATEWAY_ENABLED:-true}"',
        'export DEVICE_SESSION_GATEWAY_HOST="${DEVICE_SESSION_GATEWAY_HOST:-0.0.0.0}"',
        'export DEVICE_SESSION_GATEWAY_PORT="${DEVICE_SESSION_GATEWAY_PORT:-17888}"',
        'if [ -z "${DEVICE_PUBLIC_BASE_URL:-}" ]; then',
        "  DEVICE_HOST=\"$(hostname -I 2>/dev/null | awk '{print $1}')\"",
        '  export DEVICE_PUBLIC_BASE_URL="http://${DEVICE_HOST:-localhost}:${DEVICE_SESSION_GATEWAY_PORT}"',
        "fi",
        'export WEGENT_EXECUTOR_LOG_DIR="$LOG_DIR"',
        'export WEGENT_EXECUTOR_LOG_FILE="${WEGENT_EXECUTOR_LOG_FILE:-executor.log}"',
        "",
        'if ! command -v "$EXECUTOR_BIN" >/dev/null 2>&1 && [ ! -x "$EXECUTOR_BIN" ]; then',
        '  echo "wegent-executor not found after installation. Set WEGENT_EXECUTOR_BIN=/path/to/wegent-executor." >&2',
        "  exit 1",
        "fi",
        "",
        'nohup "$EXECUTOR_BIN" >>"$LOG_DIR/$WEGENT_EXECUTOR_LOG_FILE" 2>&1 &',
        'echo "wegent-executor started with PID $!"',
        'echo "Log: $LOG_DIR/$WEGENT_EXECUTOR_LOG_FILE"',
    ]
    return "\n".join(lines)


class WecodeRemoteDeviceCommandProvider:
    """Generate commands for the internal network and image registry."""

    def __init__(self, config: RemoteDeviceSettings) -> None:
        self._config = config

    def build(self, context: RemoteDeviceCommandContext) -> RemoteDeviceCommandResult:
        image = _validate_image(self._config.REMOTE_DEVICE_DOCKER_IMAGE)
        backend_url = _validate_url(
            _strip_api_suffix(settings.WEGENT_BACKEND_PUBLIC_URL),
            "backend_url",
            allowed_schemes={"http", "https"},
        )
        socket_url = _validate_url(
            settings.WEGENT_SOCKET_URL,
            "socket_url",
            allowed_schemes={"http", "https", "ws", "wss"},
        )
        env = {
            "DEVICE_TYPE": DeviceType.REMOTE.value,
            "DEVICE_ID": context.device_id,
            "DEVICE_NAME": context.device_name,
            "EXECUTOR_MODE": "local",
            "WEGENT_BACKEND_URL": backend_url,
            "WEGENT_SOCKET_URL": socket_url,
            "WEGENT_AUTH_TOKEN": context.auth_token,
            "DEVICE_SESSION_GATEWAY_HOST": "0.0.0.0",
            "DEVICE_SESSION_GATEWAY_PORT": "17888",
        }
        docker_command = _build_docker_command(context, image, env)
        process_command = _build_process_command(
            env,
            self._config.REMOTE_DEVICE_EXECUTOR_INSTALL_URL,
        )
        return RemoteDeviceCommandResult(
            image=image,
            env=env,
            command=docker_command,
            commands=[
                RemoteDeviceStartupCommandData(
                    kind="docker",
                    label="Docker",
                    description=(
                        "Run a managed container with the executor and session gateway."
                    ),
                    command=docker_command,
                ),
                RemoteDeviceStartupCommandData(
                    kind="process",
                    label="Process",
                    description=(
                        "Run an installed wegent-executor process directly on this machine."
                    ),
                    command=process_command,
                ),
            ],
        )
