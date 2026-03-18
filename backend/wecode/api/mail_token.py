# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for company mail token management.

Provides endpoints to exchange, query status, and delete mail tokens.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core import security
from app.core.database import get_db
from app.models.user import User
from wecode.service.mail_token_service import mail_token_service

logger = logging.getLogger(__name__)

router = APIRouter()


class MailTokenRequest(BaseModel):
    """Request body for mail token exchange."""

    client_token: str


class MailTokenStatusResponse(BaseModel):
    """Response for mail token status query."""

    configured: bool


@router.post("/mail/token")
async def save_mail_token(
    request: MailTokenRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Exchange a client_token for a mail_token and save it."""
    try:
        await mail_token_service.exchange_and_save(
            db, current_user, request.client_token
        )
        return {"message": "ok"}
    except ValueError as e:
        logger.error(f"Mail token exchange failed for {current_user.user_name}: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Mail token exchange error for {current_user.user_name}: {e}")
        raise HTTPException(
            status_code=502,
            detail="Failed to exchange mail token from KMS",
        )


@router.get("/mail/token", response_model=MailTokenStatusResponse)
async def get_mail_token_status(
    current_user: User = Depends(security.get_current_user),
):
    """Check whether a mail token is configured."""
    configured = mail_token_service.get_status(current_user)
    return MailTokenStatusResponse(configured=configured)


@router.delete("/mail/token")
async def delete_mail_token(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Delete the configured mail token."""
    try:
        await mail_token_service.delete(db, current_user)
        return {"message": "ok"}
    except Exception as e:
        logger.error(f"Mail token delete error for {current_user.user_name}: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete mail token")
