# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Transparent Wework runtime IPC relay over Socket.IO."""

import logging
import uuid
from typing import Any, Optional

import socketio
from fastapi import HTTPException
from pydantic import ValidationError
from socketio.exceptions import ConnectionRefusedError

from app.api.ws.connection_utils import enter_connect_room, save_connect_session
from app.api.ws.decorators import trace_websocket_event
from app.core.config import settings
from app.schemas.project_chat import (
    ProjectChatAgentFailure,
    ProjectChatAgentStart,
    ProjectChatSend,
    ProjectChatSubscribe,
)
from app.services.chat.access import get_token_expiry, verify_jwt_token
from app.services.chat.storage.db import get_db_session, run_sync_in_executor
from app.services.device.command_registry import (
    CommandRegistryError,
    resolve_local_device_command,
)
from app.services.device.command_service import (
    DeviceCommandError,
    local_device_command_service,
)
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service
from app.services.project_chat.service import project_chat_service
from shared.telemetry.context import set_request_context, set_user_context

logger = logging.getLogger(__name__)

WEWORK_RUNTIME_NAMESPACE = "/wework-runtime"
WEWORK_RUNTIME_EVENT = "runtime:event"
WEWORK_RUNTIME_REQUEST_EVENT = "runtime:request"
WEWORK_RUNTIME_USER_ROOM_PREFIX = "wework-runtime:user:"
DEFAULT_IPC_TIMEOUT_SECONDS = 75
PROJECT_CHAT_SUBSCRIBE_EVENT = "wework:project_chat:subscribe"
PROJECT_CHAT_UNSUBSCRIBE_EVENT = "wework:project_chat:unsubscribe"
PROJECT_CHAT_SEND_EVENT = "wework:project_chat:message:send"
PROJECT_CHAT_CREATED_EVENT = "wework:project_chat:message:created"
PROJECT_CHAT_AGENT_CHUNK_EVENT = "wework:project_chat:agent:chunk"
PROJECT_CHAT_AGENT_START_EVENT = "wework:project_chat:agent:start"
PROJECT_CHAT_AGENT_FAILED_EVENT = "wework:project_chat:agent:failed"
PROJECT_CHAT_PROJECT_ROOM_PREFIX = "wework-project-chat:project:"
PROJECT_CHAT_TASK_ROOM_PREFIX = "wework-project-chat:task:"


def wework_runtime_user_room(user_id: int) -> str:
    """Return the Wework runtime relay room for one user."""

    return f"{WEWORK_RUNTIME_USER_ROOM_PREFIX}{user_id}"


