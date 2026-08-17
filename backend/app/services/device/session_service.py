# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend RPC service for starting interactive sessions on local devices."""

import logging
import secrets
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.core.socketio import get_sio
from app.schemas.device import DeviceType
from app.services.device.terminal_session_service import (
    TerminalSessionRecord,
    terminal_session_service,
)
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

SESSION_RPC_TIMEOUT_SECONDS = 15
DEFAULT_SESSION_TTL_SECONDS = 60 * 60
SESSION_ID_TOKEN_BYTES = 16
SESSION_RPC_EVENTS = {
    "terminal": "device:start_terminal_session",
    "code_server": "device:start_code_server_session",
}

DeviceSessionType = Literal["terminal", "code_server"]


class DeviceSessionError(RuntimeError):
    """Raised when a local device session cannot be started."""


class DeviceSessionNotFoundError(DeviceSessionError):
    """Raised when a local device does not exist or is not owned by the user."""


class LocalDeviceSessionService:
    """Start browser-accessible interactive sessions on connected local devices."""

    async def start_session(
        self,
        *,
        db: Any,
        user_id: int,
        device_id: str,
        project_id: int,
        session_type: DeviceSessionType,
        path: str,
        create_if_missing: bool = False,
        ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
    ) -> dict[str, Any]:
        """Ask an online local device to start an interactive project session."""
        device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
        if not device_kind:
            raise DeviceSessionNotFoundError("Device not found or access denied")

        online_info = await device_service.get_device_online_info(user_id, device_id)
        if not online_info:
            raise DeviceSessionError(f"Device '{device_id}' is offline")

        socket_id = online_info.get("socket_id")
        if not socket_id:
            raise DeviceSessionError(f"Device '{device_id}' has no socket information")

        normalized_ttl = self._normalize_ttl(ttl_seconds)
        session_id = self._build_session_id(session_type, project_id)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=normalized_ttl)

        payload = {
            "type": session_type,
            "session_id": session_id,
            "project_id": project_id,
            "path": path,
            "create_if_missing": create_if_missing,
            "ttl_seconds": normalized_ttl,
            "expires_at": expires_at.isoformat(),
        }
        payload["access_token"] = secrets.token_urlsafe(32)

        logger.info(
            "[LocalDeviceSessionService] Starting session: "
            "user_id=%s, device_id=%s, project_id=%s, type=%s, socket_id=%s",
            user_id,
            device_id,
            project_id,
            session_type,
            socket_id,
        )

        event_name = SESSION_RPC_EVENTS[session_type]
        try:
            result = await get_sio().call(
                event_name,
                payload,
                to=socket_id,
                namespace="/local-executor",
                timeout=SESSION_RPC_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            raise DeviceSessionError(f"Session RPC failed: {exc}") from exc

        if not isinstance(result, dict):
            raise DeviceSessionError("Session RPC returned an invalid response")
        if not result.get("success", False):
            error = result.get("error") or "Device failed to start session"
            raise DeviceSessionError(str(error))

        result = dict(result)
        result["session_id"] = session_id
        result.setdefault("project_id", project_id)
        result.setdefault("device_id", device_id)
        result.setdefault("type", session_type)
        result.setdefault("path", path)
        result.setdefault("expires_at", expires_at)

        if session_type == "terminal":
            try:
                await terminal_session_service.register(
                    TerminalSessionRecord(
                        session_id=session_id,
                        user_id=user_id,
                        device_id=device_id,
                        socket_id=socket_id,
                        project_id=project_id,
                        path=result.get("path") or path,
                        expires_at=expires_at,
                    ),
                    ttl_seconds=normalized_ttl,
                )
            except Exception as exc:
                with suppress(Exception):
                    await get_sio().emit(
                        "terminal:close",
                        {"session_id": session_id},
                        to=socket_id,
                        namespace="/local-executor",
                    )
                raise DeviceSessionError(
                    "Failed to persist terminal session metadata"
                ) from exc
            result["url"] = ""
            result["transport"] = "socketio"
            return result

        access_token = payload["access_token"]
        result = _ensure_session_url_token(result, access_token)
        result = await _rewrite_cloud_localhost_url(
            result,
            device_kind,
            online_info.get("runtime_transfer_host"),
        )
        result.setdefault("transport", "url")
        return result

    def _build_session_id(
        self, session_type: DeviceSessionType, project_id: int
    ) -> str:
        prefix = "terminal" if session_type == "terminal" else "code"
        return f"{prefix}-{project_id}-{secrets.token_urlsafe(SESSION_ID_TOKEN_BYTES)}"

    def _normalize_ttl(self, ttl_seconds: Any) -> int:
        try:
            parsed = int(ttl_seconds)
        except (TypeError, ValueError):
            return DEFAULT_SESSION_TTL_SECONDS
        if parsed <= 0:
            return DEFAULT_SESSION_TTL_SECONDS
        return min(parsed, DEFAULT_SESSION_TTL_SECONDS)


local_device_session_service = LocalDeviceSessionService()


def _ensure_session_url_token(
    result: dict[str, Any],
    access_token: str,
) -> dict[str, Any]:
    """Ensure device session URLs carry the generated access token."""
    url = result.get("url")
    if not isinstance(url, str) or not url:
        return result

    parsed = urlsplit(url)
    query_items = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key != "token"
    ]
    query_items.append(("token", access_token))
    rewritten = dict(result)
    rewritten["url"] = urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            urlencode(query_items),
            parsed.fragment,
        )
    )
    return rewritten


