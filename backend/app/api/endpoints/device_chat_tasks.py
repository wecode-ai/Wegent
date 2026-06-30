# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""REST endpoints for device chat tasks."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.device_chat_task import (
    DeviceChatTaskRequest,
    DeviceChatTaskResponse,
)
from app.services import device_chat_task_service

router = APIRouter()


@router.post("/tasks", response_model=DeviceChatTaskResponse)
async def create_device_chat_task(
    payload: DeviceChatTaskRequest,
    authorization: Annotated[str | None, Header()] = None,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> DeviceChatTaskResponse:
    """Create a new device chat task or append a message to an existing one."""

    return await device_chat_task_service.create_device_chat_task(
        db=db,
        user=current_user,
        request=payload,
        auth_token=_bearer_token(authorization),
    )


def _bearer_token(authorization: str | None) -> str:
    if not authorization:
        return ""
    prefix = "Bearer "
    if authorization.startswith(prefix):
        return authorization[len(prefix) :].strip()
    return ""
