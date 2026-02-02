# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified share API endpoints.

Provides REST API for managing share links and resource members.
Supports Team, Task, and KnowledgeBase resource types.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.share import (
    JoinByLinkRequest,
    JoinByLinkResponse,
    KBShareInfoResponse,
    MemberListResponse,
    MyKBPermissionResponse,
    PendingRequestListResponse,
    PermissionLevel,
    ResourceMemberCreate,
    ResourceMemberResponse,
    ResourceMemberUpdate,
    ResourceType,
    ReviewRequestBody,
    ReviewRequestResponse,
    ShareInfoResponse,
    ShareLinkConfig,
    ShareLinkCreate,
    ShareLinkResponse,
    ShareLinkUpdate,
)
from app.services.share import (
    knowledge_share_service,
    task_share_service,
    team_share_service,
)
from app.services.share.base_service import UnifiedShareService

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_share_service(resource_type: str) -> UnifiedShareService:
    """Get the appropriate share service for a resource type."""
    resource_type_upper = resource_type.upper()
    if resource_type_upper == "TEAM" or resource_type == "Team":
        return team_share_service
    elif resource_type_upper == "TASK" or resource_type == "Task":
        return task_share_service
    elif (
        resource_type_upper == "KNOWLEDGEBASE"
        or resource_type_upper == "KNOWLEDGE_BASE"
        or resource_type == "KnowledgeBase"
    ):
        return knowledge_share_service
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid resource type: {resource_type}. "
            "Supported types: Team, Task, KnowledgeBase",
        )


# =============================================================================
# Share Link Endpoints
# =============================================================================


