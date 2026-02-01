# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for knowledge base permission management.
"""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from app.schemas.knowledge_permission import (
    MyPermissionResponse,
    PermissionAddRequest,
    PermissionApplyRequest,
    PermissionApplyResponse,
    PermissionListResponse,
    PermissionResponse,
    PermissionReviewRequest,
    PermissionReviewResponse,
    PermissionUpdateRequest,
)
from app.services.knowledge.permission_service import KnowledgePermissionService
from app.services.knowledge.permission_webhook import (
    send_permission_request_notification,
    send_permission_review_notification,
)
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

router = APIRouter()


# ============== Permission Apply Endpoints ==============


@router.post("/{kb_id}/permissions/apply", response_model=PermissionApplyResponse)
@trace_sync("apply_permission", "knowledge.permission.api")
def apply_permission(
    kb_id: int,
    request: PermissionApplyRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Apply for knowledge base access permission.

    Users can apply for view or edit permission to a knowledge base
    through the share link.
    """
    try:
        result = KnowledgePermissionService.apply_permission(
            db=db,
            knowledge_base_id=kb_id,
            user_id=current_user.id,
            request=request,
        )
        db.commit()

        # Send webhook notification to KB owner in background
        background_tasks.add_task(
            send_permission_request_notification,
            db_url=str(settings.DATABASE_URL),
            permission_id=result.id,
            kb_id=kb_id,
            applicant_id=current_user.id,
            applicant_name=current_user.user_name,
            applicant_email=current_user.email,
            permission_level=result.permission_level.value,
        )

        return result
    except ValueError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        db.rollback()
        logger.exception(f"Error applying for permission: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to apply for permission",
        )


# ============== Permission Review Endpoints ==============


@router.post(
    "/{kb_id}/permissions/{permission_id}/review",
    response_model=PermissionReviewResponse,
)
@trace_sync("review_permission", "knowledge.permission.api")
def review_permission(
    kb_id: int,
    permission_id: int,
    request: PermissionReviewRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Review a permission request (approve or reject).

    Only KB creator or users with manage permission can review requests.
    """
    try:
        result = KnowledgePermissionService.review_permission(
            db=db,
            knowledge_base_id=kb_id,
            permission_id=permission_id,
            reviewer_id=current_user.id,
            request=request,
        )
        db.commit()

        # Send webhook notification to applicant in background
        background_tasks.add_task(
            send_permission_review_notification,
            db_url=str(settings.DATABASE_URL),
            permission_id=permission_id,
            kb_id=kb_id,
            applicant_id=result.user_id,
            permission_level=result.permission_level.value,
            status=result.status.value,
        )

        return result
    except ValueError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        db.rollback()
        logger.exception(f"Error reviewing permission: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to review permission",
        )


# ============== Permission Management Endpoints ==============


@router.get("/{kb_id}/permissions", response_model=PermissionListResponse)
@trace_sync("list_permissions", "knowledge.permission.api")
def list_permissions(
    kb_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List all permissions for a knowledge base.

    Returns pending requests and approved permissions grouped by level.
    Only KB creator or users with manage permission can access.
    """
    try:
        return KnowledgePermissionService.list_permissions(
            db=db,
            knowledge_base_id=kb_id,
            user_id=current_user.id,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )
    except Exception as e:
        logger.exception(f"Error listing permissions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list permissions",
        )


@router.post("/{kb_id}/permissions", response_model=PermissionResponse)
@trace_sync("add_permission", "knowledge.permission.api")
def add_permission(
    kb_id: int,
    request: PermissionAddRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Directly add permission for a user (without request).

    Only KB creator or users with manage permission can add permissions.
    """
    try:
        result = KnowledgePermissionService.add_permission(
            db=db,
            knowledge_base_id=kb_id,
            admin_user_id=current_user.id,
            request=request,
        )
        db.commit()
        return result
    except ValueError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        db.rollback()
        logger.exception(f"Error adding permission: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to add permission",
        )


@router.put("/{kb_id}/permissions/{permission_id}", response_model=PermissionResponse)
@trace_sync("update_permission", "knowledge.permission.api")
def update_permission(
    kb_id: int,
    permission_id: int,
    request: PermissionUpdateRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update a user's permission level.

    Only KB creator or users with manage permission can update permissions.
    """
    try:
        result = KnowledgePermissionService.update_permission(
            db=db,
            knowledge_base_id=kb_id,
            permission_id=permission_id,
            admin_user_id=current_user.id,
            request=request,
        )
        db.commit()
        return result
    except ValueError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        db.rollback()
        logger.exception(f"Error updating permission: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update permission",
        )


@router.delete("/{kb_id}/permissions/{permission_id}")
@trace_sync("delete_permission", "knowledge.permission.api")
def delete_permission(
    kb_id: int,
    permission_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete (revoke) a user's permission.

    Only KB creator or users with manage permission can delete permissions.
    """
    try:
        KnowledgePermissionService.delete_permission(
            db=db,
            knowledge_base_id=kb_id,
            permission_id=permission_id,
            admin_user_id=current_user.id,
        )
        db.commit()
        return {"message": "Permission deleted successfully"}
    except ValueError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        db.rollback()
        logger.exception(f"Error deleting permission: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete permission",
        )


# ============== Current User Permission Endpoint ==============


@router.get("/{kb_id}/permissions/my", response_model=MyPermissionResponse)
@trace_sync("get_my_permission", "knowledge.permission.api")
def get_my_permission(
    kb_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get current user's permission for a knowledge base.

    Returns the user's access level and any pending request.
    """
    return KnowledgePermissionService.get_my_permission(
        db=db,
        knowledge_base_id=kb_id,
        user_id=current_user.id,
    )


# ============== Knowledge Base Info for Share Page ==============


@router.get("/{kb_id}/share-info")
@trace_sync("get_kb_share_info", "knowledge.permission.api")
def get_kb_share_info(
    kb_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get knowledge base info for share page.

    Returns basic info about the KB and current user's permission status.
    This is used by the share link page to display KB info and handle
    permission requests.
    """
    # Get KB basic info (allow access even without permission for share page)
    kb = (
        db.query(Kind)
        .filter(
            Kind.id == kb_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active == True,
        )
        .first()
    )

    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )

    spec = kb.json.get("spec", {})

    # Get current user's permission
    my_permission = KnowledgePermissionService.get_my_permission(
        db=db,
        knowledge_base_id=kb_id,
        user_id=current_user.id,
    )

    # Get creator info
    creator = db.query(User).filter(User.id == kb.user_id).first()
    creator_name = creator.user_name if creator else f"User {kb.user_id}"

    return {
        "id": kb.id,
        "name": spec.get("name", ""),
        "description": spec.get("description"),
        "namespace": kb.namespace,
        "creator_id": kb.user_id,
        "creator_name": creator_name,
        "created_at": kb.created_at.isoformat() if kb.created_at else None,
        "my_permission": my_permission.model_dump(),
    }