async def _rewrite_cloud_localhost_url(
    result: dict[str, Any],
    device_kind: Any,
    runtime_transfer_host: Any = None,
) -> dict[str, Any]:
    """Rewrite cloud session URLs that point to device-local localhost."""
    url = result.get("url")
    if not isinstance(url, str) or not url:
        return result
    spec = getattr(device_kind, "json", {}).get("spec", {})
    if spec.get("deviceType", DeviceType.LOCAL.value) != DeviceType.CLOUD.value:
        return result

    parsed = urlsplit(url)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        return result

    host = _extract_cloud_session_host(runtime_transfer_host)
    if host in {"localhost", "127.0.0.1", "::1"}:
        host = ""
    if not host:
        sandbox_id = (spec.get("cloudConfig") or {}).get("sandboxId")
        if not sandbox_id:
            return result

        try:
            vm_status = await _get_cloud_device_provider().get_vm_status(sandbox_id)
        except Exception as exc:
            logger.warning(
                "[LocalDeviceSessionService] Failed to resolve cloud session host: "
                "sandbox_id=%s, error=%s",
                sandbox_id,
                exc,
            )
            return result
        host = _extract_cloud_session_host(vm_status.get("ip_address"))
    if not host:
        return result

    rewritten = dict(result)
    rewritten["url"] = urlunsplit(
        (
            parsed.scheme or "http",
            _format_netloc(host, parsed.port),
            parsed.path,
            parsed.query,
            parsed.fragment,
        )
    )
    return rewritten


def _get_cloud_device_provider() -> Any:
    from wecode.service.cloud_device_provider import cloud_device_provider

    return cloud_device_provider


def _extract_cloud_session_host(value: Any) -> str:
    """Extract a browser-reachable host from Nevis status URL metadata."""
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return ""
        if "://" in text:
            return urlsplit(text).hostname or ""
        return text.split(",", 1)[0].split()[0].strip().strip("/")
    if isinstance(value, (list, tuple)):
        for item in value:
            host = _extract_cloud_session_host(item)
            if host:
                return host
    if isinstance(value, dict):
        for key in ("ip", "host", "hostname", "url", "http", "https"):
            host = _extract_cloud_session_host(value.get(key))
            if host:
                return host
        for item in value.values():
            host = _extract_cloud_session_host(item)
            if host:
                return host
    return ""


def _format_netloc(host: str, port: int | None) -> str:
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"{host}:{port}" if port else host
