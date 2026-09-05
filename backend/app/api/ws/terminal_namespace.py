# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser terminal Socket.IO namespace."""

import logging
import re
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

import socketio
from socketio.exceptions import ConnectionRefusedError

from app.api.ws.connection_utils import enter_connect_room, save_connect_session
from app.api.ws.decorators import trace_websocket_event
from app.core.socketio import get_sio
from app.services.chat.access import get_token_expiry, verify_jwt_token
from app.services.device.terminal_metrics import record_terminal_event
from app.services.device.terminal_session_service import (
    TerminalSessionRecord,
    normalize_terminal_session_id,
    terminal_session_service,
)
from app.services.device_service import device_service
from shared.telemetry.context import set_request_context, set_user_context

logger = logging.getLogger(__name__)

TERMINAL_NAMESPACE = "/terminal"
DEVICE_NAMESPACE = "/local-executor"
TERMINAL_ATTACH_TIMEOUT_SECONDS = 5
TERMINAL_CONSUMER_ID_MAX_LENGTH = 128
TERMINAL_CONSUMER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
TERMINAL_TRACE_EXCLUDED_EVENTS = {
    "connect",
    "terminal:ack",
    "terminal:input",
    "terminal:resize",
}


class TerminalNamespace(socketio.AsyncNamespace):
    """Socket.IO namespace for browser-to-device terminal relay."""

    def __init__(self, namespace: str = TERMINAL_NAMESPACE):
        super().__init__(namespace)
        self._event_handlers: Dict[str, str] = {
            "terminal:attach": "on_terminal_attach",
            "terminal:ack": "on_terminal_ack",
            "terminal:input": "on_terminal_input",
            "terminal:resize": "on_terminal_resize",
            "terminal:close": "on_terminal_close",
        }

    @trace_websocket_event(
        exclude_events=TERMINAL_TRACE_EXCLUDED_EVENTS,
        extract_event_data=True,
    )
    async def trigger_event(self, event: str, sid: str, *args):
        """Route colon-separated terminal event names to explicit handlers."""
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
        """Authenticate browser terminal clients with the existing JWT token."""
        request_id = str(uuid.uuid4())[:8]
        set_request_context(request_id)

        if not auth or not isinstance(auth, dict):
            logger.warning("[Terminal WS] Missing auth data sid=%s", sid)
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning("[Terminal WS] Missing token in auth sid=%s", sid)
            raise ConnectionRefusedError("Missing authentication token")

        user = verify_jwt_token(token)
        if not user:
            logger.warning("[Terminal WS] Invalid JWT token sid=%s", sid)
            raise ConnectionRefusedError("Invalid or expired token")

        token_exp = get_token_expiry(token)
        await save_connect_session(
            self,
            sid,
            session_data={
                "user_id": user.id,
                "user_name": user.user_name,
                "request_id": request_id,
                "token_exp": token_exp,
                "auth_token": token,
                "terminal_session_id": None,
                "terminal_consumer_id": None,
                "terminal_authorization": None,
            },
            logger=logger,
            log_prefix="[Terminal WS]",
        )

        set_user_context(user_id=str(user.id), user_name=user.user_name)

        await enter_connect_room(
            self,
            sid,
            f"user:{user.id}",
            logger=logger,
            log_prefix="[Terminal WS]",
        )

        logger.info("[Terminal WS] Connected user=%s sid=%s", user.id, sid)

    async def on_terminal_attach(self, sid: str, data: dict) -> dict:
        """Attach a browser socket to an existing backend-created terminal session."""
        session = await self.get_session(sid)
        if await self._check_token_expiry(session):
            return await self._handle_token_expired(sid)

        user_id = session.get("user_id")
        if not user_id:
            return {"error": "Not authenticated"}

        session_id = _get_session_id(data)
        if not session_id:
            return {"error": "Missing session_id"}
        consumer_id = _get_consumer_id(data)
        if not consumer_id:
            return {"error": "Invalid consumer_id"}

        last_acked_sequence = _get_non_negative_sequence(
            data,
            "last_acked_sequence",
        )
        if last_acked_sequence is None:
            return {"error": "Invalid last_acked_sequence"}

        record = await terminal_session_service.authorize(
            session_id,
            user_id=user_id,
            refresh=True,
        )
        if not record:
            return {"error": "Terminal session not found or access denied"}

        previous_session_id = session.get("terminal_session_id")
        executor_socket_id = await _active_executor_socket(record)
        if not executor_socket_id:
            return {"error": "Terminal executor is offline"}
        await self.enter_room(sid, _terminal_room(session_id))
        try:
            attach_result = await get_sio().call(
                "terminal:attach",
                {
                    "session_id": record.session_id,
                    "consumer_id": consumer_id,
                    "last_acked_sequence": last_acked_sequence,
                },
                to=executor_socket_id,
                namespace=DEVICE_NAMESPACE,
                timeout=TERMINAL_ATTACH_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            await self.leave_room(sid, _terminal_room(session_id))
            logger.warning(
                "[Terminal WS] Executor attach failed session=%s device=%s: %s",
                record.session_id,
                record.device_id,
                exc,
            )
            return {"error": "Failed to attach terminal executor"}

        if not isinstance(attach_result, dict) or not attach_result.get("success"):
            await self.leave_room(sid, _terminal_room(session_id))
            error = (
                attach_result.get("error")
                if isinstance(attach_result, dict)
                else "Invalid executor response"
            )
            return {"error": str(error or "Failed to attach terminal executor")}

        if executor_socket_id != record.socket_id:
            rebound = await terminal_session_service.rebind_socket(
                record,
                executor_socket_id,
            )
            if not rebound:
                await self.leave_room(sid, _terminal_room(session_id))
                return {"error": "Terminal session could not be rebound"}
            record = rebound

        if (
            isinstance(previous_session_id, str)
            and previous_session_id
            and previous_session_id != session_id
        ):
            await self.leave_room(sid, _terminal_room(previous_session_id))

        session["terminal_session_id"] = session_id
        session["terminal_consumer_id"] = consumer_id
        session["terminal_authorization"] = record
        await self.save_session(sid, session)
        record_terminal_event(source="browser", event="attach")

        return {
            "success": True,
            "session_id": record.session_id,
            "device_id": record.device_id,
            "project_id": record.project_id,
            "path": record.path,
        }

    async def on_terminal_ack(self, sid: str, data: dict) -> dict:
        """Relay a browser output acknowledgement to the owning executor."""
        record, consumer_id, error = await self._authorize_attached_session(sid, data)
        if error:
            return error

        sequence = _get_positive_sequence(data, "sequence")
        if sequence is None:
            return {"error": "Invalid terminal sequence"}
        try:
            ack_result = await get_sio().call(
                "terminal:ack",
                {
                    "session_id": record.session_id,
                    "consumer_id": consumer_id,
                    "sequence": sequence,
                },
                to=record.socket_id,
                namespace=DEVICE_NAMESPACE,
                timeout=TERMINAL_ATTACH_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning(
                "[Terminal WS] Executor ACK failed session=%s device=%s: %s",
                record.session_id,
                record.device_id,
                exc,
            )
            return {"error": "Failed to acknowledge terminal output"}
        if not isinstance(ack_result, dict) or not ack_result.get("success"):
            error = (
                ack_result.get("error")
                if isinstance(ack_result, dict)
                else "Invalid executor response"
            )
            return {"error": str(error or "Failed to acknowledge terminal output")}
        record_terminal_event(source="browser", event="ack")
        return {"success": True}

    async def on_terminal_input(self, sid: str, data: dict) -> dict:
        """Relay browser terminal input to the owning executor socket."""
        record, consumer_id, error = await self._authorize_attached_session(sid, data)
        if error:
            return error

        text = data.get("data")
        if not isinstance(text, str):
            return {"error": "Invalid terminal input"}
        await get_sio().emit(
            "terminal:input",
            {
                "session_id": record.session_id,
                "consumer_id": consumer_id,
                "data": text,
            },
            to=record.socket_id,
            namespace=DEVICE_NAMESPACE,
        )
        record_terminal_event(source="browser", event="input")
        return {"success": True}

    async def on_terminal_resize(self, sid: str, data: dict) -> dict:
        """Relay terminal resize events to the owning executor socket."""
        record, consumer_id, error = await self._authorize_attached_session(sid, data)
        if error:
            return error

        rows = _get_positive_int(data, "rows")
        cols = _get_positive_int(data, "cols")
        if rows is None or cols is None:
            return {"error": "Invalid terminal dimensions"}
        await get_sio().emit(
            "terminal:resize",
            {
                "session_id": record.session_id,
                "consumer_id": consumer_id,
                "rows": rows,
                "cols": cols,
            },
            to=record.socket_id,
            namespace=DEVICE_NAMESPACE,
        )
        record_terminal_event(source="browser", event="resize")
        return {"success": True}

    async def on_terminal_close(self, sid: str, data: dict) -> dict:
        """Close the executor PTY and remove the backend session record."""
        record, consumer_id, error = await self._authorize_attached_session(sid, data)
        if error:
            return error

        try:
            close_result = await get_sio().call(
                "terminal:close",
                {
                    "session_id": record.session_id,
                    "consumer_id": consumer_id,
                },
                to=record.socket_id,
                namespace=DEVICE_NAMESPACE,
                timeout=TERMINAL_ATTACH_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning(
                "[Terminal WS] Executor close failed session=%s device=%s: %s",
                record.session_id,
                record.device_id,
                exc,
            )
            return {"error": "Failed to close terminal executor"}
        if not isinstance(close_result, dict) or not close_result.get("success"):
            error = (
                close_result.get("error")
                if isinstance(close_result, dict)
                else "Invalid executor response"
            )
            return {"error": str(error or "Failed to close terminal executor")}
        try:
            await terminal_session_service.delete(record.session_id)
        except Exception as exc:
            logger.warning(
                "[Terminal WS] Failed to revoke terminal session=%s: %s",
                record.session_id,
                exc,
            )
            return {"error": "Failed to close terminal session"}
        await self.leave_room(sid, _terminal_room(record.session_id))
        session = await self.get_session(sid)
        if session.get("terminal_session_id") == record.session_id:
            session["terminal_session_id"] = None
            session["terminal_consumer_id"] = None
            session["terminal_authorization"] = None
            await self.save_session(sid, session)
        record_terminal_event(source="browser", event="close")
        return {"success": True}

    async def _authorize_attached_session(
        self,
        sid: str,
        data: dict,
    ) -> tuple[Optional[TerminalSessionRecord], str, Optional[dict]]:
        session = await self.get_session(sid)
        if await self._check_token_expiry(session):
            return None, "", await self._handle_token_expired(sid)

        user_id = session.get("user_id")
        if not user_id:
            return None, "", {"error": "Not authenticated"}

        session_id = _get_session_id(data)
        if not session_id:
            return None, "", {"error": "Missing session_id"}

        if session.get("terminal_session_id") != session_id:
            return None, "", {"error": "Terminal session is not attached"}
        consumer_id = session.get("terminal_consumer_id")
        if not isinstance(consumer_id, str) or not consumer_id:
            return None, "", {"error": "Terminal consumer is no longer active"}

        record_data = session.get("terminal_authorization")
        if not isinstance(record_data, TerminalSessionRecord):
            return None, "", {"error": "Terminal session is not attached"}
        record = record_data

        if record.session_id != session_id or record.user_id != user_id:
            return None, "", {"error": "Terminal session not found or access denied"}
        if record.is_expired():
            return None, "", {"error": "Terminal session expired"}
        if not terminal_session_service.is_authorization_current(record):
            refreshed = await terminal_session_service.authorize(
                session_id,
                user_id=user_id,
                refresh=True,
            )
            if not refreshed or refreshed.device_id != record.device_id:
                return None, "", {"error": "Terminal session must be reattached"}
            record = refreshed
            session["terminal_authorization"] = refreshed
            await self.save_session(sid, session)
        if terminal_session_service.is_revoked(session_id):
            return None, "", {"error": "Terminal session not found or access denied"}
        return record, consumer_id, None

    async def _check_token_expiry(self, session: dict[str, Any]) -> bool:
        token_exp = session.get("token_exp")
        if not token_exp:
            return True
        return datetime.now().timestamp() > token_exp

    async def _handle_token_expired(self, sid: str) -> dict:
        logger.warning("[Terminal WS] Token expired for sid=%s", sid)
        await self.emit(
            "auth_error",
            {"error": "Token expired", "code": "TOKEN_EXPIRED"},
            to=sid,
        )
        await self.disconnect(sid)
        return {"error": "Token expired"}


def _get_session_id(data: dict) -> str:
    session_id = data.get("session_id") if isinstance(data, dict) else None
    return normalize_terminal_session_id(session_id)


def _get_positive_int(data: dict, key: str) -> Optional[int]:
    value = data.get(key) if isinstance(data, dict) else None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _get_non_negative_sequence(data: dict, key: str) -> Optional[int]:
    value = data.get(key) if isinstance(data, dict) else None
    return value if type(value) is int and value >= 0 else None


def _get_positive_sequence(data: dict, key: str) -> Optional[int]:
    value = data.get(key) if isinstance(data, dict) else None
    return value if type(value) is int and value > 0 else None


def _get_consumer_id(data: dict) -> str:
    value = data.get("consumer_id") if isinstance(data, dict) else None
    if not isinstance(value, str):
        return ""
    consumer_id = value.strip()
    if (
        not consumer_id
        or len(consumer_id) > TERMINAL_CONSUMER_ID_MAX_LENGTH
        or not TERMINAL_CONSUMER_ID_PATTERN.fullmatch(consumer_id)
    ):
        return ""
    return consumer_id


def _terminal_room(session_id: str) -> str:
    return f"terminal:{session_id}"


async def _active_executor_socket(record: TerminalSessionRecord) -> str:
    online_info = await device_service.get_device_online_info(
        record.user_id,
        record.device_id,
    )
    socket_id = online_info.get("socket_id") if online_info else None
    return socket_id.strip() if isinstance(socket_id, str) else ""


def register_terminal_namespace(sio: socketio.AsyncServer) -> None:
    """Register the terminal namespace with the Socket.IO server."""
    sio.register_namespace(TerminalNamespace(TERMINAL_NAMESPACE))
    logger.info("Terminal namespace registered at %s", TERMINAL_NAMESPACE)
