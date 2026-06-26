# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remote device onboarding endpoints."""

import logging
import os
import shlex
import uuid
from typing import Dict, Literal, Optional
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.user import User
from app.schemas.device import DeviceType
from app.services.api_key_service import create_api_key_for_remote_device

logger = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_REMOTE_DEVICE_IMAGE = os.getenv(
    "REMOTE_DEVICE_DOCKER_IMAGE",
    "ghcr.io/wecode-ai/wegent-device:latest",
)
DEFAULT_REMOTE_DEVICE_BACKEND_URL = os.getenv("REMOTE_DEVICE_BACKEND_URL", "")
DEFAULT_REMOTE_DEVICE_CONTAINER_NAME = "wegent-remote-device"
DEFAULT_REMOTE_DEVICE_PUBLIC_BASE_URL = "http://localhost:17888"
DEFAULT_REMOTE_DEVICE_EXECUTOR_INSTALL_URL = os.getenv(
    "REMOTE_DEVICE_EXECUTOR_INSTALL_URL",
    "https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh",
)
DEVICE_SESSION_GATEWAY_PORT = 17888


class CreateDockerRemoteDeviceRequest(BaseModel):
    """Request for generating a Docker remote device command."""

    client_origin: Optional[str] = Field(
        default=None,
        description="Current browser origin used to derive the device access URL.",
    )
    container_name: str = Field(
        default=DEFAULT_REMOTE_DEVICE_CONTAINER_NAME,
        min_length=1,
        max_length=128,
        description="Docker container name used in the generated command.",
    )


class RemoteDeviceStartupCommand(BaseModel):
    """A generated startup command for a remote device."""

    kind: Literal["docker", "process"]
    label: str
    description: str
    command: str


class DockerRemoteDeviceCommandResponse(BaseModel):
    """Generated remote device startup commands."""

    device_id: str
    name: str
    image: str
    env: Dict[str, str]
    command: str
    commands: list[RemoteDeviceStartupCommand] = Field(default_factory=list)


def _get_backend_url(request: Request) -> str:
    """Resolve the backend URL for remote executors to connect to."""
    if DEFAULT_REMOTE_DEVICE_BACKEND_URL:
        return DEFAULT_REMOTE_DEVICE_BACKEND_URL
    if settings.BACKEND_INTERNAL_URL:
        return settings.BACKEND_INTERNAL_URL

    scheme = request.url.scheme
    host = request.headers.get("host", request.url.netloc)
    return f"{scheme}://{host}"


def _validate_generated_url(value: str, field_name: str) -> str:
    """Validate generated URL-like values used in generated commands."""
    normalized = value.strip()
    if not normalized or "<" in normalized or ">" in normalized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} must be a concrete URL, not a placeholder",
        )
    if not normalized.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} must start with http:// or https://",
        )
    return normalized


def _absolute_url(value: Optional[str], request: Request) -> Optional[str]:
    """Return an absolute HTTP URL using request host for relative values."""
    if not value:
        return None

    normalized = value.strip()
    if not normalized:
        return None

    parsed = urlparse(normalized)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return normalized
    if normalized.startswith("/"):
        return f"{_get_backend_url(request).rstrip('/')}{normalized}"
    return None


def _strip_api_suffix(url: str) -> str:
    """Strip the frontend API suffix so executors connect to Backend root."""
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    if path == "/api":
        path = ""
    elif path.endswith("/api"):
        path = path[: -len("/api")]
    return urlunparse(
        parsed._replace(
            path=path,
            params="",
            query="",
            fragment="",
        )
    ).rstrip("/")


def _resolve_backend_url(request: Request) -> str:
    """Resolve a Backend URL that is reachable from inside the Docker container."""
    candidate = _get_backend_url(request)
    candidate = _strip_api_suffix(candidate)
    return _validate_generated_url(candidate, "backend_url")


def _origin_from_headers(request: Request) -> Optional[str]:
    """Resolve browser origin from request headers when available."""
    origin = request.headers.get("origin")
    if origin:
        return origin

    referer = request.headers.get("referer")
    if not referer:
        return None

    parsed = urlparse(referer)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return None


