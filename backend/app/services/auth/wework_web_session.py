# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""One-use native-to-Web grants bound to a private WebView challenge."""

import hashlib
import secrets
import time
from typing import Any

from fastapi import HTTPException
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.core.security import create_access_token
from app.core.session_token import is_user_session_payload
from app.models.user import User
from app.schemas.wework_web_session import (
    WeworkWebSessionCreateResponse,
    WeworkWebSessionExchangeRequest,
    WeworkWebSessionExchangeResponse,
    WeworkWebSessionRequest,
)
from shared.telemetry.decorators import trace_async

GRANT_TTL_SECONDS = 60


def _grant_key(code: str) -> str:
    return "wework_web_session:" + hashlib.sha256(code.encode()).hexdigest()


@trace_async("auth.wework_web_session.create", tracer_name=__name__)
async def create_web_session(
    user: User, request: WeworkWebSessionRequest
) -> WeworkWebSessionCreateResponse:
    code = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + GRANT_TTL_SECONDS
    grant = {
        "nonce": request.nonce,
        "redirect": request.redirect,
        "user_id": user.id,
        "username": user.user_name,
        "expires_at": expires_at,
    }
    try:
        written = await cache_manager.set_or_raise(
            _grant_key(code), grant, expire=GRANT_TTL_SECONDS
        )
    except Exception as exc:
        raise HTTPException(
            503, "Web authorization is temporarily unavailable"
        ) from exc
    if not written:
        raise HTTPException(503, "Web authorization is temporarily unavailable")
    return WeworkWebSessionCreateResponse(
        code=code, user_id=user.id, expires_at=expires_at
    )


def _validate_grant(
    grant: Any, request: WeworkWebSessionExchangeRequest
) -> dict[str, Any]:
    if not isinstance(grant, dict) or grant.get("expires_at", 0) <= time.time():
        raise HTTPException(410, "Web authorization expired or already used")
    if not secrets.compare_digest(grant.get("nonce", ""), request.nonce) or (
        grant.get("redirect") != request.redirect
    ):
        raise HTTPException(403, "Web authorization challenge does not match")
    return grant


def _bound_user(db: Session, grant: dict[str, Any], existing_tokens: list[str]) -> User:
    user = (
        db.query(User)
        .filter(User.id == grant["user_id"], User.user_name == grant["username"])
        .first()
    )
    if user is None or not user.is_active:
        raise HTTPException(401, "Could not validate credentials")
    for token in set(existing_tokens):
        username, user_id = _existing_identity(token)
        if username != user.user_name or (user_id is not None and user_id != user.id):
            raise HTTPException(409, "Web session belongs to another account")
    return user


def _existing_identity(token: str) -> tuple[str, int | None]:
    """Compare signed identity even after expiry; the live grant authorizes login."""
    try:
        claims = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            options={"verify_exp": False},
        )
        username, user_id = claims.get("sub"), claims.get("user_id")
        if (
            not is_user_session_payload(claims)
            or not isinstance(username, str)
            or not username
            or (user_id is not None and type(user_id) is not int)
        ):
            raise JWTError("Invalid user session identity")
        return username, user_id
    except JWTError as exc:
        raise HTTPException(401, "Could not validate existing Web identity") from exc


@trace_async("auth.wework_web_session.exchange", tracer_name=__name__)
async def exchange_web_session(
    db: Session,
    request: WeworkWebSessionExchangeRequest,
    existing_tokens: list[str],
) -> WeworkWebSessionExchangeResponse:
    key = _grant_key(request.code)
    try:
        stored = await cache_manager.get_or_raise(key)
    except Exception as exc:
        raise HTTPException(
            503, "Web authorization is temporarily unavailable"
        ) from exc
    grant = _validate_grant(stored, request)
    user = _bound_user(db, grant, existing_tokens)
    try:
        claimed = await cache_manager.pop_or_raise(key)
    except Exception as exc:
        raise HTTPException(
            503, "Web authorization is temporarily unavailable"
        ) from exc
    if claimed != grant:
        raise HTTPException(410, "Web authorization expired or already used")
    _validate_grant(claimed, request)
    token = create_access_token({"sub": user.user_name, "user_id": user.id})
    return WeworkWebSessionExchangeResponse(
        access_token=token,
        user_id=user.id,
        username=user.user_name,
        expires_at=jwt.get_unverified_claims(token)["exp"],
    )
