# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Permission management API endpoints.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.schemas.evaluation import (
    PermissionCreate,
    PermissionInDB,
    PermissionListResponse,
)
from wecode.service.evaluation import (
    get_permission_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/topics/{topic_id}/permissions", response_model=PermissionListResponse)
def list_permissions(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    role: Optional[str] = Query(None, description="Filter by role"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List permissions for a topic. Only the creator can view permissions.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the creator can manage permissions",
        )

    permissions, total = permission_service.list_permissions(
        db=db,
        topic_id=topic_id,
        role=role,
        page=page,
        limit=limit,
    )

    items = []
    for perm in permissions:
        items.append(
            PermissionInDB(
                id=perm.id,
                topic_id=perm.topic_id,
                user_id=perm.user_id,
                role=perm.role,
                granted_by=perm.granted_by,
                granted_at=perm.granted_at,
            )
        )

    return PermissionListResponse(total=total, items=items)


@router.post(
    "/topics/{topic_id}/permissions",
    response_model=PermissionInDB,
    status_code=status.HTTP_201_CREATED,
)
def grant_permission(
    topic_id: int,
    permission_create: PermissionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Grant permission to a user for a topic.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the creator can manage permissions",
        )

    # Validate role
    if permission_create.role not in ("respondent", "grader"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role must be 'respondent' or 'grader'",
        )

    permission = permission_service.grant_permission(
        db=db,
        topic_id=topic_id,
        user_id=permission_create.user_id,
        role=permission_create.role,
        granted_by=current_user.id,
    )
    db.commit()

    return PermissionInDB(
        id=permission.id,
        topic_id=permission.topic_id,
        user_id=permission.user_id,
        role=permission.role,
        granted_by=permission.granted_by,
        granted_at=permission.granted_at,
    )


@router.delete(
    "/topics/{topic_id}/permissions/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def revoke_permission(
    topic_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Revoke permission from a user.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the creator can manage permissions",
        )

    revoked = permission_service.revoke_permission(db, topic_id, user_id)
    if not revoked:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Permission not found",
        )

    db.commit()


@router.post("/topics/{topic_id}/permissions/batch")
def batch_grant_permissions(
    topic_id: int,
    user_ids: List[int],
    role: str = "respondent",
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Grant permissions to multiple users.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the creator can manage permissions",
        )

    if role not in ("respondent", "grader"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role must be 'respondent' or 'grader'",
        )

    permissions = permission_service.batch_grant_permissions(
        db=db,
        topic_id=topic_id,
        user_ids=user_ids,
        role=role,
        granted_by=current_user.id,
    )
    db.commit()

    return {"granted_count": len(permissions)}


@router.get("/topics/{topic_id}/my-role")
def get_my_role(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get current user's role for a topic.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    role = permission_service.get_user_role(db, topic, current_user.id)

    return {
        "topic_id": topic_id,
        "user_id": current_user.id,
        "role": role,
        "can_view": permission_service.can_view_topic(db, topic, current_user.id),
        "can_edit": permission_service.can_edit_topic(topic, current_user.id),
        "can_answer": permission_service.can_answer(db, topic, current_user.id),
        "can_grade": permission_service.can_grade(db, topic, current_user.id),
    }
