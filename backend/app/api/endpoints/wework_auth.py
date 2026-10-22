# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from app.core import security
from app.core.cache import cache_manager
from app.core.config import settings
from app.core.security import create_access_token
from app.core.session_token import WEWORK_ACCESS_TOKEN_USE, WEWORK_REFRESH_TOKEN_USE
from app.models.user import User
from app.schemas.user import (
    WeworkAuthSessionActionResponse,
)

router = APIRouter()

SESSION_TTL_SECONDS = 5 * 60
POLL_INTERVAL_SECONDS = 2
SESSION_KEY_PREFIX = "wework_auth_session:"
LEGACY_ACCESS_AUTH_MODE = "legacy_access"
DEVICE_BOUND_REFRESH_AUTH_MODE = "device_bound_refresh"


def _session_key(session_id: str) -> str:
    return f"{SESSION_KEY_PREFIX}{session_id}"


def _validate_session_id(session_id: str) -> None:
    try:
        uuid.UUID(session_id, version=4)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid session_id format",
        ) from exc


async def _read_session(session_id: str) -> dict:
    _validate_session_id(session_id)
    session_data = await cache_manager.get(_session_key(session_id))
    if not session_data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Authorization session expired or not found",
        )
    if not isinstance(session_data, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Authorization session is invalid",
        )
    return session_data


async def _write_session(session_id: str, session_data: dict) -> None:
    await cache_manager.set(
        _session_key(session_id),
        session_data,
        expire=SESSION_TTL_SECONDS,
    )


def _uses_device_bound_refresh(session_data: dict) -> bool:
    auth_mode = session_data.get("auth_mode")
    if auth_mode == DEVICE_BOUND_REFRESH_AUTH_MODE:
        return True
    if auth_mode == LEGACY_ACCESS_AUTH_MODE:
        return False

    device_thumbprint = session_data.get("device_thumbprint")
    return isinstance(device_thumbprint, str) and bool(device_thumbprint)


def _create_wework_access_token(user: User) -> str:
    return create_access_token(
        data={
            "sub": user.user_name,
            "user_id": user.id,
            "token_use": WEWORK_ACCESS_TOKEN_USE,
        },
        expires_delta=settings.WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES,
    )


def _create_legacy_wework_access_token(user: User) -> str:
    return create_access_token(
        data={
            "sub": user.user_name,
            "user_id": user.id,
        }
    )


def _create_wework_refresh_token(user: User, device_thumbprint: str) -> str:
    return create_access_token(
        data={
            "sub": user.user_name,
            "user_id": user.id,
            "token_use": WEWORK_REFRESH_TOKEN_USE,
            "cnf": {"jkt": device_thumbprint},
            "jti": str(uuid.uuid4()),
        },
        expires_delta=settings.WEWORK_REFRESH_TOKEN_EXPIRE_MINUTES,
    )


@router.post(
    "/sessions/{session_id}/approve",
    response_model=WeworkAuthSessionActionResponse,
)
async def approve_wework_auth_session(
    session_id: str,
    current_user: User = Depends(security.get_current_user),
) -> WeworkAuthSessionActionResponse:
    """Approve a Wework desktop authorization session from the cloud Web app."""
    session_data = await _read_session(session_id)
    current_status = str(session_data.get("status", "pending"))
    if current_status != "pending":
        return WeworkAuthSessionActionResponse(status=current_status)

    device_thumbprint = session_data.get("device_thumbprint")
    uses_device_bound_refresh = _uses_device_bound_refresh(session_data)
    if uses_device_bound_refresh and (
        not isinstance(device_thumbprint, str) or not device_thumbprint
    ):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Authorization session is missing its device binding",
        )
    access_token = (
        _create_wework_access_token(current_user)
        if uses_device_bound_refresh
        else _create_legacy_wework_access_token(current_user)
    )
    session_data.update(
        {
            "status": "approved",
            "access_token": access_token,
            "username": current_user.user_name,
            "approved_user_id": current_user.id,
            "approved_at": int(time.time()),
        }
    )
    if uses_device_bound_refresh:
        session_data["refresh_token"] = _create_wework_refresh_token(
            current_user,
            device_thumbprint,
        )
    await _write_session(session_id, session_data)
    return WeworkAuthSessionActionResponse(status="approved")


@router.post(
    "/sessions/{session_id}/decline",
    response_model=WeworkAuthSessionActionResponse,
)
async def decline_wework_auth_session(
    session_id: str,
) -> WeworkAuthSessionActionResponse:
    """Decline a Wework desktop authorization session from the cloud Web app."""
    session_data = await _read_session(session_id)
    current_status = str(session_data.get("status", "pending"))
    if current_status != "pending":
        return WeworkAuthSessionActionResponse(status=current_status)

    session_data["status"] = "declined"
    session_data["declined_at"] = int(time.time())
    await _write_session(session_id, session_data)
    return WeworkAuthSessionActionResponse(status="declined")
