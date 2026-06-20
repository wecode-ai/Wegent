# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private IM session task-continuation endpoints."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.im_session import IMPrivateSession
from app.models.user import User
from app.schemas.im_session import (
    BindTaskIMSessionsRequest,
    BindTaskIMSessionsResponse,
    IMPrivateSessionListResponse,
    IMPrivateSessionOut,
)
from app.services.im.notification_dispatcher import im_notification_dispatcher
from app.services.im.session_service import im_session_service
from app.services.im.task_continuation_service import (
    bind_task_to_sessions,
    get_task_title,
    load_user_private_sessions_by_keys,
    validate_personal_wework_task,
)
from shared.telemetry.decorators import trace_async

im_router = APIRouter()
tasks_router = APIRouter()


@im_router.get(
    "/private-sessions",
    response_model=IMPrivateSessionListResponse,
)
@trace_async("list_private_im_sessions", "im.api")
async def list_private_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> IMPrivateSessionListResponse:
    """List the current user's private IM sessions."""

    sessions = await im_session_service.list_user_sessions(db, user_id=current_user.id)
    return IMPrivateSessionListResponse(
        total=len(sessions),
        items=[_private_session_out(session) for session in sessions],
    )


@tasks_router.post(
    "/{task_id}/im-sessions",
    response_model=BindTaskIMSessionsResponse,
)
@trace_async("bind_task_private_sessions", "im.api")
async def bind_task_private_sessions(
    task_id: int,
    payload: BindTaskIMSessionsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> BindTaskIMSessionsResponse:
    """Bind private IM sessions to a personal WeWork task."""

    task = validate_personal_wework_task(db, current_user.id, task_id)
    bound_session_keys = await bind_task_to_sessions(
        db,
        current_user.id,
        task.id,
        payload.session_keys,
    )
    sessions = await load_user_private_sessions_by_keys(
        db,
        user_id=current_user.id,
        session_keys=bound_session_keys,
    )
    notification = await im_notification_dispatcher.send_task_switched(
        db,
        sessions,
        get_task_title(task),
    )
    return BindTaskIMSessionsResponse(
        task_id=task.id,
        bound_session_keys=bound_session_keys,
        notified_count=int(notification.get("sent") or 0),
    )


def _private_session_out(session: IMPrivateSession) -> IMPrivateSessionOut:
    return IMPrivateSessionOut(
        session_key=session.session_key,
        channel_type=session.channel_type,
        channel_label=im_session_service.get_channel_label(session.channel_type),
        channel_id=session.channel_id,
        conversation_id=session.conversation_id,
        sender_id=session.sender_id,
        display_name=session.display_name,
        mode=session.mode,
        state=session.state,
        active_task_id=session.active_task_id,
        last_seen_at=session.last_seen_at,
    )
