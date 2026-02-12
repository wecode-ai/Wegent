# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Author (topic creator) API endpoints.

This router handles all endpoints for the "author" role, which includes:
- Topic CRUD operations (create, read, update, delete)
- Topic publishing and version management
- Question management within topics
- Permission management for topics
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
    QuestionCreate,
    QuestionInDB,
    QuestionListResponse,
    QuestionUpdate,
    QuestionVersionInDB,
    TopicCreate,
    TopicInDB,
    TopicListResponse,
    TopicStatistics,
    TopicUpdate,
    TopicVersionInDB,
)
from wecode.service.evaluation import (
    get_permission_service,
    get_question_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _verify_topic_ownership(topic, user_id: int) -> None:
    """
    Verify that the user is the creator of the topic.

    Args:
        topic: Topic to verify
        user_id: User ID to check

    Raises:
        HTTPException: If user is not the topic creator
    """
    permission_service = get_permission_service()
    if not permission_service.can_edit_topic(topic, user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the topic creator can perform this operation",
        )


def _get_topic_or_404(db: Session, topic_id: int):
    """
    Get topic by ID or raise 404.

    Args:
        db: Database session
        topic_id: Topic ID

    Returns:
        Topic if found

    Raises:
        HTTPException: If topic not found
    """
    topic_service = get_topic_service()
    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )
    return topic


def _topic_to_response(topic) -> TopicInDB:
    """
    Convert topic model to response schema.

    Args:
        topic: Topic model instance

    Returns:
        TopicInDB response
    """
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


def _question_to_response(question, include_criteria: bool = True) -> QuestionInDB:
    """
    Convert question model to response schema.

    Args:
        question: Question model instance
        include_criteria: Whether to include criteria data

    Returns:
        QuestionInDB response
    """
    q_dict = {
        "id": question.id,
        "topic_id": question.topic_id,
        "title": question.title,
        "content_type": question.content_type,
        "content_data": {
            k: v for k, v in (question.content_data or {}).items() if k != "_criteria"
        },
        "status": question.status,
        "current_version": question.current_version,
        "order_index": question.order_index,
        "creator_id": question.creator_id,
        "created_at": question.created_at,
        "updated_at": question.updated_at,
        "is_active": question.is_active,
    }

    if include_criteria:
        q_dict["criteria_data"] = (question.content_data or {}).get("_criteria", {})

    return QuestionInDB(**q_dict)


# ============================================================================
# Topic Endpoints
# ============================================================================