class WeworkRuntimeNamespace(socketio.AsyncNamespace):
    """Browser-facing namespace that relays app IPC requests to runtime devices."""

    def __init__(self, namespace: str = WEWORK_RUNTIME_NAMESPACE):
        super().__init__(namespace)
        self._event_handlers: dict[str, str] = {
            WEWORK_RUNTIME_REQUEST_EVENT: "on_runtime_request",
            PROJECT_CHAT_SUBSCRIBE_EVENT: "on_project_chat_subscribe",
            PROJECT_CHAT_UNSUBSCRIBE_EVENT: "on_project_chat_unsubscribe",
            PROJECT_CHAT_SEND_EVENT: "on_project_chat_message_send",
            PROJECT_CHAT_AGENT_START_EVENT: "on_project_chat_agent_start",
            PROJECT_CHAT_AGENT_FAILED_EVENT: "on_project_chat_agent_failed",
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

    async def on_project_chat_subscribe(self, sid: str, data: dict) -> dict:
        """Authorize a project chat subscription and return missed messages."""

        identity = await self._project_chat_identity(sid)
        if identity is None:
            return project_chat_error("UNAUTHENTICATED", "Not authenticated")
        try:
            request = ProjectChatSubscribe.model_validate(project_chat_payload(data))
            messages = await run_sync_in_executor(
                _subscribe_project_chat_sync,
                int(identity["user_id"]),
                request,
            )
        except (ValidationError, HTTPException) as exc:
            return project_chat_exception_ack(exc)

        room = project_chat_room(request.project_id, request.task_id)
        await self.enter_room(sid, room)
        return {
            "ok": True,
            "result": {
                "messages": messages,
                "currentUserId": str(identity["user_id"]),
                "latestSequence": (
                    messages[-1]["sequenceNumber"]
                    if messages
                    else request.after_sequence
                ),
            },
        }

    async def on_project_chat_unsubscribe(self, sid: str, data: dict) -> dict:
        """Leave one project chat or task-thread room."""

        try:
            request = ProjectChatSubscribe.model_validate(project_chat_payload(data))
        except ValidationError as exc:
            return project_chat_exception_ack(exc)
        await self.leave_room(
            sid, project_chat_room(request.project_id, request.task_id)
        )
        return {"ok": True}

    async def on_project_chat_message_send(self, sid: str, data: dict) -> dict:
        """Persist one user message, ACK it, then fan it out to subscribers."""

        identity = await self._project_chat_identity(sid)
        if identity is None:
            return project_chat_error("UNAUTHENTICATED", "Not authenticated")
        try:
            request = ProjectChatSend.model_validate(project_chat_payload(data))
            result = await run_sync_in_executor(
                _send_project_chat_sync,
                int(identity["user_id"]),
                str(identity.get("user_name") or identity["user_id"]),
                request,
            )
        except (ValidationError, HTTPException) as exc:
            return project_chat_exception_ack(exc)

        if result["created"]:
            message = result["message"]
            await self.emit(
                PROJECT_CHAT_CREATED_EVENT,
                message,
                room=project_chat_room(request.project_id, request.task_id),
            )
        return {
            "ok": True,
            "created": result["created"],
            "clientMessageId": request.client_message_id,
            "result": result["message"],
        }

    async def _project_chat_identity(self, sid: str) -> dict | None:
        session = await self.get_session(sid)
        if not session or not session.get("user_id"):
            return None
        return session

    async def on_project_chat_agent_start(self, sid: str, data: dict) -> dict:
        """Create the single streaming chat row for a mentioned AI run."""

        identity = await self._project_chat_identity(sid)
        if identity is None:
            return project_chat_error("UNAUTHENTICATED", "Not authenticated")
        try:
            request = ProjectChatAgentStart.model_validate(project_chat_payload(data))
            message = await run_sync_in_executor(
                _start_project_chat_agent_sync,
                int(identity["user_id"]),
                request,
            )
        except (ValidationError, HTTPException) as exc:
            return project_chat_exception_ack(exc)
        await emit_project_chat_message(self, message)
        return {"ok": True, "result": message}

    async def on_project_chat_agent_failed(self, sid: str, data: dict) -> dict:
        """Close an optimistic response when runtime task creation is rejected."""

        identity = await self._project_chat_identity(sid)
        if identity is None:
            return project_chat_error("UNAUTHENTICATED", "Not authenticated")
        try:
            request = ProjectChatAgentFailure.model_validate(project_chat_payload(data))
            message = await run_sync_in_executor(
                _fail_project_chat_agent_sync,
                int(identity["user_id"]),
                request,
            )
        except (ValidationError, HTTPException) as exc:
            return project_chat_exception_ack(exc)
        await emit_project_chat_message(self, message)
        return {"ok": True, "result": message}


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


def project_chat_payload(data: Any) -> dict[str, Any]:
    """Normalize the public camelCase Socket payload for Pydantic validation."""

    if not isinstance(data, dict):
        return {}
    aliases = {
        "clientMessageId": "client_message_id",
        "projectId": "project_id",
        "taskId": "task_id",
        "afterSequence": "after_sequence",
    }
    payload = {aliases.get(key, key): value for key, value in data.items()}
    return payload


def project_chat_room(project_id: str, task_id: str | None) -> str:
    if task_id:
        return f"{PROJECT_CHAT_TASK_ROOM_PREFIX}{project_id}:{task_id}"
    return f"{PROJECT_CHAT_PROJECT_ROOM_PREFIX}{project_id}"


async def emit_project_chat_message(
    namespace: WeworkRuntimeNamespace, message: dict[str, Any]
) -> None:
    project_id = str(message["projectId"])
    task_id = message.get("taskId")
    await namespace.emit(
        PROJECT_CHAT_CREATED_EVENT,
        message,
        room=project_chat_room(project_id, str(task_id) if task_id else None),
    )


def project_chat_error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def project_chat_exception_ack(exc: ValidationError | HTTPException) -> dict[str, Any]:
    if isinstance(exc, ValidationError):
        return project_chat_error("INVALID_MESSAGE", str(exc))
    code = {
        403: "SCOPE_FORBIDDEN",
        404: "SCOPE_NOT_FOUND",
        409: "MESSAGE_CONFLICT",
    }.get(exc.status_code, "INVALID_MESSAGE")
    return project_chat_error(code, str(exc.detail))


def _subscribe_project_chat_sync(
    user_id: int, request: ProjectChatSubscribe
) -> list[dict[str, Any]]:
    with get_db_session() as db:
        messages = project_chat_service.subscribe(db, user_id=user_id, request=request)
        return [message.model_dump(mode="json", by_alias=True) for message in messages]


def _send_project_chat_sync(
    user_id: int, user_name: str, request: ProjectChatSend
) -> dict[str, Any]:
    with get_db_session() as db:
        result = project_chat_service.send(
            db,
            user_id=user_id,
            user_name=user_name,
            request=request,
        )
        return {
            "created": result.created,
            "message": result.message.model_dump(mode="json", by_alias=True),
        }


def _fail_project_chat_agent_sync(
    user_id: int, request: ProjectChatAgentFailure
) -> dict[str, Any]:
    with get_db_session() as db:
        message = project_chat_service.fail_agent_response(
            db, user_id=user_id, request=request
        )
        return message.model_dump(mode="json", by_alias=True)


def _start_project_chat_agent_sync(
    user_id: int, request: ProjectChatAgentStart
) -> dict[str, Any]:
    with get_db_session() as db:
        message = project_chat_service.start_agent_response(
            db, user_id=user_id, request=request
        )
        return message.model_dump(mode="json", by_alias=True)


def register_wework_runtime_namespace(sio: socketio.AsyncServer) -> None:
    """Register the Wework runtime relay namespace."""

    sio.register_namespace(WeworkRuntimeNamespace(WEWORK_RUNTIME_NAMESPACE))
    logger.info("Wework runtime namespace registered at %s", WEWORK_RUNTIME_NAMESPACE)
