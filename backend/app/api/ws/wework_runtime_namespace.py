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
    ProjectChatCommentExecution,
    ProjectChatSend,
    ProjectChatSubscribe,
)
from app.schemas.runtime_execution_snapshot import RuntimeExecutionSnapshot
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
from app.services.device.remote_control_policy import (
    REMOTE_CONTROL_DISABLED_MESSAGE,
    remote_control_is_enabled,
)
from app.services.device.runtime_route import (
    RuntimeRouteError,
    runtime_route_resolver,
)
from app.services.device.runtime_rpc_service import (
    RuntimeRpcError,
    encode_runtime_rpc_response,
    runtime_rpc_service,
)
from app.services.project_chat.execution_snapshot import reconcile_execution_snapshot
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
PROJECT_CHAT_EXECUTION_SNAPSHOT_EVENT = "wework:project_chat:execution:snapshot"
PROJECT_CHAT_AGENT_FAILED_EVENT = "wework:project_chat:agent:failed"
PROJECT_CHAT_COMMENT_EXECUTE_EVENT = "wework:project_chat:comment:execute"
PROJECT_CHAT_PROJECT_ROOM_PREFIX = "wework-project-chat:project:"
PROJECT_CHAT_TASK_ROOM_PREFIX = "wework-project-chat:task:"
RUNTIME_EXECUTION_REQUEST_KEYS = (
    "executionRequest",
    "execution_request",
    "friendlyTitleExecutionRequest",
    "friendly_title_execution_request",
)


def wework_runtime_user_room(user_id: int) -> str:
    """Return the Wework runtime relay room for one user."""

    return f"{WEWORK_RUNTIME_USER_ROOM_PREFIX}{user_id}"


def has_runtime_execution_request(params: dict[str, Any]) -> bool:
    """Return whether runtime IPC params contain an execution identity."""

    return any(
        isinstance(params.get(request_key), dict)
        for request_key in RUNTIME_EXECUTION_REQUEST_KEYS
    )


