# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Transparent Wework runtime IPC relay over Socket.IO."""

import logging
import uuid
from typing import Any, Optional

import socketio
from socketio.exceptions import ConnectionRefusedError

from app.api.ws.connection_utils import enter_connect_room, save_connect_session
from app.api.ws.decorators import trace_websocket_event
from app.core.config import settings
from app.services.chat.access import get_token_expiry, verify_jwt_token
from app.services.device.command_registry import (
    CommandRegistryError,
    resolve_local_device_command,
)
from app.services.device.command_service import (
    DeviceCommandError,
    local_device_command_service,
)
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service
from shared.telemetry.context import set_request_context, set_user_context

logger = logging.getLogger(__name__)

WEWORK_RUNTIME_NAMESPACE = "/wework-runtime"
WEWORK_RUNTIME_EVENT = "runtime:event"
WEWORK_RUNTIME_REQUEST_EVENT = "runtime:request"
WEWORK_RUNTIME_USER_ROOM_PREFIX = "wework-runtime:user:"
DEFAULT_IPC_TIMEOUT_SECONDS = 75


def wework_runtime_user_room(user_id: int) -> str:
    """Return the Wework runtime relay room for one user."""

    return f"{WEWORK_RUNTIME_USER_ROOM_PREFIX}{user_id}"


class WeworkRuntimeNamespace(socketio.AsyncNamespace):
    """Browser-facing namespace that relays app IPC requests to runtime devices."""

    def __init__(self, namespace: str = WEWORK_RUNTIME_NAMESPACE):
        super().__init__(namespace)
        self._event_handlers: dict[str, str] = {
            WEWORK_RUNTIME_REQUEST_EVENT: "on_runtime_request",
        }

    @trace_websocket_event(exclude_events={"connect"}, extract_event_data=True)
    async def trigger_event(self, event: str, sid: str, *args):
        """Route colon-separated runtime relay events to explicit handlers."""

        if event in self._event_handlers:
            handler = getattr(self, self._event_handlers[event], None)
            if handler:
                return await handler(sid, *args)
        return await super().trigger_event(event, sid, *args)

    async def on_connect(
        self,
        sid: str,
        environ: dict,
        auth: Optional[dict] = None,
    ):
        """Authenticate Wework runtime relay clients with the existing JWT token."""

        request_id = str(uuid.uuid4())[:8]
        set_request_context(request_id)

        if not auth or not isinstance(auth, dict):
            logger.warning("[Wework Runtime WS] Missing auth data sid=%s", sid)
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning("[Wework Runtime WS] Missing token in auth sid=%s", sid)
            raise ConnectionRefusedError("Missing authentication token")

        user = verify_jwt_token(token)
        if not user:
            logger.warning("[Wework Runtime WS] Invalid JWT token sid=%s", sid)
            raise ConnectionRefusedError("Invalid or expired token")

        await save_connect_session(
            self,
            sid,
            session_data={
                "user_id": user.id,
                "user_name": user.user_name,
                "request_id": request_id,
                "token_exp": get_token_expiry(token),
                "auth_token": token,
            },
            logger=logger,
            log_prefix="[Wework Runtime WS]",
        )
        set_user_context(user_id=str(user.id), user_name=user.user_name)
        await enter_connect_room(
            self,
            sid,
            wework_runtime_user_room(user.id),
            logger=logger,
            log_prefix="[Wework Runtime WS]",
        )
        logger.info("[Wework Runtime WS] Connected user=%s sid=%s", user.id, sid)

    async def on_runtime_request(self, sid: str, data: dict) -> dict:
        """Relay one app IPC-style runtime request to an online executor."""

        session = await self.get_session(sid)
        user_id = session.get("user_id") if session else None
        if not user_id:
            return ipc_error(data, "unauthorized", "Not authenticated")

        request_id = request_id_from(data)
        method = string_field(data, "method")
        device_id = string_field(data, "device_id") or string_field(data, "deviceId")
        params = data.get("params")
        if params is None:
            params = data.get("payload", {})

        if not method:
            return ipc_error(data, "bad_request", "method is required", request_id)
        if not device_id:
            return ipc_error(data, "bad_request", "device_id is required", request_id)
        if not isinstance(params, dict):
            return ipc_error(
                data, "bad_request", "params must be an object", request_id
            )

        try:
            result = await relay_ipc_request(
                user_id=int(user_id),
                device_id=device_id,
                method=method,
                params=params,
                timeout_seconds=timeout_seconds_from(data),
            )
        except (RuntimeRpcError, DeviceCommandError) as exc:
            return ipc_error(data, "runtime_rpc_failed", str(exc), request_id)

        return {"id": request_id, "ok": True, "result": result}


async def relay_ipc_request(
    *,
    user_id: int,
    device_id: str,
    method: str,
    params: dict[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    """Relay one supported app IPC method to the owning executor."""

    if method == "device.execute_command":
        try:
            command = resolve_local_device_command(
                str(params.get("command_key") or ""),
                settings.LOCAL_DEVICE_COMMANDS,
            )
        except CommandRegistryError as exc:
            raise DeviceCommandError(str(exc)) from exc
        if command is None:
            raise DeviceCommandError("Device command key is not configured")
        return await local_device_command_service.execute_command(
            user_id=user_id,
            device_id=device_id,
            command=command.command,
            path=params.get("path") if isinstance(params.get("path"), str) else None,
            cwd=params.get("cwd") if isinstance(params.get("cwd"), str) else None,
            args=params.get("args") if isinstance(params.get("args"), list) else [],
            env=params.get("env") if isinstance(params.get("env"), dict) else {},
            timeout_seconds=timeout_seconds,
            max_output_bytes=int(params.get("max_output_bytes") or 1024 * 1024),
        )

    return await runtime_rpc_service.call(
        user_id=user_id,
        device_id=device_id,
        method=method,
        payload=params,
        timeout_seconds=timeout_seconds,
    )


def ipc_error(
    data: Any,
    code: str,
    message: str,
    request_id: str | None = None,
) -> dict:
    """Build an app IPC-compatible error ACK."""

    return {
        "id": request_id or request_id_from(data),
        "ok": False,
        "error": {"code": code, "message": message},
    }


def request_id_from(data: Any) -> str:
    if isinstance(data, dict):
        value = data.get("id")
        if isinstance(value, str) and value.strip():
            return value
    return str(uuid.uuid4())


def string_field(data: dict, key: str) -> str | None:
    value = data.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def timeout_seconds_from(data: dict) -> int:
    value = data.get("timeout_seconds") or data.get("timeoutSeconds")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return DEFAULT_IPC_TIMEOUT_SECONDS
    return parsed if parsed > 0 else DEFAULT_IPC_TIMEOUT_SECONDS


def register_wework_runtime_namespace(sio: socketio.AsyncServer) -> None:
    """Register the Wework runtime relay namespace."""

    sio.register_namespace(WeworkRuntimeNamespace(WEWORK_RUNTIME_NAMESPACE))
    logger.info("Wework runtime namespace registered at %s", WEWORK_RUNTIME_NAMESPACE)
