# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Topic management API endpoints.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.schemas.evaluation import (
    TopicCreate,
    TopicInDB,
    TopicListResponse,
    TopicStatistics,
    TopicUpdate,
    TopicVersionInDB,
)
from wecode.service.evaluation import (
    get_permission_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/topics", response_model=TopicListResponse)
def list_topics(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    visibility: Optional[str] = Query(None, description="Filter by visibility"),
    status_filter: Optional[int] = Query(
        None, alias="status", description="Filter by status"
    ),
    search: Optional[str] = Query(None, description="Search by name"),
    my_only: bool = Query(False, description="Only show my topics"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List topics accessible to the current user.

    Returns public topics, user's own topics, and topics where user has permission.
    """
    topic_service = get_topic_service()

    topics, total = topic_service.list_topics(
        db=db,
        user_id=current_user.id,
        page=page,
        limit=limit,
        visibility=visibility,
        status=status_filter,
        search=search,
        my_only=my_only,
    )

    # Convert to response model
    items = []
    for topic in topics:
        topic_dict = {
            "id": topic.id,
            "name": topic.name,
            "creator_id": topic.creator_id,
            "visibility": topic.visibility,
            "status": topic.status,
            "current_version": topic.current_version,
            "extra_data": topic.extra_data or {},
            "grading_team_config": topic.grading_team_config or {},
            "created_at": topic.created_at,
            "updated_at": topic.updated_at,
            "is_active": topic.is_active,
            "description": (topic.extra_data or {}).get("description"),
        }
        items.append(TopicInDB(**topic_dict))

    return TopicListResponse(total=total, items=items)


@router.post("/topics", response_model=TopicInDB, status_code=status.HTTP_201_CREATED)
def create_topic(
    topic_create: TopicCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new evaluation topic.
    """
    topic_service = get_topic_service()

    topic = topic_service.create(
        db=db,
        user_id=current_user.id,
        name=topic_create.name,
        description=topic_create.description,
        visibility=topic_create.visibility,
        grading_team_id=topic_create.grading_team_id,
    )
    db.commit()

    return TopicInDB(
        id=topic.id,
        name=topic.name,
        creator_id=topic.creator_id,
        visibility=topic.visibility,
        status=topic.status,
        current_version=topic.current_version,
        extra_data=topic.extra_data or {},
        grading_team_config=topic.grading_team_config or {},
        created_at=topic.created_at,
        updated_at=topic.updated_at,
        is_active=topic.is_active,
        description=(topic.extra_data or {}).get("description"),
    )


@router.get("/topics/{topic_id}", response_model=TopicInDB)
def get_topic(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get topic details by ID.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_view_topic(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to view this topic",
        )

    return TopicInDB(
        id=topic.id,
        name=topic.name,
        creator_id=topic.creator_id,
        visibility=topic.visibility,
        status=topic.status,
        current_version=topic.current_version,
        extra_data=topic.extra_data or {},
        grading_team_config=topic.grading_team_config or {},
        created_at=topic.created_at,
        updated_at=topic.updated_at,
        is_active=topic.is_active,
        description=(topic.extra_data or {}).get("description"),
    )


@router.put("/topics/{topic_id}", response_model=TopicInDB)
def update_topic(
    topic_id: int,
    topic_update: TopicUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a topic. Only the creator can update.
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
            detail="Only the creator can edit this topic",
        )

    topic = topic_service.update(
        db=db,
        topic=topic,
        name=topic_update.name,
        description=topic_update.description,
        visibility=topic_update.visibility,
        grading_team_id=topic_update.grading_team_id,
    )
    db.commit()

    return TopicInDB(
        id=topic.id,
        name=topic.name,
        creator_id=topic.creator_id,
        visibility=topic.visibility,
        status=topic.status,
        current_version=topic.current_version,
        extra_data=topic.extra_data or {},
        grading_team_config=topic.grading_team_config or {},
        created_at=topic.created_at,
        updated_at=topic.updated_at,
        is_active=topic.is_active,
        description=(topic.extra_data or {}).get("description"),
    )


@router.delete("/topics/{topic_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_topic(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a topic (soft delete). Only the creator can delete.
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
            detail="Only the creator can delete this topic",
        )

    topic_service.delete(db, topic)
    db.commit()


@router.post("/topics/{topic_id}/publish", response_model=TopicVersionInDB)
def publish_topic(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish a topic. Creates a new version with question snapshots.
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
            detail="Only the creator can publish this topic",
        )

    version = topic_service.publish(db, topic, current_user.id)
    db.commit()

    return TopicVersionInDB(
        id=version.id,
        topic_id=version.topic_id,
        version=version.version,
        question_snapshots=version.question_snapshots,
        published_at=version.published_at,
        published_by=version.published_by,
    )


@router.get("/topics/{topic_id}/statistics", response_model=TopicStatistics)
def get_topic_statistics(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get statistics for a topic.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_view_topic(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to view this topic",
        )

    stats = topic_service.get_statistics(db, topic_id)
    return TopicStatistics(**stats)
