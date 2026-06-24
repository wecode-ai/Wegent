# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private IM session task-continuation endpoints."""

from fastapi import APIRouter, Depends, Query
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
    bot_purpose: str | None = Query(
        default=None,
        description="Filter private sessions by IM bot purpose",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> IMPrivateSessionListResponse:
    """List the current user's private IM sessions."""

    sessions = await im_session_service.list_user_sessions(db, user_id=current_user.id)
    items: list[IMPrivateSessionOut] = []
    for session in sessions:
        session_bot_purpose = await im_session_service.get_session_bot_purpose(
            db,
            session,
        )
        if bot_purpose and session_bot_purpose != bot_purpose:
            continue
        items.append(
            _private_session_out(session, bot_purpose=session_bot_purpose),
        )
    return IMPrivateSessionListResponse(
        total=len(items),
        items=items,
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


def _private_session_out(
    session: IMPrivateSession,
    *,
    bot_purpose: str,
) -> IMPrivateSessionOut:
    runtime_task = session.active_runtime_task or {}
    current_target_label = None
    if runtime_task:
        current_target_label = str(
            runtime_task.get("title") or runtime_task.get("localTaskId") or ""
        )
    return IMPrivateSessionOut(
        session_key=session.session_key,
        channel_type=session.channel_type,
        channel_label=im_session_service.get_channel_label(session.channel_type),
        channel_id=session.channel_id,
        bot_purpose=bot_purpose,
        conversation_id=session.conversation_id,
        sender_id=session.sender_id,
        display_name=session.display_name,
        mode=session.mode,
        state=session.state,
        active_task_id=session.active_task_id,
        current_target_type="wework_runtime_task" if runtime_task else None,
        current_target_label=current_target_label,
        last_seen_at=session.last_seen_at,
    )
