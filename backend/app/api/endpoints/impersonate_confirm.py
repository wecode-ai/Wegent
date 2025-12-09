# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Public API routes for impersonation confirmation (user-facing).
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.impersonation import ImpersonationConfirmInfo
from app.services.impersonation_service import impersonation_service

router = APIRouter()


@router.get("/confirm/{token}", response_model=ImpersonationConfirmInfo)
async def get_impersonation_confirm_info(
    token: str = Path(..., description="Impersonation request token"),
    db: Session = Depends(get_db),
):
    """
    Get impersonation request information for the confirmation page.

    This endpoint is publicly accessible so users can view the request
    before logging in to approve/reject it.
    """
    request = impersonation_service.get_request_by_token(db, token)

    # Calculate remaining time
    now = datetime.now(timezone.utc)
    if request.expires_at.tzinfo is None:
        expires_at = request.expires_at.replace(tzinfo=timezone.utc)
    else:
        expires_at = request.expires_at

    remaining_seconds = max(0, int((expires_at - now).total_seconds()))

    # Check if expired
    if remaining_seconds == 0 and request.status == "pending":
        request.status = "expired"
        db.commit()

    return ImpersonationConfirmInfo(
        id=request.id,
        admin_user_name=request.admin_user.user_name,
        target_user_name=request.target_user.user_name,
        status=request.status,
        expires_at=request.expires_at,
        remaining_seconds=remaining_seconds,
        created_at=request.created_at,
    )


@router.post("/confirm/{token}/approve", response_model=ImpersonationConfirmInfo)
async def approve_impersonation_request(
    token: str = Path(..., description="Impersonation request token"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Approve an impersonation request.

    The target user must be logged in to approve the request.
    """
    request = impersonation_service.approve_request(db, token, current_user)

    # Calculate remaining time for session
    now = datetime.now(timezone.utc)
    if request.session_expires_at.tzinfo is None:
        session_expires_at = request.session_expires_at.replace(tzinfo=timezone.utc)
    else:
        session_expires_at = request.session_expires_at

    remaining_seconds = max(0, int((session_expires_at - now).total_seconds()))

    return ImpersonationConfirmInfo(
        id=request.id,
        admin_user_name=request.admin_user.user_name,
        target_user_name=request.target_user.user_name,
        status=request.status,
        expires_at=request.session_expires_at,  # Use session expiry after approval
        remaining_seconds=remaining_seconds,
        created_at=request.created_at,
    )


@router.post("/confirm/{token}/reject", response_model=ImpersonationConfirmInfo)
async def reject_impersonation_request(
    token: str = Path(..., description="Impersonation request token"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Reject an impersonation request.

    The target user must be logged in to reject the request.
    """
    request = impersonation_service.reject_request(db, token, current_user)

    return ImpersonationConfirmInfo(
        id=request.id,
        admin_user_name=request.admin_user.user_name,
        target_user_name=request.target_user.user_name,
        status=request.status,
        expires_at=request.expires_at,
        remaining_seconds=0,
        created_at=request.created_at,
    )