def bind_authenticated_runtime_identity(
    params: dict[str, Any],
    *,
    user_id: int,
    user_name: str,
    user_email: str,
) -> dict[str, Any]:
    """Bind runtime execution requests to the authenticated Wework user."""

    bound_params = dict(params)
    for request_key in RUNTIME_EXECUTION_REQUEST_KEYS:
        raw_execution_request = params.get(request_key)
        if not isinstance(raw_execution_request, dict):
            continue

        execution_request = dict(raw_execution_request)
        raw_user = execution_request.get("user")
        user = dict(raw_user) if isinstance(raw_user, dict) else {}
        user.update(
            {
                "id": user_id,
                "name": user_name,
                "user_name": user_name,
                "email": user_email,
            }
        )
        execution_request.update(
            {
                "user": user,
                "user_id": user_id,
                "user_name": user_name,
            }
        )
        bound_params[request_key] = execution_request

    return bound_params


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
            PROJECT_CHAT_EXECUTION_SNAPSHOT_EVENT: "on_project_chat_execution_snapshot",
            PROJECT_CHAT_AGENT_FAILED_EVENT: "on_project_chat_agent_failed",
            PROJECT_CHAT_COMMENT_EXECUTE_EVENT: "on_project_chat_comment_execute",
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
                "user_email": user.email or "",
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
        set_request_context(request_id)
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
        if has_runtime_execution_request(params):
            user_name = string_field(session, "user_name")
            if not user_name:
                return ipc_error(
                    data,
                    "unauthorized",
                    "Authenticated runtime user identity is incomplete",
                    request_id,
                )
            params = bind_authenticated_runtime_identity(
                params,
                user_id=int(user_id),
                user_name=user_name,
                user_email=string_field(session, "user_email") or "",
            )

        try:
            result = await relay_ipc_request(
                user_id=int(user_id),
                device_id=device_id,
                method=method,
                params=params,
                timeout_seconds=timeout_seconds_from(data),
            )
        except RuntimeRpcError as exc:
            return ipc_error(
                data,
                exc.code,
                str(exc),
                request_id,
                retryable=exc.retryable,
                details=exc.details,
            )
        except DeviceCommandError as exc:
            return ipc_error(data, "device_command_failed", str(exc), request_id)

        # ``device.execute_command`` uses ``success`` for the command exit
        # status, so a non-zero exit remains a valid pass-through result.
        if method != "device.execute_command" and result.get("success") is False:
            error = runtime_rpc_failure(result, method)
            return ipc_error(
                data,
                error["code"],
                error["message"],
                request_id,
                retryable=error["retryable"],
                details=error["details"],
            )
        try:
            result = encode_runtime_rpc_response(result, method=method)
        except RuntimeRpcError as exc:
            return ipc_error(
                data,
                exc.code,
                str(exc),
                request_id,
                retryable=exc.retryable,
                details=exc.details,
            )
        return {"id": request_id, "ok": True, "result": result}

    async def on_project_chat_execution_snapshot(self, sid: str, data: dict) -> dict:
        """Persist execution facts read by the authenticated device owner."""
        identity = await self._project_chat_identity(sid)
        if identity is None:
            return project_chat_error("UNAUTHENTICATED", "Not authenticated")
        try:
            snapshot = RuntimeExecutionSnapshot.model_validate(
                project_chat_payload(data)
            )
            messages = await run_sync_in_executor(
                _reconcile_execution_snapshot_sync, int(identity["user_id"]), snapshot
            )
        except (ValidationError, HTTPException) as exc:
            return project_chat_exception_ack(exc)
        for message in messages:
            await emit_project_chat_message(self, message)
        return {"ok": True, "result": messages}

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
            messages = list(messages)
        except (ValidationError, HTTPException) as exc:
            return project_chat_exception_ack(exc)

        room = project_chat_room(request.project_id, request.task_id)
        await self.enter_room(sid, room)
        latest_sequence = (
            messages[-1]["sequenceNumber"] if messages else request.after_sequence
        )
        try:
            while True:
                catch_up_request = request.model_copy(
                    update={"after_sequence": latest_sequence}
                )
                catch_up = await run_sync_in_executor(
                    _subscribe_project_chat_sync,
                    int(identity["user_id"]),
                    catch_up_request,
                )
                if not catch_up:
                    break
                messages.extend(catch_up)
                next_sequence = catch_up[-1]["sequenceNumber"]
                if next_sequence <= latest_sequence or len(catch_up) < request.limit:
                    latest_sequence = max(latest_sequence, next_sequence)
                    break
                latest_sequence = next_sequence
        except (ValidationError, HTTPException) as exc:
            await self.leave_room(sid, room)
            return project_chat_exception_ack(exc)
        return {
            "ok": True,
            "result": {
                "messages": messages,
                "currentUserId": str(identity["user_id"]),
                "latestSequence": latest_sequence,
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

    async def on_project_chat_comment_execute(self, sid: str, data: dict) -> dict:
        """Execute a saved project comment under its server-owned binding."""
        identity = await self._project_chat_identity(sid)
        if identity is None:
            return project_chat_error("UNAUTHENTICATED", "Not authenticated")
        from app.services.loop_item_executions.service import (
            WeworkRuntimeConfigurationError,
        )
        from app.services.project_chat.comment_execution import execute_comment

        try:
            request = ProjectChatCommentExecution.model_validate(
                project_chat_payload(data)
            )
            with get_db_session() as db:
                messages = await execute_comment(
                    db, user_id=int(identity["user_id"]), request=request
                )
                result = [
                    message.model_dump(mode="json", by_alias=True)
                    for message in messages
                ]
        except (ValidationError, HTTPException) as exc:
            return project_chat_exception_ack(exc)
        except WeworkRuntimeConfigurationError as exc:
            return project_chat_error("EXECUTION_CONFIGURATION", str(exc))
        except Exception:
            logger.exception("[ProjectChat] Comment execution failed")
            return project_chat_error(
                "EXECUTION_FAILED", "Comment saved, but AI execution could not start"
            )
        for message in result:
            await emit_project_chat_message(self, message)
        return {"ok": True, "result": result}


async def relay_ipc_request(
    *,
    user_id: int,
    device_id: str,
    method: str,
    params: dict[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    """Relay one supported app IPC method to the owning executor."""

    project_transcript = False
    if (
        method == "runtime.tasks.transcript"
        and params.get("projectSession") is not None
    ):
        try:
            user_id, params = await run_sync_in_executor(
                _project_transcript_request, user_id, device_id, params
            )
            project_transcript = True
        except (HTTPException, ValidationError) as exc:
            raise RuntimeRpcError(
                str(exc.detail) if isinstance(exc, HTTPException) else str(exc),
                code="project_session_access_denied",
            ) from exc

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
        try:
            route = await runtime_route_resolver.resolve(
                user_id=user_id,
                submitted_device_id=device_id,
            )
        except RuntimeRouteError as exc:
            raise RuntimeRpcError(
                str(exc),
                code=exc.code,
                retryable=exc.retryable,
                details=exc.details,
            ) from exc
        if not remote_control_is_enabled(route.device_type):
            raise RuntimeRpcError(
                REMOTE_CONTROL_DISABLED_MESSAGE,
                code="remote_control_disabled",
                retryable=False,
                details={"deviceId": route.logical_device_id},
            )
        return await local_device_command_service.execute_command(
            user_id=user_id,
            device_id=route.runtime_device_id,
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
        **({"allow_app_device_task_reading": True} if project_transcript else {}),
    )


def _project_transcript_request(
    user_id: int, device_id: str, params: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    from app.schemas.runtime_work import RuntimeTranscriptRequest
    from app.services.project_chat.session_access import resolve_project_transcript
    from app.services.runtime_work_service import _runtime_transcript_payload

    request = RuntimeTranscriptRequest.model_validate({**params, "deviceId": device_id})
    with get_db_session() as db:
        owner, address = resolve_project_transcript(db, user_id, request)
        return owner, _runtime_transcript_payload(request, address)


def ipc_error(
    data: Any,
    code: str,
    message: str,
    request_id: str | None = None,
    *,
    retryable: Optional[bool] = None,
    details: Optional[dict[str, Any]] = None,
) -> dict:
    """Build an app IPC-compatible error ACK."""

    error = {"code": code, "message": message}
    if retryable is not None:
        error["retryable"] = retryable
    if details:
        error["details"] = details
    return {
        "id": request_id or request_id_from(data),
        "ok": False,
        "error": error,
    }


def runtime_rpc_failure(result: dict, method: str) -> dict[str, Any]:
    """Translate an executor Runtime failure envelope without erasing its code."""

    error = result.get("error")
    if isinstance(error, str) and error.strip():
        return {
            "code": "runtime_rpc_failed",
            "message": error.strip(),
            "retryable": False,
            "details": {},
        }
    if isinstance(error, dict):
        code = error.get("code")
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return {
                "code": (
                    code.strip()
                    if isinstance(code, str) and code.strip()
                    else "runtime_rpc_failed"
                ),
                "message": message.strip(),
                "retryable": error.get("retryable") is True,
                "details": (
                    error.get("details")
                    if isinstance(error.get("details"), dict)
                    else {}
                ),
            }
    return {
        "code": "runtime_rpc_invalid_response",
        "message": f"Runtime RPC '{method}' returned an invalid failure response",
        "retryable": False,
        "details": {},
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


def _reconcile_execution_snapshot_sync(
    user_id: int, snapshot: RuntimeExecutionSnapshot
) -> list[dict[str, Any]]:
    with get_db_session() as db:
        return reconcile_execution_snapshot(db, user_id=user_id, snapshot=snapshot)


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
