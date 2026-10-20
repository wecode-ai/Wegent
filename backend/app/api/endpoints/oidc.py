# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import time
import uuid

import jwt  # pip install pyjwt
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.security import create_access_token
from app.models.user import User
from app.schemas.user import (
    UserAuthTypeResponse,
)
from app.services.k_batch import (
    apply_default_resources_sync,
)
from app.services.oidc import oidc_service

logger = logging.getLogger(__name__)

router = APIRouter()

STATE_JWT_SECRET = settings.OIDC_STATE_SECRET_KEY
STATE_EXPIRE_TIME = settings.OIDC_STATE_EXPIRE_SECONDS

# CLI login session TTL (5 minutes)
CLI_SESSION_EXPIRE_SECONDS = 300
CLI_SESSION_KEY_PREFIX = "cli_login_session:"


def _normalize_frontend_base_path(value: str | None) -> str:
    if not value or value == "/":
        return ""

    trimmed = value.strip()
    if not trimmed.startswith("/") or trimmed.startswith("//"):
        return ""
    if "\\" in trimmed or "?" in trimmed or "#" in trimmed:
        return ""

    parts: list[str] = []
    for part in trimmed.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            parts.pop() if parts else None
            continue
        parts.append(part)

    return f"/{'/'.join(parts)}" if parts else ""


def _build_frontend_url(path: str, frontend_base_path: str | None = None) -> str:
    base_url = settings.FRONTEND_URL.rstrip("/")
    app_base_path = _normalize_frontend_base_path(frontend_base_path)
    normalized_path = path if path.startswith("/") else f"/{path}"
    return f"{base_url}{app_base_path}{normalized_path}"


@router.get("/callback")
async def oidc_callback(
    code: str = Query(..., description="Authorization code"),
    state: str = Query(..., description="State parameter"),
    error: str = Query(None, description="Error information"),
    db: Session = Depends(get_db),
):
    """
    OpenID Connect callback handler

    Handle OIDC provider callback, verify authorization code and create user session, then redirect to frontend
    """
    if error:
        logger.error(f"OIDC callback error: {error}")
        error_url = _build_frontend_url(
            f"/login?error=oidc_error&message={error}",
        )
        return RedirectResponse(url=error_url, status_code=302)

    # Verify state parameter (JWT)
    redirect_after_login = None
    frontend_base_path = None
    try:
        payload = jwt.decode(state, STATE_JWT_SECRET, algorithms=["HS256"])
        nonce = payload["nonce"]
        redirect_after_login = payload.get("redirect")
        frontend_base_path = payload.get("frontend_base_path")
        now = int(time.time())
        if now > payload["exp"]:
            logger.error(f"State parameter expired: {state}")
            error_url = _build_frontend_url(
                "/login?error=expired_state&message=State parameter expired",
                frontend_base_path,
            )
            return RedirectResponse(url=error_url, status_code=302)
    except Exception as e:
        logger.error(f"Invalid state parameter: {state}, error: {e}")
        error_url = _build_frontend_url(
            "/login?error=invalid_state&message=Invalid state parameter",
        )
        return RedirectResponse(url=error_url, status_code=302)

    try:
        tokens = await oidc_service.exchange_code_for_tokens(code, state)

        id_token = tokens.get("id_token")
        if not id_token:
            raise Exception("Missing ID Token in response")

        claims = await oidc_service.verify_id_token(id_token, nonce)

        # Get user information (optional)
        access_token = tokens.get("access_token")
        user_info = {}
        if access_token:
            user_info = await oidc_service.get_user_info(access_token)

        user_data = {**claims, **user_info}

        user_id = user_data.get("sub")
        email = (
            user_data.get("email")
            or user_data.get("preferred_username")
            or f"{user_id}@unknown.email"
        )
        name = user_data.get("name") or user_data.get("preferred_username") or user_id

        if not user_id:
            raise Exception("Missing user identifier in ID Token")

        logger.info(f"OIDC user info: user_id={user_id}, email={email}, name={name}")

        # Find or create user
        user_name = email.split("@")[0] if "@" in email else user_id

        user = db.scalar(select(User).where(User.user_name == user_name))

        if not user:
            from app.core import security

            user = User(
                user_name=user_name,
                email=email,
                is_active=True,
                password_hash=security.get_password_hash(str(uuid.uuid4())),
                git_info=[],
                auth_source="oidc",
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info(
                f"Created new OIDC user: user_id={user.id}, user_name={user.user_name}"
            )

            # Apply default resources synchronously for new OIDC users
            apply_default_resources_sync(user.id)
        else:
            if user.email != email:
                user.email = email
            # Update auth_source if it was unknown
            if user.auth_source == "unknown":
                user.auth_source = "oidc"
            db.commit()
            db.refresh(user)
            logger.info(
                f"Found existing OIDC user: user_id={user.id}, user_name={user.user_name}"
            )

        if not user.is_active:
            logger.warning(
                f"User not active: user_id={user.id}, user_name={user.user_name}"
            )
            raise Exception("User not active")

        jwt_token = create_access_token(
            data={"sub": user.user_name, "user_id": user.id}
        )

        logger.info(
            f"OIDC login success: user_id={user.id}, user_name={user.user_name}"
        )

        # Build redirect URL with optional redirect parameter
        from urllib.parse import quote

        redirect_url = _build_frontend_url(
            f"/login/oidc?access_token={jwt_token}&token_type=bearer&login_success=true",
            frontend_base_path,
        )
        if redirect_after_login:
            redirect_url += f"&redirect={quote(redirect_after_login)}"

        return RedirectResponse(url=redirect_url, status_code=302)

    except Exception as e:
        logger.error(f"OIDC callback processing failed: {e}")
        error_url = _build_frontend_url(
            f"/login?error=authentication_failed&message={str(e)}",
            frontend_base_path,
        )
        return RedirectResponse(url=error_url, status_code=302)


@router.get("/metadata")
async def get_oidc_metadata():
    """
    Get OIDC provider metadata

    Used for debugging and configuration validation
    """
    try:
        metadata = await oidc_service.get_metadata()
        return metadata
    except Exception as e:
        logger.error(f"Failed to get OIDC metadata: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get OIDC metadata: {e}")


# CLI OIDC Login Endpoints


@router.get("/user-auth-type", response_model=UserAuthTypeResponse)
async def get_user_auth_type(
    username: str = Query(..., description="Username to query"),
    db: Session = Depends(get_db),
):
    """
    Query user's authentication type by username.

    Returns the auth_source for the user if found, otherwise returns exists=False.
    """
    user = db.scalar(select(User).where(User.user_name == username))

    if not user:
        return UserAuthTypeResponse(exists=False, auth_source=None)

    return UserAuthTypeResponse(exists=True, auth_source=user.auth_source)
