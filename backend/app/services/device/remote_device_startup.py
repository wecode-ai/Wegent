# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remote device startup command providers.

The default provider implements the open-source Docker onboarding behavior.
Internal distributions can replace it explicitly during application startup.
"""

import os
import re
import shlex
from dataclasses import dataclass, field
from typing import Dict, Literal, Protocol
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException, status

from app.core.config import settings
from app.schemas.device import DeviceType

DEFAULT_REMOTE_DEVICE_IMAGE = "ghcr.io/wecode-ai/wegent-device:latest"
DEFAULT_REMOTE_DEVICE_BACKEND_URL = ""
DEFAULT_REMOTE_DEVICE_PUBLIC_BASE_URL = "http://localhost:17888"
DEFAULT_REMOTE_DEVICE_EXECUTOR_INSTALL_URL = (
    "https://github.com/wecode-ai/Wegent/releases/latest/download/"
    "local_executor_install.sh"
)
DEVICE_SESSION_GATEWAY_PORT = 17888


@dataclass(frozen=True)
class RemoteDeviceCommandContext:
    """Inputs shared by remote device startup command providers."""

    container_name: str
    client_origin: str | None
    request_scheme: str
    request_netloc: str
    request_headers: Dict[str, str]
    device_id: str
    device_name: str
    auth_token: str


@dataclass(frozen=True)
class RemoteDeviceStartupCommandData:
    """One copy-ready startup command."""

    kind: Literal["docker", "process"]
    label: str
    command: str
    description: str | None = None


@dataclass(frozen=True)
class RemoteDeviceCommandResult:
    """Provider output mapped to the public API response."""

    image: str
    env: Dict[str, str]
    command: str
    commands: list[RemoteDeviceStartupCommandData] = field(default_factory=list)


class RemoteDeviceCommandProvider(Protocol):
    """Build startup commands for one newly authenticated remote device."""

    def build(self, context: RemoteDeviceCommandContext) -> RemoteDeviceCommandResult:
        """Return Docker and optional host-process startup commands."""


def _validate_generated_url(
    value: str,
    field_name: str,
    *,
    allowed_schemes: set[str],
) -> str:
    normalized = value.strip()
    if (
        not normalized
        or any(character in normalized for character in "<>{}")
        or re.search(r"\s", normalized)
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


def _validate_public_image(image: str) -> str:
    normalized = image.strip()
    if (
        not normalized
        or normalized.startswith("-")
        or re.search(r"[<>{}\s]", normalized)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="REMOTE_DEVICE_DOCKER_IMAGE must be a valid image reference",
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


def _build_process_start_command(env: Dict[str, str], install_url: str) -> str:
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


class DefaultRemoteDeviceCommandProvider:
    """Open-source remote device command policy."""

    def _get_backend_url(self, context: RemoteDeviceCommandContext) -> str:
        configured_url = os.getenv(
            "REMOTE_DEVICE_BACKEND_URL", DEFAULT_REMOTE_DEVICE_BACKEND_URL
        )
        if configured_url:
            return configured_url
        if settings.WEGENT_BACKEND_PUBLIC_URL:
            return settings.WEGENT_BACKEND_PUBLIC_URL
        host = context.request_headers.get("host", context.request_netloc)
        return f"{context.request_scheme}://{host}"

    def _absolute_url(
        self, value: str | None, context: RemoteDeviceCommandContext
    ) -> str | None:
        if not value or not value.strip():
            return None
        normalized = value.strip()
        parsed = urlparse(normalized)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return normalized
        if normalized.startswith("/"):
            return f"{self._get_backend_url(context).rstrip('/')}{normalized}"
        return None

    def _origin_from_headers(self, context: RemoteDeviceCommandContext) -> str | None:
        origin = context.request_headers.get("origin")
        if origin:
            return origin
        referer = context.request_headers.get("referer")
        if not referer:
            return None
        parsed = urlparse(referer)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
        return None

    def _resolve_public_base_url(self, context: RemoteDeviceCommandContext) -> str:
        candidate = (
            context.client_origin
            or self._origin_from_headers(context)
            or self._get_backend_url(context)
        )
        candidate = self._absolute_url(candidate, context) or self._get_backend_url(
            context
        )
        parsed = urlparse(candidate)
        host = parsed.hostname
        if not host or parsed.scheme not in {"http", "https"}:
            return DEFAULT_REMOTE_DEVICE_PUBLIC_BASE_URL
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return _validate_generated_url(
            f"http://{host}:{DEVICE_SESSION_GATEWAY_PORT}",
            "public_base_url",
            allowed_schemes={"http", "https"},
        )

    def build(self, context: RemoteDeviceCommandContext) -> RemoteDeviceCommandResult:
        image = _validate_public_image(
            os.getenv("REMOTE_DEVICE_DOCKER_IMAGE", DEFAULT_REMOTE_DEVICE_IMAGE)
        )
        backend_url = _validate_generated_url(
            _strip_api_suffix(self._get_backend_url(context)),
            "backend_url",
            allowed_schemes={"http", "https"},
        )
        socket_url = _validate_generated_url(
            settings.WEGENT_SOCKET_URL.strip() or backend_url,
            "socket_url",
            allowed_schemes={"http", "https", "ws", "wss"},
        )
        public_base_url = self._resolve_public_base_url(context)
        env = {
            "DEVICE_TYPE": DeviceType.REMOTE.value,
            "DEVICE_ID": context.device_id,
            "DEVICE_NAME": context.device_name,
            "EXECUTOR_MODE": "local",
            "DEVICE_CODE_SERVER_ENABLED": "true",
            "DEVICE_TERMINAL_ENABLED": "true",
            "WEGENT_EXECUTOR_HOME_ID": context.device_id,
            "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED": "true",
            "WEGENT_BACKEND_URL": backend_url,
            "WEGENT_SOCKET_URL": socket_url,
            "WEGENT_AUTH_TOKEN": context.auth_token,
            "DEVICE_PUBLIC_BASE_URL": public_base_url,
        }
        env_lines = [
            f"  -e {key}={shlex.quote(value)} \\" for key, value in env.items()
        ]
        lines = [
            "docker run -d \\",
            f"  --name {shlex.quote(context.container_name)} \\",
            "  --restart unless-stopped \\",
        ]
        if urlparse(backend_url).hostname == "host.docker.internal":
            lines.append("  --add-host host.docker.internal:host-gateway \\")
        lines.extend(
            [
                *env_lines,
                "  -p 17888:17888 \\",
                f"  -v {shlex.quote(context.container_name)}-home:/home/wegent/.wecode/wegent-executor \\",
                f"  {shlex.quote(image)}",
            ]
        )
        command = "\n".join(lines)
        process_env = {
            key: value
            for key, value in env.items()
            if key
            not in {
                "WEGENT_EXECUTOR_HOME_ID",
                "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED",
            }
        }
        process_command = _build_process_start_command(
            process_env,
            os.getenv(
                "REMOTE_DEVICE_EXECUTOR_INSTALL_URL",
                DEFAULT_REMOTE_DEVICE_EXECUTOR_INSTALL_URL,
            ),
        )
        return RemoteDeviceCommandResult(
            image=image,
            env=env,
            command=command,
            commands=[
                RemoteDeviceStartupCommandData(
                    kind="docker",
                    label="Docker",
                    description=(
                        "Run a managed container with the executor and session gateway."
                    ),
                    command=command,
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


_remote_device_command_provider: RemoteDeviceCommandProvider = (
    DefaultRemoteDeviceCommandProvider()
)


def register_remote_device_command_provider(
    provider: RemoteDeviceCommandProvider,
) -> None:
    """Replace the active command provider for this application process."""
    global _remote_device_command_provider
    _remote_device_command_provider = provider


def get_remote_device_command_provider() -> RemoteDeviceCommandProvider:
    """Return the explicitly configured command provider."""
    return _remote_device_command_provider
