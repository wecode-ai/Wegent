# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Owned private IM conversation endpoints."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.im_session import IMPrivateSession
from app.models.user import User
from app.schemas.im_session import (
    IMPrivateSessionListResponse,
    IMPrivateSessionOut,
)
from app.services.im.session_service import im_session_service
from app.services.im.stand_in_service import get_stand_in_binding
from shared.telemetry.decorators import trace_async

im_router = APIRouter()


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
        items=[await _private_session_out(session) for session in sessions],
    )


async def _private_session_out(session: IMPrivateSession) -> IMPrivateSessionOut:
    return IMPrivateSessionOut(
        session_key=session.session_key,
        channel_type=session.channel_type,
        channel_label=im_session_service.get_channel_label(session.channel_type),
        channel_id=session.channel_id,
        conversation_id=session.conversation_id,
        sender_id=session.sender_id,
        display_name=session.display_name,
        mode=await im_session_service.get_mode(session),
        last_seen_at=session.last_seen_at,
        stand_in=await get_stand_in_binding(session.user_id, session.session_key),
    )
