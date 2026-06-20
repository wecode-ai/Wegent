# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral private IM interaction orchestration."""

from typing import Protocol

from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession, IMSessionMode
from app.models.user import User
from app.services.channels.handler import MessageContext
from app.services.im import task_continuation_service as im_task_continuation_service
from app.services.im.command_router import IMCommandAction, im_command_router


class PrivateIMInteractionPort(Protocol):
    """Provider operations required by the private IM interaction layer."""

    async def send_text_reply(
        self,
        message_context: MessageContext,
        text: str,
    ) -> bool: ...

    async def delete_conversation_task_id(
        self,
        conversation_id: str,
        user_id: int,
    ) -> None: ...

    async def execute_private_im_bind_task(
        self,
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        task_id: int | None,
        message_context: MessageContext,
    ) -> None: ...

    async def execute_private_im_continue_task(
        self,
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        task_id: int | None,
        message: str,
        message_context: MessageContext,
    ) -> None: ...

    async def execute_private_im_create_task(
        self,
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        project_id: int | None,
        message: str,
        message_context: MessageContext,
    ) -> None: ...


class IMInteractionService:
    """Route private IM messages through shared session and task logic."""

    async def route_private_message(
        self,
        *,
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        message_context: MessageContext,
        port: PrivateIMInteractionPort,
    ) -> bool:
        if self._should_continue_task_media_message(im_session, message_context):
            await port.execute_private_im_continue_task(
                db=db,
                user=user,
                im_session=im_session,
                task_id=im_session.active_task_id,
                message="",
                message_context=message_context,
            )
            return True

        recent_tasks = im_task_continuation_service.list_recent_wework_tasks(
            db, user.id, limit=5
        )
        projects = im_task_continuation_service.list_wework_projects(
            db, user.id, limit=8
        )
        result = await im_command_router.route(
            db=db,
            session=im_session,
            content=message_context.content,
            recent_tasks=recent_tasks,
            projects=projects,
        )

        if not result.handled:
            return False

        if result.action == IMCommandAction.NONE:
            if result.reply:
                await port.send_text_reply(message_context, result.reply)
            return True

        if result.action == IMCommandAction.START_CHAT:
            await port.delete_conversation_task_id(
                message_context.conversation_id,
                user.id,
            )
            if result.reply:
                await port.send_text_reply(message_context, result.reply)
            return True

        if result.action == IMCommandAction.BIND_TASK:
            await port.execute_private_im_bind_task(
                db=db,
                user=user,
                im_session=im_session,
                task_id=result.task_id,
                message_context=message_context,
            )
            return True

        if result.action == IMCommandAction.CONTINUE_TASK:
            await port.execute_private_im_continue_task(
                db=db,
                user=user,
                im_session=im_session,
                task_id=result.task_id,
                message=result.message or message_context.content,
                message_context=message_context,
            )
            return True

        if result.action == IMCommandAction.CREATE_TASK:
            await port.execute_private_im_create_task(
                db=db,
                user=user,
                im_session=im_session,
                project_id=result.project_id,
                message=result.message or "",
                message_context=message_context,
            )
            return True

        return False

    def _should_continue_task_media_message(
        self,
        im_session: IMPrivateSession,
        message_context: MessageContext,
    ) -> bool:
        return (
            im_session.mode == IMSessionMode.TASK
            and im_session.active_task_id is not None
            and not (message_context.content or "").strip()
            and bool(message_context.images or message_context.files)
        )


im_interaction_service = IMInteractionService()
