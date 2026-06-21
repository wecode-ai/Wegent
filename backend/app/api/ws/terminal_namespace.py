# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser terminal Socket.IO namespace."""

import logging
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

import socketio
from socketio.exceptions import ConnectionRefusedError

from app.api.ws.connection_utils import enter_connect_room, save_connect_session
from app.api.ws.decorators import trace_websocket_event
from app.core.socketio import get_sio
from app.services.chat.access import get_token_expiry, verify_jwt_token
from app.services.device.terminal_session_service import (
    TerminalSessionRecord,
    terminal_session_service,
)
from shared.telemetry.context import set_request_context, set_user_context

logger = logging.getLogger(__name__)

TERMINAL_NAMESPACE = "/terminal"
DEVICE_NAMESPACE = "/local-executor"


class TerminalNamespace(socketio.AsyncNamespace):
    """Socket.IO namespace for browser-to-device terminal relay."""

    def __init__(self, namespace: str = TERMINAL_NAMESPACE):
        super().__init__(namespace)
        self._event_handlers: Dict[str, str] = {
            "terminal:attach": "on_terminal_attach",
            "terminal:input": "on_terminal_input",
            "terminal:resize": "on_terminal_resize",
            "terminal:close": "on_terminal_close",
        }

    @trace_websocket_event(
        exclude_events={"connect"},
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

        record = await terminal_session_service.authorize(session_id, user_id=user_id)
        if not record:
            return {"error": "Terminal session not found or access denied"}

        previous_session_id = session.get("terminal_session_id")
        if (
            isinstance(previous_session_id, str)
            and previous_session_id
            and previous_session_id != session_id
        ):
            await self.leave_room(sid, _terminal_room(previous_session_id))

        await self.enter_room(sid, _terminal_room(session_id))
        session["terminal_session_id"] = session_id
        await self.save_session(sid, session)

        return {
            "success": True,
            "session_id": record.session_id,
            "device_id": record.device_id,
            "project_id": record.project_id,
            "path": record.path,
        }

    async def on_terminal_input(self, sid: str, data: dict) -> dict:
        """Relay browser terminal input to the owning executor socket."""
        record, error = await self._authorize_attached_session(sid, data)
        if error:
            return error

        text = data.get("data")
        if not isinstance(text, str):
            return {"error": "Invalid terminal input"}

        await get_sio().emit(
            "terminal:input",
            {"session_id": record.session_id, "data": text},
            to=record.socket_id,
            namespace=DEVICE_NAMESPACE,
        )
        return {"success": True}

    async def on_terminal_resize(self, sid: str, data: dict) -> dict:
        """Relay terminal resize events to the owning executor socket."""
        record, error = await self._authorize_attached_session(sid, data)
        if error:
            return error

        rows = _get_positive_int(data, "rows")
        cols = _get_positive_int(data, "cols")
        if rows is None or cols is None:
            return {"error": "Invalid terminal dimensions"}

        await get_sio().emit(
            "terminal:resize",
            {"session_id": record.session_id, "rows": rows, "cols": cols},
            to=record.socket_id,
            namespace=DEVICE_NAMESPACE,
        )
        return {"success": True}

    async def on_terminal_close(self, sid: str, data: dict) -> dict:
        """Close the executor PTY and remove the backend session record."""
        record, error = await self._authorize_attached_session(sid, data)
        if error:
            return error

        await get_sio().emit(
            "terminal:close",
            {"session_id": record.session_id},
            to=record.socket_id,
            namespace=DEVICE_NAMESPACE,
        )
        await terminal_session_service.delete(record.session_id)
        await self.leave_room(sid, _terminal_room(record.session_id))
        session = await self.get_session(sid)
        if session.get("terminal_session_id") == record.session_id:
            session["terminal_session_id"] = None
            await self.save_session(sid, session)
        return {"success": True}

    async def _authorize_attached_session(
        self,
        sid: str,
        data: dict,
    ) -> tuple[Optional[TerminalSessionRecord], Optional[dict]]:
        session = await self.get_session(sid)
        if await self._check_token_expiry(session):
            return None, await self._handle_token_expired(sid)

        user_id = session.get("user_id")
        if not user_id:
            return None, {"error": "Not authenticated"}

        session_id = _get_session_id(data)
        if not session_id:
            return None, {"error": "Missing session_id"}

        if session.get("terminal_session_id") != session_id:
            return None, {"error": "Terminal session is not attached"}

        record = await terminal_session_service.authorize(session_id, user_id=user_id)
        if not record:
            return None, {"error": "Terminal session not found or access denied"}
        return record, None

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
    return session_id.strip() if isinstance(session_id, str) else ""


def _get_positive_int(data: dict, key: str) -> Optional[int]:
    value = data.get(key) if isinstance(data, dict) else None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _terminal_room(session_id: str) -> str:
    return f"terminal:{session_id}"


def register_terminal_namespace(sio: socketio.AsyncServer) -> None:
    """Register the terminal namespace with the Socket.IO server."""
    sio.register_namespace(TerminalNamespace(TERMINAL_NAMESPACE))
    logger.info("Terminal namespace registered at %s", TERMINAL_NAMESPACE)