def _resolve_public_base_url(
    request: Request,
    body: CreateDockerRemoteDeviceRequest,
) -> str:
    """Resolve the browser-facing device session gateway URL."""
    candidate = (
        body.client_origin or _origin_from_headers(request) or _get_backend_url(request)
    )
    candidate = _absolute_url(candidate, request) or _get_backend_url(request)
    parsed = urlparse(candidate)
    host = parsed.hostname
    if not host or parsed.scheme not in {"http", "https"}:
        return DEFAULT_REMOTE_DEVICE_PUBLIC_BASE_URL

    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    public_base_url = f"http://{host}:{DEVICE_SESSION_GATEWAY_PORT}"
    return _validate_generated_url(public_base_url, "public_base_url")


def _build_docker_run_command(
    *,
    container_name: str,
    image: str,
    env: Dict[str, str],
    add_host_gateway: bool,
) -> str:
    """Build a copy-ready docker run command from environment variables."""
    env_lines = [f"  -e {key}={shlex.quote(value)} \\" for key, value in env.items()]
    lines = [
        "docker run -d \\",
        f"  --name {shlex.quote(container_name)} \\",
        "  --restart unless-stopped \\",
    ]
    if add_host_gateway:
        lines.append("  --add-host host.docker.internal:host-gateway \\")
    lines.extend(
        [
            *env_lines,
            "  -p 17888:17888 \\",
            f"  -v {shlex.quote(container_name)}-home:/home/wegent/.wecode/wegent-executor \\",
            f"  {shlex.quote(image)}",
        ]
    )
    return "\n".join(lines)


def _build_process_start_command(env: Dict[str, str]) -> str:
    """Build a copy-ready process startup script from environment variables."""
    env_lines = [f"export {key}={shlex.quote(value)}" for key, value in env.items()]
    install_url = shlex.quote(DEFAULT_REMOTE_DEVICE_EXECUTOR_INSTALL_URL.strip())
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        f"INSTALL_URL={install_url}",
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


@router.post(
    "/docker/start-command",
    response_model=DockerRemoteDeviceCommandResponse,
)
async def create_docker_start_command(
    request: Request,
    body: Optional[CreateDockerRemoteDeviceRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DockerRemoteDeviceCommandResponse:
    """Create connection credentials and return remote device startup commands."""
    body = body or CreateDockerRemoteDeviceRequest()
    image = DEFAULT_REMOTE_DEVICE_IMAGE.strip()
    if not image:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="image must not be empty",
        )

    backend_url = _resolve_backend_url(request)
    public_base_url = _resolve_public_base_url(request, body)
    device_id = str(uuid.uuid4())
    device_name = f"{current_user.user_name}-remote-{device_id.split('-')[-1]}"
    _, auth_token = create_api_key_for_remote_device(
        db,
        current_user.id,
        current_user.user_name,
    )

    env = {
        "DEVICE_TYPE": DeviceType.REMOTE.value,
        "DEVICE_ID": device_id,
        "DEVICE_NAME": device_name,
        "WEGENT_BACKEND_URL": backend_url,
        "WEGENT_AUTH_TOKEN": auth_token,
        "DEVICE_PUBLIC_BASE_URL": public_base_url,
    }
    command = _build_docker_run_command(
        container_name=body.container_name,
        image=image,
        env=env,
        add_host_gateway=urlparse(backend_url).hostname == "host.docker.internal",
    )
    process_command = _build_process_start_command(env)

    logger.info(
        "[RemoteDevice] Docker command generated: user_id=%s, device_id=%s",
        current_user.id,
        device_id,
    )

    return DockerRemoteDeviceCommandResponse(
        device_id=device_id,
        name=device_name,
        image=image,
        env=env,
        command=command,
        commands=[
            RemoteDeviceStartupCommand(
                kind="docker",
                label="Docker",
                description="Run a managed container with the executor and session gateway.",
                command=command,
            ),
            RemoteDeviceStartupCommand(
                kind="process",
                label="Process",
                description="Run an installed wegent-executor process directly on this machine.",
                command=process_command,
            ),
        ],
    )
