# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend RPC service for starting interactive sessions on local devices."""

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from app.core.socketio import get_sio
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

SESSION_RPC_TIMEOUT_SECONDS = 15
DEFAULT_SESSION_TTL_SECONDS = 60 * 60
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
        if not device_service.get_device_by_device_id(db, user_id, device_id):
            raise DeviceSessionNotFoundError("Device not found or access denied")

        online_info = await device_service.get_device_online_info(user_id, device_id)
        if not online_info:
            raise DeviceSessionError(f"Device '{device_id}' is offline")

        socket_id = online_info.get("socket_id")
        if not socket_id:
            raise DeviceSessionError(f"Device '{device_id}' has no socket information")

        normalized_ttl = self._normalize_ttl(ttl_seconds)
        session_id = self._build_session_id(session_type, project_id)
        access_token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=normalized_ttl)

        payload = {
            "type": session_type,
            "session_id": session_id,
            "access_token": access_token,
            "project_id": project_id,
            "path": path,
            "create_if_missing": create_if_missing,
            "ttl_seconds": normalized_ttl,
            "expires_at": expires_at.isoformat(),
        }

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

        result.setdefault("session_id", session_id)
        result.setdefault("project_id", project_id)
        result.setdefault("device_id", device_id)
        result.setdefault("type", session_type)
        result.setdefault("path", path)
        result.setdefault("expires_at", expires_at)
        return result

    def _build_session_id(
        self, session_type: DeviceSessionType, project_id: int
    ) -> str:
        prefix = "terminal" if session_type == "terminal" else "code"
        return f"{prefix}-{project_id}-{secrets.token_urlsafe(8)}"

    def _normalize_ttl(self, ttl_seconds: Any) -> int:
        try:
            parsed = int(ttl_seconds)
        except (TypeError, ValueError):
            return DEFAULT_SESSION_TTL_SECONDS
        if parsed <= 0:
            return DEFAULT_SESSION_TTL_SECONDS
        return min(parsed, DEFAULT_SESSION_TTL_SECONDS)


local_device_session_service = LocalDeviceSessionService()
