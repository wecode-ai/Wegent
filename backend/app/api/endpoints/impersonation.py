# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Admin API routes for impersonation feature.
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import (
    create_access_token,
    create_impersonation_token,
    get_admin_user,
    get_current_user_with_impersonation_info,
)
from app.models.user import User
from app.schemas.impersonation import (
    ImpersonationAuditLogListResponse,
    ImpersonationAuditLogResponse,
    ImpersonationExitResponse,
    ImpersonationRequestCreate,
    ImpersonationRequestListResponse,
    ImpersonationRequestResponse,
    ImpersonationStartResponse,
)
from app.services.impersonation_service import impersonation_service

router = APIRouter()


def _format_request_response(
    request, confirmation_url: str
) -> ImpersonationRequestResponse:
    """Helper to format impersonation request response."""
    return ImpersonationRequestResponse(
        id=request.id,
        admin_user_id=request.admin_user_id,
        admin_user_name=request.admin_user.user_name,
        target_user_id=request.target_user_id,
        target_user_name=request.target_user.user_name,
        token=request.token,
        status=request.status,
        confirmation_url=confirmation_url,
        expires_at=request.expires_at,
        approved_at=request.approved_at,
        session_expires_at=request.session_expires_at,
        created_at=request.created_at,
        updated_at=request.updated_at,
    )


@router.post(
    "/impersonate/request",
    response_model=ImpersonationRequestResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_impersonation_request(
    data: ImpersonationRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new impersonation request.

    Admin creates a request to impersonate a target user. The request generates
    a confirmation link that must be approved by the target user.
    """
    request = impersonation_service.create_request(
        db=db,
        admin_user=current_user,
        target_user_id=data.target_user_id,
    )

    confirmation_url = impersonation_service.get_confirmation_url(request.token)
    return _format_request_response(request, confirmation_url)


@router.get("/impersonate/requests", response_model=ImpersonationRequestListResponse)
async def list_impersonation_requests(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status_filter: Optional[str] = Query(
        None, description="Filter by status: pending, approved, rejected, expired, used"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    List impersonation requests created by the current admin.
    """
    requests, total = impersonation_service.list_requests(
        db=db,
        admin_user_id=current_user.id,
        page=page,
        limit=limit,
        status_filter=status_filter,
    )

    items = [
        _format_request_response(
            req, impersonation_service.get_confirmation_url(req.token)
        )
        for req in requests
    ]

    return ImpersonationRequestListResponse(total=total, items=items)


@router.get(
    "/impersonate/requests/{request_id}", response_model=ImpersonationRequestResponse
)
async def get_impersonation_request(
    request_id: int = Path(..., description="Impersonation request ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get details of a specific impersonation request.
    """
    request = impersonation_service.get_request(
        db=db, request_id=request_id, admin_user_id=current_user.id
    )

    confirmation_url = impersonation_service.get_confirmation_url(request.token)
    return _format_request_response(request, confirmation_url)


@router.post(
    "/impersonate/requests/{request_id}/cancel",
    response_model=ImpersonationRequestResponse,
)
async def cancel_impersonation_request(
    request_id: int = Path(..., description="Impersonation request ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Cancel a pending impersonation request.
    """
    request = impersonation_service.cancel_request(
        db=db, request_id=request_id, admin_user_id=current_user.id
    )

    confirmation_url = impersonation_service.get_confirmation_url(request.token)
    return _format_request_response(request, confirmation_url)


@router.post(
    "/impersonate/start/{request_id}", response_model=ImpersonationStartResponse
)
async def start_impersonation_session(
    request_id: int = Path(..., description="Impersonation request ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Start an impersonation session after the target user has approved the request.

    Returns a special JWT token that allows the admin to act as the target user.
    """
    request, target_user = impersonation_service.start_session(
        db=db, request_id=request_id, admin_user=current_user
    )

    # Create impersonation token
    access_token = create_impersonation_token(
        target_user=target_user,
        admin_user=current_user,
        impersonation_request_id=request.id,
        session_expires_at=request.session_expires_at,
    )

    return ImpersonationStartResponse(
        access_token=access_token,
        token_type="bearer",
        impersonated_user_id=target_user.id,
        impersonated_user_name=target_user.user_name,
        session_expires_at=request.session_expires_at,
    )


@router.post("/impersonate/exit", response_model=ImpersonationExitResponse)
async def exit_impersonation_session(
    db: Session = Depends(get_db),
    user_info: tuple = Depends(get_current_user_with_impersonation_info),
):
    """
    Exit the current impersonation session and restore admin identity.

    Returns a new JWT token for the original admin user.
    """
    user, impersonation_info = user_info

    if not impersonation_info.get("is_impersonating"):
        # Not in impersonation mode, return current user's token
        access_token = create_access_token(data={"sub": user.user_name})
        return ImpersonationExitResponse(
            access_token=access_token,
            message="No active impersonation session",
        )

    # Get the admin user
    admin_user_id = impersonation_info.get("impersonator_id")
    admin_user = db.query(User).filter(User.id == admin_user_id).first()

    if not admin_user:
        # Fallback to current user if admin not found
        access_token = create_access_token(data={"sub": user.user_name})
        return ImpersonationExitResponse(
            access_token=access_token,
            message="Admin user not found, restored current user session",
        )

    # Create new token for admin user
    access_token = create_access_token(data={"sub": admin_user.user_name})

    return ImpersonationExitResponse(
        access_token=access_token,
        message=f"Successfully exited impersonation of {user.user_name}",
    )


@router.get("/impersonate/audit-logs", response_model=ImpersonationAuditLogListResponse)
async def list_audit_logs(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    request_id: Optional[int] = Query(None, description="Filter by request ID"),
    target_user_id: Optional[int] = Query(None, description="Filter by target user ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    List impersonation audit logs.

    Admins can view audit logs for their own impersonation sessions.
    """
    logs, total = impersonation_service.list_audit_logs(
        db=db,
        page=page,
        limit=limit,
        request_id=request_id,
        admin_user_id=current_user.id,
        target_user_id=target_user_id,
    )

    items = []
    for log in logs:
        items.append(
            ImpersonationAuditLogResponse(
                id=log.id,
                impersonation_request_id=log.impersonation_request_id,
                admin_user_id=log.admin_user_id,
                admin_user_name=log.impersonation_request.admin_user.user_name,
                target_user_id=log.target_user_id,
                target_user_name=log.impersonation_request.target_user.user_name,
                action=log.action,
                method=log.method,
                path=log.path,
                request_body=log.request_body,
                ip_address=log.ip_address,
                user_agent=log.user_agent,
                created_at=log.created_at,
            )
        )

    return ImpersonationAuditLogListResponse(total=total, items=items)