@router.get("/topics", response_model=TopicListResponse)
def list_my_topics(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    visibility: Optional[str] = Query(None, description="Filter by visibility"),
    status_filter: Optional[int] = Query(
        None, alias="status", description="Filter by status"
    ),
    search: Optional[str] = Query(None, description="Search by name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List topics created by the current user.

    This endpoint returns only topics where the current user is the creator.
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
        my_only=True,  # Only show user's own topics
    )

    items = [_topic_to_response(topic) for topic in topics]

    return TopicListResponse(total=total, items=items)


@router.post("/topics", response_model=TopicInDB, status_code=status.HTTP_201_CREATED)
def create_topic(
    topic_create: TopicCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new evaluation topic.

    The current user will be set as the topic creator.
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

    return _topic_to_response(topic)


@router.get("/topics/{topic_id}", response_model=TopicInDB)
def get_topic(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get topic details by ID.

    Only the topic creator can access this endpoint.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    return _topic_to_response(topic)


@router.put("/topics/{topic_id}", response_model=TopicInDB)
def update_topic(
    topic_id: int,
    topic_update: TopicUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a topic.

    Only the topic creator can update.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    topic_service = get_topic_service()
    topic = topic_service.update(
        db=db,
        topic=topic,
        name=topic_update.name,
        description=topic_update.description,
        visibility=topic_update.visibility,
        grading_team_id=topic_update.grading_team_id,
    )
    db.commit()

    return _topic_to_response(topic)


@router.delete("/topics/{topic_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_topic(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a topic (soft delete).

    Only the topic creator can delete.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    topic_service = get_topic_service()
    topic_service.delete(db, topic)
    db.commit()


@router.post("/topics/{topic_id}/publish", response_model=TopicVersionInDB)
def publish_topic(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish a topic.

    Creates a new version with question snapshots.
    Only the topic creator can publish.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    topic_service = get_topic_service()
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


@router.get("/topics/{topic_id}/versions", response_model=List[TopicVersionInDB])
def get_topic_versions(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get version history for a topic.

    Only the topic creator can access this endpoint.
    Returns all versions sorted by published date (newest first).
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    topic_service = get_topic_service()
    versions = topic_service.list_versions(db, topic_id)

    return [
        TopicVersionInDB(
            id=v.id,
            topic_id=v.topic_id,
            version=v.version,
            question_snapshots=v.question_snapshots,
            published_at=v.published_at,
            published_by=v.published_by,
        )
        for v in versions
    ]


@router.get("/topics/{topic_id}/statistics", response_model=TopicStatistics)
def get_topic_statistics(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get statistics for a topic.

    Only the topic creator can access this endpoint.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    topic_service = get_topic_service()
    stats = topic_service.get_statistics(db, topic_id)

    return TopicStatistics(**stats)


# ============================================================================
# Question Endpoints
# ============================================================================


@router.post(
    "/topics/{topic_id}/questions",
    response_model=QuestionInDB,
    status_code=status.HTTP_201_CREATED,
)
def add_question(
    topic_id: int,
    question_create: QuestionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Add a new question to a topic.

    Only the topic creator can add questions.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    question_service = get_question_service()
    question = question_service.create(
        db=db,
        topic_id=topic_id,
        user_id=current_user.id,
        title=question_create.title,
        content_type=question_create.content_type,
        content_data=question_create.content_data,
        criteria_data=question_create.criteria_data,
        order_index=question_create.order_index or 0,
    )
    db.commit()

    return _question_to_response(question)


@router.get("/topics/{topic_id}/questions", response_model=QuestionListResponse)
def list_questions(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    status_filter: Optional[int] = Query(
        None, alias="status", description="Filter by status"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List questions for a topic.

    Only the topic creator can access this endpoint.
    Returns all questions including draft ones, with criteria data.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    question_service = get_question_service()
    questions, total = question_service.list_questions(
        db=db,
        topic_id=topic_id,
        page=page,
        limit=limit,
        status=status_filter,
        include_criteria=True,  # Authors can always see criteria
    )

    items = [_question_to_response(q, include_criteria=True) for q in questions]

    return QuestionListResponse(total=total, items=items)


@router.put("/questions/{question_id}", response_model=QuestionInDB)
def update_question(
    question_id: int,
    question_update: QuestionUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a question.

    Only the topic creator can update questions.
    """
    question_service = get_question_service()

    question = question_service.get(db, question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = _get_topic_or_404(db, question.topic_id)
    _verify_topic_ownership(topic, current_user.id)

    question = question_service.update(
        db=db,
        question=question,
        title=question_update.title,
        content_type=question_update.content_type,
        content_data=question_update.content_data,
        criteria_data=question_update.criteria_data,
        order_index=question_update.order_index,
    )
    db.commit()

    return _question_to_response(question)


@router.delete("/questions/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_question(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a question (soft delete).

    Only the topic creator can delete questions.
    """
    question_service = get_question_service()

    question = question_service.get(db, question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = _get_topic_or_404(db, question.topic_id)
    _verify_topic_ownership(topic, current_user.id)

    question_service.delete(db, question)
    db.commit()


@router.post("/questions/{question_id}/publish", response_model=QuestionVersionInDB)
def publish_question(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish a question.

    Creates a new version. Only the topic creator can publish questions.
    """
    question_service = get_question_service()

    question = question_service.get(db, question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = _get_topic_or_404(db, question.topic_id)
    _verify_topic_ownership(topic, current_user.id)

    version = question_service.publish(db, question, current_user.id)
    db.commit()

    return QuestionVersionInDB(
        id=version.id,
        question_id=version.question_id,
        version=version.version,
        content_data=version.content_data,
        criteria_data=version.criteria_data,
        published_at=version.published_at,
        published_by=version.published_by,
    )


# ============================================================================
# Permission Endpoints
# ============================================================================


@router.put("/topics/{topic_id}/permissions", response_model=PermissionInDB)
def set_permission(
    topic_id: int,
    permission_create: PermissionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Set (grant or update) permission for a user on a topic.

    Only the topic creator can manage permissions.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    # Validate role
    if permission_create.role not in ("respondent", "grader"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role must be 'respondent' or 'grader'",
        )

    permission_service = get_permission_service()
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


@router.get("/topics/{topic_id}/permissions", response_model=PermissionListResponse)
def get_permissions(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    role: Optional[str] = Query(None, description="Filter by role"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get permissions for a topic.

    Only the topic creator can view permissions.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(topic, current_user.id)

    permission_service = get_permission_service()
    permissions, total = permission_service.list_permissions(
        db=db,
        topic_id=topic_id,
        role=role,
        page=page,
        limit=limit,
    )

    items = [
        PermissionInDB(
            id=perm.id,
            topic_id=perm.topic_id,
            user_id=perm.user_id,
            role=perm.role,
            granted_by=perm.granted_by,
            granted_at=perm.granted_at,
        )
        for perm in permissions
    ]

    return PermissionListResponse(total=total, items=items)
