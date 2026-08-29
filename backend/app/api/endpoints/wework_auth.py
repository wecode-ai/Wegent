# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import hashlib
import json
import secrets
import time
import uuid
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.cache import cache_manager
from app.core.config import settings
from app.core.security import create_access_token
from app.core.session_token import WEWORK_ACCESS_TOKEN_USE, WEWORK_REFRESH_TOKEN_USE
from app.models.user import User
from app.schemas.user import (
    WeworkAuthSessionActionResponse,
    WeworkAuthSessionCreateRequest,
    WeworkAuthSessionCreateResponse,
    WeworkAuthSessionPollResponse,
    WeworkTokenRefreshRequest,
    WeworkTokenRefreshResponse,
    WeworkWebConfigResponse,
)

router = APIRouter()

SESSION_TTL_SECONDS = 5 * 60
POLL_INTERVAL_SECONDS = 2
SESSION_KEY_PREFIX = "wework_auth_session:"
DEVICE_PROOF_MAX_AGE_SECONDS = 5 * 60
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


def _uses_device_bound_refresh(session_data: dict) -> bool:
    auth_mode = session_data.get("auth_mode")
    if auth_mode == DEVICE_BOUND_REFRESH_AUTH_MODE:
        return True
    if auth_mode == LEGACY_ACCESS_AUTH_MODE:
        return False

    device_thumbprint = session_data.get("device_thumbprint")
    return isinstance(device_thumbprint, str) and bool(device_thumbprint)


def _base64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid device public key",
        ) from exc


def _validated_device_public_key(value: dict[str, str]) -> dict[str, str]:
    public_key = {
        "kty": value.get("kty", ""),
        "crv": value.get("crv", ""),
        "x": value.get("x", ""),
        "y": value.get("y", ""),
    }
    if public_key["kty"] != "EC" or public_key["crv"] != "P-256":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device public key must use EC P-256",
        )
    if (
        len(_base64url_decode(public_key["x"])) != 32
        or len(_base64url_decode(public_key["y"])) != 32
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid device public key",
        )
    return public_key


def _device_key_thumbprint(public_key: dict[str, str]) -> str:
    canonical = json.dumps(
        {
            "crv": public_key["crv"],
            "kty": public_key["kty"],
            "x": public_key["x"],
            "y": public_key["y"],
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return (
        base64.urlsafe_b64encode(hashlib.sha256(canonical).digest())
        .rstrip(b"=")
        .decode()
    )


def _token_hash(token: str) -> str:
    return (
        base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest())
        .rstrip(b"=")
        .decode()
    )


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


def _decode_refresh_token(refresh_token: str) -> dict:
    try:
        payload = jwt.decode(
            refresh_token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Desktop login has expired",
        ) from exc
    if payload.get("token_use") != WEWORK_REFRESH_TOKEN_USE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid desktop refresh token",
        )
    return payload


def _verify_device_proof(
    proof: str,
    refresh_token: str,
    expected_thumbprint: str,
    expected_path: str,
) -> None:
    try:
        header = jwt.get_unverified_header(proof)
        public_key = _validated_device_public_key(header.get("jwk") or {})
        if header.get("alg") != "ES256":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid desktop device proof",
            )
        if _device_key_thumbprint(public_key) != expected_thumbprint:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Desktop device proof does not match this login",
            )
        payload = jwt.decode(proof, public_key, algorithms=["ES256"])
    except HTTPException:
        raise
    except (JWTError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid desktop device proof",
        ) from exc

    issued_at = payload.get("iat")
    now = int(time.time())
    if (
        not isinstance(issued_at, int)
        or issued_at > now + 30
        or now - issued_at > DEVICE_PROOF_MAX_AGE_SECONDS
        or payload.get("htm") != "POST"
        or payload.get("htu") != expected_path
        or payload.get("ath") != _token_hash(refresh_token)
        or not isinstance(payload.get("jti"), str)
        or not payload["jti"]
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid desktop device proof",
        )


@router.get("/config", response_model=WeworkWebConfigResponse)
async def get_wework_web_config() -> WeworkWebConfigResponse:
    """Return public Web and Socket.IO URLs associated with this Backend."""
    socket_url = settings.WEGENT_SOCKET_URL.strip().rstrip("/")
    return WeworkWebConfigResponse(
        web_url=settings.FRONTEND_URL.rstrip("/"),
        socket_url=socket_url or None,
    )


@router.post("/sessions", response_model=WeworkAuthSessionCreateResponse)
async def create_wework_auth_session(
    request: WeworkAuthSessionCreateRequest | None = None,
) -> WeworkAuthSessionCreateResponse:
    """Create a short-lived cloud authorization session for Wework desktop."""
    session_id = str(uuid.uuid4())
    poll_token = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + SESSION_TTL_SECONDS
    session_data = {
        "status": "pending",
        "auth_mode": LEGACY_ACCESS_AUTH_MODE,
        "poll_token": poll_token,
        "created_at": int(time.time()),
        "expires_at": expires_at,
    }
    if request is not None and request.device_public_key is not None:
        device_public_key = _validated_device_public_key(request.device_public_key)
        session_data.update(
            {
                "auth_mode": DEVICE_BOUND_REFRESH_AUTH_MODE,
                "device_public_key": device_public_key,
                "device_thumbprint": _device_key_thumbprint(device_public_key),
            }
        )

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
        web_url=settings.FRONTEND_URL.rstrip("/"),
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
    refresh_token = session_data.get("refresh_token")
    username = session_data.get("username")
    if not isinstance(access_token, str) or (
        _uses_device_bound_refresh(session_data) and not isinstance(refresh_token, str)
    ):
        return WeworkAuthSessionPollResponse(
            status="failed",
            error="Authorization token is missing",
        )

    session_data["status"] = "claimed"
    session_data.pop("access_token", None)
    session_data.pop("refresh_token", None)
    await _write_session(session_id, session_data)

    return WeworkAuthSessionPollResponse(
        status="success",
        access_token=access_token,
        refresh_token=refresh_token,
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


@router.post("/refresh", response_model=WeworkTokenRefreshResponse)
async def refresh_wework_access_token(
    body: WeworkTokenRefreshRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> WeworkTokenRefreshResponse:
    """Issue a desktop access token after proving possession of its device key."""
    payload = _decode_refresh_token(body.refresh_token)
    confirmation = payload.get("cnf")
    expected_thumbprint = (
        confirmation.get("jkt") if isinstance(confirmation, dict) else None
    )
    if not isinstance(expected_thumbprint, str) or not expected_thumbprint:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid desktop refresh token",
        )
    _verify_device_proof(
        body.proof,
        body.refresh_token,
        expected_thumbprint,
        request.url.path,
    )

    username = payload.get("sub")
    user_id = payload.get("user_id")
    if not isinstance(username, str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid desktop refresh token",
        )
    user = db.query(User).filter(User.user_name == username).first()
    if (
        user is None
        or not user.is_active
        or (isinstance(user_id, int) and user.id != user_id)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Desktop login is no longer valid",
        )
    return WeworkTokenRefreshResponse(
        access_token=_create_wework_access_token(user),
        expires_in=settings.WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


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