@router.post(
    "/{resource_type}/{resource_id}/link",
    response_model=ShareLinkResponse,
    summary="Create or update share link",
)
def create_share_link(
    resource_type: str,
    resource_id: int,
    body: ShareLinkCreate = ShareLinkCreate(),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create or update a share link for a resource.

    Only the resource owner can create share links.
    If a share link already exists, it will be updated with the new configuration.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    - **body**: Share link configuration (require_approval, default_permission_level, expires_in_hours)
    """
    service = _get_share_service(resource_type)
    return service.create_share_link(
        db=db,
        resource_id=resource_id,
        user_id=current_user.id,
        config=body.config,
    )


@router.get(
    "/{resource_type}/{resource_id}/link",
    response_model=Optional[ShareLinkResponse],
    summary="Get share link",
)
def get_share_link(
    resource_type: str,
    resource_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get the active share link for a resource.

    Returns None if no active share link exists.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    """
    service = _get_share_service(resource_type)
    return service.get_share_link(
        db=db,
        resource_id=resource_id,
        user_id=current_user.id,
    )


@router.delete(
    "/{resource_type}/{resource_id}/link",
    summary="Delete share link",
)
def delete_share_link(
    resource_type: str,
    resource_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Deactivate the share link for a resource.

    Only the resource owner can delete share links.
    Existing members will retain their access.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    """
    service = _get_share_service(resource_type)
    service.delete_share_link(
        db=db,
        resource_id=resource_id,
        user_id=current_user.id,
    )
    return {"message": "Share link deleted successfully"}


# =============================================================================
# Public Share Info (no auth required)
# =============================================================================


@router.get(
    "/info",
    response_model=ShareInfoResponse,
    summary="Get share info (public)",
)
def get_share_info(
    share_token: str,
    db: Session = Depends(get_db),
):
    """
    Get public information about a share link.

    No authentication required - used for share link preview.

    - **share_token**: Share token from URL
    """
    # Try each service to decode the token
    for service in [team_share_service, task_share_service, knowledge_share_service]:
        try:
            return service.get_share_info(db=db, share_token=share_token)
        except HTTPException as e:
            if e.status_code == 400 and "Invalid resource type" in str(e.detail):
                continue
            elif e.status_code == 400 and "Invalid share token" in str(e.detail):
                continue
            raise

    raise HTTPException(status_code=400, detail="Invalid share token")


# =============================================================================
# Join Endpoints
# =============================================================================


@router.post(
    "/join",
    response_model=JoinByLinkResponse,
    summary="Join via share link",
)
def join_by_link(
    body: JoinByLinkRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Request to join a shared resource via share link.

    If the share link requires approval, a pending request will be created.
    Otherwise, access is granted immediately.

    - **share_token**: Share token from URL
    - **requested_permission_level**: Optional requested permission level
    """
    # Try each service to find the matching one
    for service in [team_share_service, task_share_service, knowledge_share_service]:
        try:
            return service.join_by_link(
                db=db,
                share_token=body.share_token,
                user_id=current_user.id,
                requested_permission_level=body.requested_permission_level,
            )
        except HTTPException as e:
            if e.status_code == 400 and "Invalid resource type" in str(e.detail):
                continue
            elif e.status_code == 400 and "Invalid share token" in str(e.detail):
                continue
            raise

    raise HTTPException(status_code=400, detail="Invalid share token")


# =============================================================================
# Member Management Endpoints
# =============================================================================


@router.get(
    "/{resource_type}/{resource_id}/members",
    response_model=MemberListResponse,
    summary="Get members",
)
def get_members(
    resource_type: str,
    resource_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all approved members of a resource.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    """
    service = _get_share_service(resource_type)
    return service.get_members(
        db=db,
        resource_id=resource_id,
        user_id=current_user.id,
    )


@router.post(
    "/{resource_type}/{resource_id}/members",
    response_model=ResourceMemberResponse,
    summary="Add member",
)
def add_member(
    resource_type: str,
    resource_id: int,
    body: ResourceMemberCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Directly add a member to a resource.

    Requires owner or manage permission.
    The member is added with approved status immediately.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    - **body**: Member info (user_id, permission_level)
    """
    service = _get_share_service(resource_type)
    return service.add_member(
        db=db,
        resource_id=resource_id,
        current_user_id=current_user.id,
        target_user_id=body.user_id,
        permission_level=body.permission_level,
    )


@router.put(
    "/{resource_type}/{resource_id}/members/{member_id}",
    response_model=ResourceMemberResponse,
    summary="Update member",
)
def update_member(
    resource_type: str,
    resource_id: int,
    member_id: int,
    body: ResourceMemberUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a member's permission level.

    Requires owner or manage permission.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    - **member_id**: Member record ID
    - **body**: Update info (permission_level)
    """
    if not body.permission_level:
        raise HTTPException(status_code=400, detail="permission_level is required")

    service = _get_share_service(resource_type)
    return service.update_member(
        db=db,
        resource_id=resource_id,
        member_id=member_id,
        current_user_id=current_user.id,
        permission_level=body.permission_level,
    )


@router.delete(
    "/{resource_type}/{resource_id}/members/{member_id}",
    summary="Remove member",
)
def remove_member(
    resource_type: str,
    resource_id: int,
    member_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Remove a member from a resource.

    Requires owner or manage permission.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    - **member_id**: Member record ID
    """
    service = _get_share_service(resource_type)
    service.remove_member(
        db=db,
        resource_id=resource_id,
        member_id=member_id,
        current_user_id=current_user.id,
    )
    return {"message": "Member removed successfully"}


# =============================================================================
# Approval Endpoints
# =============================================================================


@router.get(
    "/{resource_type}/{resource_id}/requests",
    response_model=PendingRequestListResponse,
    summary="Get pending requests",
)
def get_pending_requests(
    resource_type: str,
    resource_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get pending approval requests for a resource.

    Requires owner or manage permission.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    """
    service = _get_share_service(resource_type)
    return service.get_pending_requests(
        db=db,
        resource_id=resource_id,
        user_id=current_user.id,
    )


@router.post(
    "/{resource_type}/{resource_id}/requests/{request_id}/review",
    response_model=ReviewRequestResponse,
    summary="Review request",
)
def review_request(
    resource_type: str,
    resource_id: int,
    request_id: int,
    body: ReviewRequestBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Approve or reject a pending request.

    Requires owner or manage permission.

    - **resource_type**: Resource type (Team, Task, KnowledgeBase)
    - **resource_id**: Resource ID
    - **request_id**: Pending request (member) ID
    - **body**: Review decision (approved, optional permission_level)
    """
    service = _get_share_service(resource_type)
    return service.review_request(
        db=db,
        resource_id=resource_id,
        request_id=request_id,
        reviewer_id=current_user.id,
        approved=body.approved,
        permission_level=body.permission_level,
    )


# =============================================================================
# KnowledgeBase Specific Endpoints
# =============================================================================


@router.get(
    "/KnowledgeBase/{resource_id}/my-permission",
    response_model=MyKBPermissionResponse,
    summary="Get my KnowledgeBase permission",
)
def get_my_kb_permission(
    resource_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get current user's permission for a knowledge base.

    Returns permission level, creator status, and pending request info.

    - **resource_id**: Knowledge base ID
    """
    return knowledge_share_service.get_my_permission(
        db=db,
        knowledge_base_id=resource_id,
        user_id=current_user.id,
    )


@router.get(
    "/KnowledgeBase/{resource_id}/share-info",
    response_model=KBShareInfoResponse,
    summary="Get KnowledgeBase share info",
)
def get_kb_share_info(
    resource_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get knowledge base info for share page.

    Returns KB basic info and current user's permission status.
    Used by share link page to display KB info and handle permission requests.

    - **resource_id**: Knowledge base ID
    """
    try:
        return knowledge_share_service.get_kb_share_info(
            db=db,
            knowledge_base_id=resource_id,
            user_id=current_user.id,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
