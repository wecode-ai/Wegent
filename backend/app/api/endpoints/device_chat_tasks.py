# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""REST endpoints for device chat tasks."""

from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, Header

from app.core import security
from app.core.auth_utils import is_api_key
from app.models.user import User
from app.schemas.device_chat_task import (
    DeviceChatTaskRequest,
    DeviceChatTaskResponse,
)
from app.services import device_chat_task_service

router = APIRouter()


@dataclass(frozen=True)
class _DeviceChatUser:
    id: int


def _get_device_chat_user(
    current_user: User = Depends(security.get_current_user_flexible_for_executor),
) -> _DeviceChatUser:
    return _DeviceChatUser(id=current_user.id)


@router.post("/tasks", response_model=DeviceChatTaskResponse)
async def create_device_chat_task(
    payload: DeviceChatTaskRequest,
    authorization: Annotated[
        str | None,
        Header(include_in_schema=False),
    ] = None,
    x_api_key: Annotated[
        str | None,
        Header(alias="X-API-Key", include_in_schema=False),
    ] = None,
    current_user: _DeviceChatUser = Depends(_get_device_chat_user),
) -> DeviceChatTaskResponse:
    """Create a new device chat task or append a message to an existing one."""

    return await device_chat_task_service.create_device_chat_task(
        user_id=current_user.id,
        request=payload,
        auth_token=_request_auth_token(authorization, x_api_key),
    )


def _request_auth_token(
    authorization: str | None,
    x_api_key: str | None,
) -> str:
    if x_api_key and is_api_key(x_api_key):
        return x_api_key
    return security.extract_authorization_token(authorization)
