# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep Wegent chat intact and route Wework stand-in mode independently."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession, IMSessionMode
from app.models.user import User
from app.services.channels.commands import CommandType, ParsedCommand, parse_command
from app.services.channels.device_selection import device_selection_manager
from app.services.im.session_service import im_session_service
from app.services.im.stand_in_service import send_stand_in_message
from shared.telemetry.decorators import trace_async

GUIDANCE = (
    "当前为 Wework 分身模式。发送 /chat 返回 Wegent 聊天。"
    "连接或切换分身，请打开 Wework“我的分身”的分身设置"
    "（分身详情 → 管理分身 → IM 对话）。"
)
RETIRED_TASK_GUIDANCE = (
    "任务模式已移除。发送 /standin 进入 Wework 分身模式，或 /chat 返回 Wegent 聊天。"
)
NOTIFY_ON_ARGS = {"on", "open", "enable", "enabled", "true", "1", "开", "开启", "打开"}
NOTIFY_OFF_ARGS = {"off", "close", "disable", "disabled", "false", "0", "关", "关闭"}
NOTIFY_STATUS_ARGS = {"", "status", "状态", "state"}


class IMInteractionService:
    """A routing mode never changes the other mode's task or device identity."""

    @trace_async("im.private.route", "im")
    async def route_private_message(
        self,
        *,
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        message_context: Any,
        port: Any,
    ) -> bool:
        command = parse_command(message_context.content)
        if command:
            if command.command == CommandType.NOTIFY:
                reply = await self._notification_command(
                    db, im_session, command.argument
                )
            elif command.command in {
                CommandType.CHAT,
                CommandType.STAND_IN,
                CommandType.MODE,
            }:
                reply = await self._mode_command(
                    im_session, command, user, message_context, port
                )
            elif command.command in {
                CommandType.TASK,
                CommandType.SWITCH,
                CommandType.CANCEL,
            }:
                reply = RETIRED_TASK_GUIDANCE
            elif command.command == CommandType.BIND:
                reply = "已绑定当前私聊会话。"
            elif (
                await im_session_service.get_mode(im_session) == IMSessionMode.STAND_IN
            ):
                reply = GUIDANCE
            else:
                return False
            await port.send_text_reply(message_context, reply)
            return True
        if await im_session_service.get_mode(im_session) == IMSessionMode.CHAT:
            return False
        await send_stand_in_message(db, user, im_session, message_context, port)
        return True

    async def _mode_command(
        self,
        session: IMPrivateSession,
        command: ParsedCommand,
        user: User,
        context: Any,
        port: Any,
    ) -> str:
        argument = (command.argument or "").strip().lower()
        if (
            command.command == CommandType.CHAT
            or command.command == CommandType.MODE
            and argument in {"chat", "聊天"}
        ):
            await im_session_service.set_mode(session, IMSessionMode.CHAT)
            await device_selection_manager.set_chat_mode(user.id)
            await port.delete_conversation_task_id(context.conversation_id, user.id)
            return "已返回 Wegent 聊天模式。发送 /standin 可进入 Wework 分身模式。"
        if (
            command.command == CommandType.STAND_IN
            or command.command == CommandType.MODE
            and argument in {"standin", "stand_in", "分身"}
        ):
            await im_session_service.set_mode(session, IMSessionMode.STAND_IN)
            return (
                "已进入 Wework 分身模式。未指定分身时，将连接账号默认执行设备的主分身。"
                + GUIDANCE
            )
        if argument:
            return "用法：/mode chat、/mode standin；也可以发送 /chat 或 /standin。"
        mode = await im_session_service.get_mode(session)
        return (
            GUIDANCE
            if mode == IMSessionMode.STAND_IN
            else "当前为 Wegent 聊天模式。发送 /standin 可进入 Wework 分身模式。"
        )

    async def _notification_command(
        self, db: Session | None, session: IMPrivateSession, argument: str | None
    ) -> str:
        normalized = (argument or "").strip().lower()
        if normalized in NOTIFY_ON_ARGS:
            await im_session_service.enable_global_notification(db, session=session)
            return "已开启全局 IM 通知，后续任务输出会通知到当前会话。"
        if normalized in NOTIFY_OFF_ARGS:
            await im_session_service.disable_global_notification(session.user_id)
            return "已关闭全局 IM 通知。"
        if normalized in NOTIFY_STATUS_ARGS:
            settings = await im_session_service.get_global_notification_settings(
                session.user_id
            )
            if not settings.enabled:
                return "全局 IM 通知：已关闭。"
            target = (
                await im_session_service.get_session(settings.session_key)
                if settings.session_key
                else None
            )
            if target is None:
                return "全局 IM 通知：已开启，但默认 IM 会话不可用。请重新发送 /notify on。"
            label = im_session_service.get_channel_label(target.channel_type)
            return f"全局 IM 通知：已开启，默认会话：{label} / {target.display_name or target.sender_id}。"
        return "用法：/notify on、/notify off、/notify status。"


im_interaction_service = IMInteractionService()
