# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import secrets
import time
import uuid

import jwt  # pip install pyjwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.security import create_access_token
from app.models.user import User
from app.schemas.user import LoginResponse
from app.services.k_batch import apply_default_resources_async
from app.services.oidc import oidc_service

logger = logging.getLogger(__name__)

router = APIRouter()

STATE_JWT_SECRET = settings.OIDC_STATE_SECRET_KEY
STATE_EXPIRE_TIME = settings.OIDC_STATE_EXPIRE_SECONDS


@router.get("/login")
async def oidc_login():
    """
    OpenID Connect login endpoint

    Generate authorization URL and redirect to OIDC provider
    """
    try:
        nonce = secrets.token_urlsafe(32)
        now = int(time.time())
        payload = {"nonce": nonce, "iat": now, "exp": now + STATE_EXPIRE_TIME}
        state = jwt.encode(payload, STATE_JWT_SECRET, algorithm="HS256")
        auth_url = await oidc_service.get_authorization_url(state, nonce)

        logger.info(f"OIDC login redirect: {auth_url}")
        return RedirectResponse(url=auth_url)

    except Exception as e:
        logger.error(f"OIDC login failed: {e}")
        raise HTTPException(status_code=500, detail=f"OIDC login failed: {e}")


@router.get("/callback")
async def oidc_callback(
    background_tasks: BackgroundTasks,
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
        error_url = f"{settings.FRONTEND_URL}/login?error=oidc_error&message={error}"
        return RedirectResponse(url=error_url, status_code=302)

    # Verify state parameter (JWT)
    try:
        payload = jwt.decode(state, STATE_JWT_SECRET, algorithms=["HS256"])
        nonce = payload["nonce"]
        now = int(time.time())
        if now > payload["exp"]:
            logger.error(f"State parameter expired: {state}")
            error_url = f"{settings.FRONTEND_URL}/login?error=expired_state&message=State parameter expired"
            return RedirectResponse(url=error_url, status_code=302)
    except Exception as e:
        logger.error(f"Invalid state parameter: {state}, error: {e}")
        error_url = f"{settings.FRONTEND_URL}/login?error=invalid_state&message=Invalid state parameter"
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
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info(
                f"Created new OIDC user: user_id={user.id}, user_name={user.user_name}"
            )

            background_tasks.add_task(apply_default_resources_async, user.id)
        else:
            if user.email != email:
                user.email = email
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

        jwt_token = create_access_token(data={"sub": user.user_name})

        logger.info(
            f"OIDC login success: user_id={user.id}, user_name={user.user_name}"
        )

        redirect_url = f"{settings.FRONTEND_URL}/login/oidc?access_token={jwt_token}&token_type=bearer&login_success=true"

        return RedirectResponse(url=redirect_url, status_code=302)

    except Exception as e:
        logger.error(f"OIDC callback processing failed: {e}")
        error_url = f"{settings.FRONTEND_URL}/login?error=authentication_failed&message={str(e)}"
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
