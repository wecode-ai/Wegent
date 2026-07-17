# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import secrets
import time
import uuid
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core import security
from app.core.cache import cache_manager
from app.core.config import settings
from app.core.security import create_access_token
from app.models.user import User
from app.schemas.user import (
    WeworkAuthSessionActionResponse,
    WeworkAuthSessionCreateResponse,
    WeworkAuthSessionPollResponse,
)

router = APIRouter()

SESSION_TTL_SECONDS = 5 * 60
POLL_INTERVAL_SECONDS = 2
SESSION_KEY_PREFIX = "wework_auth_session:"


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


def _authorize_base_url() -> str:
    raw_value = (settings.WEWORK_AUTHORIZE_BASE_URL or settings.FRONTEND_URL).strip()
    if not raw_value:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Wework authorization Web URL is not configured",
        )

    try:
        from urllib.parse import urlparse

        parsed = urlparse(raw_value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Wework authorization Web URL is invalid",
        ) from exc

    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Wework authorization Web URL is invalid",
        )

    return raw_value.rstrip("/")


def _build_authorize_url(session_id: str) -> str:
    params = urlencode({"session_id": session_id})
    return f"{_authorize_base_url()}/auth/wework/authorize?{params}"


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


def _require_poll_token(session_data: dict, poll_token: str | None) -> None:
    if not poll_token or session_data.get("poll_token") != poll_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization polling token",
        )


@router.post("/sessions", response_model=WeworkAuthSessionCreateResponse)
async def create_wework_auth_session() -> WeworkAuthSessionCreateResponse:
    """Create a short-lived cloud authorization session for Wework desktop."""
    session_id = str(uuid.uuid4())
    poll_token = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + SESSION_TTL_SECONDS
    session_data = {
        "status": "pending",
        "poll_token": poll_token,
        "created_at": int(time.time()),
        "expires_at": expires_at,
    }

    success = await cache_manager.set(
        _session_key(session_id),
        session_data,
        expire=SESSION_TTL_SECONDS,
    )
    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create authorization session",
        )

    return WeworkAuthSessionCreateResponse(
        session_id=session_id,
        poll_token=poll_token,
        authorize_url=_build_authorize_url(session_id),
        expires_at=expires_at,
        poll_interval_seconds=POLL_INTERVAL_SECONDS,
    )


@router.get("/sessions/{session_id}/poll", response_model=WeworkAuthSessionPollResponse)
async def poll_wework_auth_session(
    session_id: str,
    poll_token: str = Query(...),
) -> WeworkAuthSessionPollResponse:
    """Poll a Wework authorization session from the desktop app."""
    session_data = await _read_session(session_id)
    _require_poll_token(session_data, poll_token)

    current_status = str(session_data.get("status", "pending"))
    if current_status == "pending":
        return WeworkAuthSessionPollResponse(status="pending")
    if current_status == "declined":
        return WeworkAuthSessionPollResponse(status="declined")
    if current_status == "claimed":
        return WeworkAuthSessionPollResponse(
            status="failed",
            error="Authorization token has already been claimed",
        )
    if current_status != "approved":
        return WeworkAuthSessionPollResponse(
            status="failed",
            error=str(session_data.get("error") or "Authorization failed"),
        )

    access_token = session_data.get("access_token")
    username = session_data.get("username")
    if not isinstance(access_token, str):
        return WeworkAuthSessionPollResponse(
            status="failed",
            error="Authorization token is missing",
        )

    session_data["status"] = "claimed"
    session_data.pop("access_token", None)
    await _write_session(session_id, session_data)

    return WeworkAuthSessionPollResponse(
        status="success",
        access_token=access_token,
        token_type="bearer",
        username=username if isinstance(username, str) else None,
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

    access_token = create_access_token(
        data={"sub": current_user.user_name, "user_id": current_user.id}
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
