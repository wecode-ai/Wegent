# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk authentication API endpoints."""
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from dingtalk.config import dingtalk_config
from dingtalk.middleware.security import (
    check_ip_whitelist,
    check_rate_limit,
    check_referer,
)
from dingtalk.services.dingtalk_service import dingtalk_service

logger = logging.getLogger(__name__)

router = APIRouter()


class DingTalkLoginRequest(BaseModel):
    """DingTalk login request body."""

    auth_code: str
    timestamp: str = ""
    signature: str = ""


class DingTalkLoginResponse(BaseModel):
    """DingTalk login response."""

    access_token: str
    token_type: str = "bearer"
    user: dict


class DingTalkConfigResponse(BaseModel):
    """Public DingTalk config for frontend."""

    corp_id: str
    client_id: str
    fallback_url: str


@router.get("/config")
async def get_config() -> DingTalkConfigResponse:
    """
    Get public DingTalk config for frontend.
    NEVER expose client_secret!
    """
    return DingTalkConfigResponse(
        corp_id=dingtalk_config.corp_id,
        client_id=dingtalk_config.client_id,
        fallback_url=dingtalk_config.fallback_url,
    )


@router.post("/login")
async def dingtalk_login(
    request: Request,
    body: DingTalkLoginRequest,
    db: Session = Depends(get_db),
) -> DingTalkLoginResponse:
    """
    DingTalk login endpoint.

    Security checks:
    1. Rate limiting
    2. Referer/Origin validation
    3. IP whitelist (optional)
    4. Signature verification (optional)
    """
    # Security checks
    await check_rate_limit(request)
    check_referer(request)
    check_ip_whitelist(request)

    # Optional signature verification
    if body.timestamp and body.signature:
        if not dingtalk_service.verify_signature(body.timestamp, body.signature):
            logger.warning("[DingTalk] Invalid signature from client")
            raise HTTPException(status_code=401, detail="Invalid signature")

    # Get user info from DingTalk

    try:
        access_token = await dingtalk_service.get_access_token()
        user_info = await dingtalk_service.get_user_info(body.auth_code, access_token)
    except Exception as e:
        logger.error(f"[DingTalk] Auth failed: {str(e)}")
        raise HTTPException(status_code=401, detail=f"DingTalk auth failed: {str(e)}")

    if not user_info.union_id:
        logger.error("[DingTalk] Failed to get user union_id")
        raise HTTPException(status_code=401, detail="Failed to get DingTalk user info")

    logger.info(f"[DingTalk] Auth success: {user_info}")
    # Find or create user (use unionId as username, same pattern as OIDC)
    user = db.scalar(select(User).where(User.user_name == user_info.union_id))

    if not user:
        logger.warning(f"[DingTalk] User not found: {user_info.union_id}")
        raise HTTPException(status_code=401, detail="User not registered")
    else:
        # Update auth_source if needed
        if user.auth_source == "unknown":
            logger.info(
                f"[DingTalk] Updating auth_source for user: {user_info.union_id}"
            )
            user.auth_source = "dingtalk"
            db.commit()

    # Generate JWT token (same as existing auth)
    access_token = security.create_access_token(data={"sub": user.user_name})

    logger.info(f"[DingTalk] User logged in successfully: {user.user_name}")

    return DingTalkLoginResponse(
        access_token=access_token,
        user={
            "id": user.id,
            "user_name": user.user_name,
            "email": user.email,
            "role": user.role,
            "auth_source": user.auth_source,
        },
    )
