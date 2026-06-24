# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral IM control operations for commands and skills."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.im_session import IMPrivateSession, IMSessionMode
from app.services.im.session_service import im_session_service

PENDING_ACTION_PREFIX = "im:control:pending_action:"
PENDING_ACTION_TTL_SECONDS = 10 * 60


@dataclass(frozen=True)
class IMControlContext:
    session: IMPrivateSession
    bot_purpose: str


class IMControlService:
    """Single service for mutating private IM control state."""

    async def get_current_state(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        bot_purpose: str,
    ) -> dict[str, Any]:
        return self._success(
            "当前状态已获取。",
            state=self._build_state(session, bot_purpose),
        )

    async def start_new_session(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        bot_purpose: str,
    ) -> dict[str, Any]:
        session.mode = (
            IMSessionMode.CHAT if bot_purpose == "wegent_chat" else IMSessionMode.TASK
        )
        session.active_task_id = None
        session.active_runtime_task = None
        session.current_target_type = (
            "conversation"
            if bot_purpose == "wegent_chat"
            else "wework_local_conversation"
        )
        session.current_target = {}
        session.pending_action_id = None
        await im_session_service.save_session(session)
        message = (
            "已开始新对话。"
            if bot_purpose == "wegent_chat"
            else "已开始新的 Wework 本地对话。"
        )
        return self._success(message, state=self._build_state(session, bot_purpose))

    async def clear_current_session(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        bot_purpose: str,
    ) -> dict[str, Any]:
        if bot_purpose == "wework_local" and session.active_runtime_task:
            action_id = await self._store_pending_action(
                session,
                {"type": "clear_current_session", "bot_purpose": bot_purpose},
            )
            session.pending_action_id = action_id
            await im_session_service.save_session(session)
            return {
                "status": "needs_confirmation",
                "message": "这会清除当前 Wework 任务绑定。",
                "state": self._build_state(session, bot_purpose),
                "confirmation": {
                    "action_id": action_id,
                    "summary": "清除当前 Wework 任务绑定",
                },
            }
        return await self._clear_now(db, session=session, bot_purpose=bot_purpose)

    async def confirm_pending_action(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        bot_purpose: str,
        action_id: str,
    ) -> dict[str, Any]:
        action = await cache_manager.get(self._pending_action_key(action_id))
        if (
            not isinstance(action, dict)
            or action.get("session_key") != session.session_key
        ):
            return self._error("确认操作已过期，请重新发起。", session, bot_purpose)
        if action.get("type") == "clear_current_session":
            await cache_manager.delete(self._pending_action_key(action_id))
            return await self._clear_now(
                db,
                session=session,
                bot_purpose=bot_purpose,
            )
        return self._error("无法识别的确认操作。", session, bot_purpose)

    async def cancel_pending_action(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        bot_purpose: str,
        action_id: str | None = None,
    ) -> dict[str, Any]:
        if action_id:
            await cache_manager.delete(self._pending_action_key(action_id))
        session.pending_action_id = None
        await im_session_service.save_session(session)
        return self._success("已取消。", state=self._build_state(session, bot_purpose))

    async def _clear_now(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        bot_purpose: str,
    ) -> dict[str, Any]:
        await im_session_service.clear_active_task(db, session=session)
        session.current_target_type = None
        session.current_target = None
        session.pending_action_id = None
        await im_session_service.save_session(session)
        return self._success(
            "已清除当前会话。", state=self._build_state(session, bot_purpose)
        )

    async def _store_pending_action(
        self,
        session: IMPrivateSession,
        payload: dict[str, Any],
    ) -> str:
        action_id = f"im_action_{uuid4().hex}"
        await cache_manager.set(
            self._pending_action_key(action_id),
            {"session_key": session.session_key, **payload},
            expire=PENDING_ACTION_TTL_SECONDS,
        )
        return action_id

    def _pending_action_key(self, action_id: str) -> str:
        return f"{PENDING_ACTION_PREFIX}{action_id}"

    def _build_state(
        self,
        session: IMPrivateSession,
        bot_purpose: str,
    ) -> dict[str, Any]:
        target_label = ""
        if isinstance(session.active_runtime_task, dict):
            target_label = str(
                session.active_runtime_task.get("title")
                or session.active_runtime_task.get("localTaskId")
                or ""
            )
        elif session.active_task_id:
            target_label = f"Task {session.active_task_id}"
        return {
            "bot_purpose": bot_purpose,
            "mode": session.mode,
            "state": session.state,
            "current_target_type": self._current_target_type(session),
            "current_target_label": target_label,
            "pending_action_id": session.pending_action_id,
            "available_actions": [
                "get_current_state",
                "start_new_session",
                "clear_current_session",
                "cancel_pending_action",
            ],
        }

    def _current_target_type(self, session: IMPrivateSession) -> str | None:
        if session.active_runtime_task:
            return "wework_runtime_task"
        if session.active_task_id:
            return "wegent_task"
        return session.current_target_type

    def _success(self, message: str, *, state: dict[str, Any]) -> dict[str, Any]:
        return {
            "status": "success",
            "message": message,
            "state": state,
            "confirmation": None,
        }

    def _error(
        self,
        message: str,
        session: IMPrivateSession,
        bot_purpose: str,
    ) -> dict[str, Any]:
        return {
            "status": "error",
            "message": message,
            "state": self._build_state(session, bot_purpose),
            "confirmation": None,
        }


im_control_service = IMControlService()
