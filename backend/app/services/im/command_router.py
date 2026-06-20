# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral private IM task/chat command routing."""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Sequence

from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession, IMSessionMode, IMSessionState
from app.services.channels.commands import CommandType, parse_command
from app.services.im.session_service import im_session_service


class IMCommandAction(str, Enum):
    """Deferred action requested by the private IM command router."""

    NONE = "none"
    START_CHAT = "start_chat"
    BIND_TASK = "bind_task"
    CONTINUE_TASK = "continue_task"
    CREATE_TASK = "create_task"


@dataclass
class IMCommandResult:
    """Result of routing a private IM command or task-mode message."""

    handled: bool
    action: IMCommandAction = IMCommandAction.NONE
    reply: str | None = None
    task_id: int | None = None
    project_id: int | None = None
    message: str | None = None


@dataclass(frozen=True)
class _ChoiceOption:
    id: int
    label: str


class IMCommandRouter:
    """Route private IM commands without depending on a provider SDK."""

    def route(
        self,
        db: Session,
        session: IMPrivateSession,
        content: str,
        recent_tasks: Sequence[Any],
        projects: Sequence[Any],
    ) -> IMCommandResult:
        text = (content or "").strip()
        if not text:
            return IMCommandResult(handled=False)

        pending_payload = im_session_service.get_active_pending_payload(db, session)
        if pending_payload is not None:
            return self._route_pending(
                db=db,
                session=session,
                text=text,
                payload=pending_payload,
                recent_tasks=recent_tasks,
                projects=projects,
            )

        command = parse_command(text)
        if command is not None:
            return self._route_command(
                db=db,
                session=session,
                command=command.command,
                argument=command.argument,
                recent_tasks=recent_tasks,
                projects=projects,
            )

        if session.mode == IMSessionMode.TASK:
            if session.active_task_id:
                return IMCommandResult(
                    handled=True,
                    action=IMCommandAction.CONTINUE_TASK,
                    task_id=session.active_task_id,
                    message=text,
                )
            return self._begin_task_creation(
                db=db,
                session=session,
                projects=projects,
                first_message=text,
            )

        return IMCommandResult(handled=False)

    def _route_command(
        self,
        *,
        db: Session,
        session: IMPrivateSession,
        command: CommandType,
        argument: str | None,
        recent_tasks: Sequence[Any],
        projects: Sequence[Any],
    ) -> IMCommandResult:
        if command == CommandType.BIND:
            return IMCommandResult(
                handled=True,
                reply="已绑定当前私聊会话。",
            )

        if command == CommandType.MODE:
            mode = (argument or "").strip().lower()
            if mode in {"chat", "task"}:
                if mode == "chat":
                    im_session_service.set_mode(
                        db, session=session, mode=IMSessionMode.CHAT
                    )
                    return IMCommandResult(handled=True, reply="已切换到 Chat 模式。")

                im_session_service.set_mode(
                    db, session=session, mode=IMSessionMode.TASK
                )
                if session.active_task_id:
                    return IMCommandResult(
                        handled=True,
                        reply=f"当前为 Task 模式，任务 ID：{session.active_task_id}。",
                    )
                return self._begin_task_switch(
                    db=db,
                    session=session,
                    recent_tasks=recent_tasks,
                )

            return IMCommandResult(handled=True, reply=self._format_mode_reply(session))

        if command == CommandType.CHAT:
            im_session_service.set_mode(db, session=session, mode=IMSessionMode.CHAT)
            return IMCommandResult(handled=True, reply="已切换到 Chat 模式。")

        if command == CommandType.TASK:
            im_session_service.set_mode(db, session=session, mode=IMSessionMode.TASK)
            if session.active_task_id:
                return IMCommandResult(
                    handled=True,
                    reply=f"当前为 Task 模式，任务 ID：{session.active_task_id}。",
                )
            return self._begin_task_switch(
                db=db,
                session=session,
                recent_tasks=recent_tasks,
            )

        if command == CommandType.SWITCH:
            im_session_service.set_mode(db, session=session, mode=IMSessionMode.TASK)
            return self._begin_task_switch(
                db=db,
                session=session,
                recent_tasks=recent_tasks,
            )

        if command == CommandType.NEW:
            return self._begin_new_flow(db=db, session=session)

        if command == CommandType.CANCEL:
            im_session_service.cancel_pending(db, session=session)
            return IMCommandResult(handled=True, reply="已取消。")

        return IMCommandResult(handled=False)

    def _route_pending(
        self,
        *,
        db: Session,
        session: IMPrivateSession,
        text: str,
        payload: dict[str, Any],
        recent_tasks: Sequence[Any],
        projects: Sequence[Any],
    ) -> IMCommandResult:
        command = parse_command(text)
        if command is not None and command.command == CommandType.CANCEL:
            im_session_service.cancel_pending(db, session=session)
            return IMCommandResult(handled=True, reply="已取消。")

        if session.state == IMSessionState.PENDING_NEW_FLOW:
            return self._route_pending_new_flow(
                db=db,
                session=session,
                text=text,
                recent_tasks=recent_tasks,
                projects=projects,
            )

        if session.state == IMSessionState.PENDING_TASK_SWITCH:
            return self._route_pending_task_switch(
                db=db,
                session=session,
                text=text,
                payload=payload,
                projects=projects,
            )

        if session.state == IMSessionState.PENDING_TASK_CREATION:
            return self._route_pending_task_creation(
                db=db,
                session=session,
                text=text,
                payload=payload,
            )

        return IMCommandResult(handled=True, reply="请输入序号，或发送 /cancel 取消。")

    def _route_pending_task_switch(
        self,
        *,
        db: Session,
        session: IMPrivateSession,
        text: str,
        payload: dict[str, Any],
        projects: Sequence[Any],
    ) -> IMCommandResult:
        if text.lower() == "new":
            return self._begin_task_creation(
                db=db,
                session=session,
                projects=projects,
                first_message=str(payload.get("first_message") or ""),
            )

        task_id = self._select_id(payload.get("task_ids"), text)
        if task_id is None:
            return IMCommandResult(
                handled=True,
                reply="请输入任务序号，回复 new 新建任务，或发送 /cancel 取消。",
            )

        return IMCommandResult(
            handled=True,
            action=IMCommandAction.BIND_TASK,
            reply=f"已选择任务 {task_id}。",
            task_id=task_id,
        )

    def _route_pending_task_creation(
        self,
        *,
        db: Session,
        session: IMPrivateSession,
        text: str,
        payload: dict[str, Any],
    ) -> IMCommandResult:
        if "selected_project_id" in payload:
            if parse_command(text) is not None:
                return IMCommandResult(
                    handled=True,
                    reply="请发送任务内容，或发送 /cancel 取消。",
                )
            return IMCommandResult(
                handled=True,
                action=IMCommandAction.CREATE_TASK,
                reply="已开始创建任务。",
                project_id=self._coerce_int(payload.get("selected_project_id")),
                message=text,
            )

        project_ids = self._normalize_ids(payload.get("project_ids"))
        if not text.isdigit():
            return IMCommandResult(
                handled=True,
                reply="请输入项目序号，或发送 /cancel 取消。",
            )

        choice = int(text)
        if choice == 0:
            project_id = None
        else:
            project_id = self._select_id(project_ids, text)
            if project_id is None:
                return IMCommandResult(
                    handled=True,
                    reply="项目序号无效，请重新输入，或发送 /cancel 取消。",
                )

        message = str(payload.get("first_message") or "").strip()
        if not message:
            updated_payload = {**payload, "selected_project_id": project_id}
            im_session_service.set_pending_state(
                db=db,
                session=session,
                state=IMSessionState.PENDING_TASK_CREATION,
                payload=updated_payload,
            )
            return IMCommandResult(
                handled=True,
                reply="请发送任务内容，或发送 /cancel 取消。",
            )

        return IMCommandResult(
            handled=True,
            action=IMCommandAction.CREATE_TASK,
            reply="已开始创建任务。",
            project_id=project_id,
            message=message,
        )

    def _begin_new_flow(
        self,
        *,
        db: Session,
        session: IMPrivateSession,
    ) -> IMCommandResult:
        im_session_service.set_pending_state(
            db=db,
            session=session,
            state=IMSessionState.PENDING_NEW_FLOW,
            payload={},
            force_task_mode=False,
        )
        return IMCommandResult(handled=True, reply=self._format_new_flow_reply())

    def _route_pending_new_flow(
        self,
        *,
        db: Session,
        session: IMPrivateSession,
        text: str,
        recent_tasks: Sequence[Any],
        projects: Sequence[Any],
    ) -> IMCommandResult:
        normalized = text.strip().lower()
        if normalized in {"1", "chat"}:
            im_session_service.set_mode(db, session=session, mode=IMSessionMode.CHAT)
            return IMCommandResult(
                handled=True,
                action=IMCommandAction.START_CHAT,
                reply="已开始新 Chat，请发送消息。",
            )

        if normalized in {"2", "task"}:
            im_session_service.set_mode(db, session=session, mode=IMSessionMode.TASK)
            return self._begin_task_creation(
                db=db,
                session=session,
                projects=projects,
                first_message="",
            )

        if normalized in {"3", "switch", "recent"}:
            im_session_service.set_mode(db, session=session, mode=IMSessionMode.TASK)
            return self._begin_task_switch(
                db=db,
                session=session,
                recent_tasks=recent_tasks,
            )

        return IMCommandResult(
            handled=True,
            reply="请输入 1、2 或 3，或发送 /cancel 取消。",
        )

    def _begin_task_switch(
        self,
        *,
        db: Session,
        session: IMPrivateSession,
        recent_tasks: Sequence[Any],
    ) -> IMCommandResult:
        task_options = self._build_options(recent_tasks, fallback_prefix="任务")
        im_session_service.set_pending_state(
            db=db,
            session=session,
            state=IMSessionState.PENDING_TASK_SWITCH,
            payload={"task_ids": [option.id for option in task_options]},
        )
        return IMCommandResult(
            handled=True,
            reply=self._format_task_switch_reply(task_options),
        )

    def _begin_task_creation(
        self,
        *,
        db: Session,
        session: IMPrivateSession,
        projects: Sequence[Any],
        first_message: str,
    ) -> IMCommandResult:
        project_options = self._build_options(projects, fallback_prefix="项目")
        im_session_service.set_pending_state(
            db=db,
            session=session,
            state=IMSessionState.PENDING_TASK_CREATION,
            payload={
                "first_message": first_message,
                "project_ids": [option.id for option in project_options],
            },
        )
        return IMCommandResult(
            handled=True,
            reply=self._format_project_selection_reply(project_options),
        )

    def _format_mode_reply(self, session: IMPrivateSession) -> str:
        mode_name = "Task" if session.mode == IMSessionMode.TASK else "Chat"
        if session.active_task_id:
            return f"当前模式：{mode_name}，任务 ID：{session.active_task_id}。"
        return f"当前模式：{mode_name}。"

    def _format_new_flow_reply(self) -> str:
        return "\n".join(
            [
                "请选择新建类型：",
                "1. 新建 Chat",
                "2. 新建 Task",
                "3. 继续最近 Task",
                "",
                "回复序号选择，发送 /cancel 取消。",
            ]
        )

    def _format_task_switch_reply(self, task_options: list[_ChoiceOption]) -> str:
        if not task_options:
            return "暂无最近任务。回复 new 创建新任务，或发送 /cancel 取消。"

        lines = ["最近任务："]
        lines.extend(
            f"{index}. {option.label}（{option.id}）"
            for index, option in enumerate(task_options, start=1)
        )
        lines.append("回复序号绑定，回复 new 新建任务，或发送 /cancel 取消。")
        return "\n".join(lines)

    def _format_project_selection_reply(
        self, project_options: list[_ChoiceOption]
    ) -> str:
        lines = ["选择项目：", "0. 不关联项目"]
        lines.extend(
            f"{index}. {option.label}（{option.id}）"
            for index, option in enumerate(project_options, start=1)
        )
        lines.append("回复序号创建任务，或发送 /cancel 取消。")
        return "\n".join(lines)

    def _build_options(
        self, items: Sequence[Any], *, fallback_prefix: str
    ) -> list[_ChoiceOption]:
        options: list[_ChoiceOption] = []
        for item in items:
            item_id = self._extract_int(item, "id", "task_id", "project_id")
            if item_id is None:
                continue
            label = self._extract_text(item, "title", "name", "display_name")
            options.append(
                _ChoiceOption(
                    id=item_id,
                    label=label or f"{fallback_prefix} {item_id}",
                )
            )
        return options

    def _select_id(self, ids: Any, text: str) -> int | None:
        normalized_ids = self._normalize_ids(ids)
        if not text.isdigit():
            return None

        index = int(text)
        if index < 1 or index > len(normalized_ids):
            return None
        return normalized_ids[index - 1]

    def _normalize_ids(self, ids: Any) -> list[int]:
        if not isinstance(ids, list):
            return []

        normalized: list[int] = []
        for item in ids:
            item_id = self._coerce_int(item)
            if item_id is not None:
                normalized.append(item_id)
        return normalized

    def _extract_int(self, item: Any, *keys: str) -> int | None:
        for key in keys:
            value = self._extract_value(item, key)
            item_id = self._coerce_int(value)
            if item_id is not None:
                return item_id
        return None

    def _extract_text(self, item: Any, *keys: str) -> str:
        for key in keys:
            value = self._extract_value(item, key)
            if value is not None:
                text = str(value).strip()
                if text:
                    return text
        return ""

    def _extract_value(self, item: Any, key: str) -> Any:
        if isinstance(item, dict):
            return item.get(key)
        return getattr(item, key, None)

    def _coerce_int(self, value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
        return None


im_command_router = IMCommandRouter()
