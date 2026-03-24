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
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.user import User
from wecode.models.evaluation import (
    EvalAnswer,
    EvalQuestion,
    EvalQuestionVersion,
)
from wecode.models.evaluation_exam_session import EvalExamSession
from wecode.schemas.evaluation import (
    AggregatorModelConfig,
    GradingConfigResponse,
    GradingConfigUpdate,
    PermissionCreate,
    PermissionInDB,
    PermissionListResponse,
    QuestionCreate,
    QuestionInDB,
    QuestionListResponse,
    QuestionUpdate,
    QuestionVersionInDB,
    QuestionVersionListResponse,
    ScorerModelConfig,
    TopicCreate,
    TopicInDB,
    TopicListResponse,
    TopicStatistics,
    TopicUpdate,
    TopicVersionInDB,
    TopicVersionListResponse,
)
from wecode.service.evaluation import (
    get_exam_session_service,
    get_permission_service,
    get_question_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _verify_topic_ownership(db: Session, topic, user_id: int) -> None:
    """
    Verify that the user can edit/manage the topic.

    Args:
        db: Database session
        topic: Topic to verify
        user_id: User ID to check

    Raises:
        HTTPException: If user is not authorized
    """
    permission_service = get_permission_service()
    if not permission_service.can_edit_topic(db, topic, user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the topic creator or question creator can perform this operation",
        )


def _verify_topic_delete_permission(topic, user_id: int) -> None:
    """
    Verify that the user is the original creator of the topic (for delete operations).

    Args:
        topic: Topic to verify
        user_id: User ID to check

    Raises:
        HTTPException: If user is not the topic creator
    """
    permission_service = get_permission_service()
    if not permission_service.can_delete_topic(topic, user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the topic creator can delete this topic",
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
        raw_criteria = (question.content_data or {}).get("_criteria", {})
        q_dict["criteria_type"] = raw_criteria.get("type", "text")
        q_dict["criteria_data"] = raw_criteria.get("data", {})

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
        instructions=topic_create.instructions,
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
    _verify_topic_ownership(db, topic, current_user.id)

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
    _verify_topic_ownership(db, topic, current_user.id)

    topic_service = get_topic_service()
    topic = topic_service.update(
        db=db,
        topic=topic,
        name=topic_update.name,
        visibility=topic_update.visibility,
        grading_team_id=topic_update.grading_team_id,
        extra_data=topic_update.extra_data,
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
    _verify_topic_delete_permission(topic, current_user.id)

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
    Only the topic creator or question creator can publish.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

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


@router.get("/topics/{topic_id}/versions", response_model=TopicVersionListResponse)
def get_topic_versions(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get version history for a topic.

    Only the topic creator or question creator can access this endpoint.
    Returns all versions sorted by published date (newest first).
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    topic_service = get_topic_service()
    versions, total = topic_service.list_versions(db, topic_id, page=page, limit=limit)

    return TopicVersionListResponse(
        total=total,
        items=[
            TopicVersionInDB(
                id=v.id,
                topic_id=v.topic_id,
                version=v.version,
                question_snapshots=v.question_snapshots,
                published_at=v.published_at,
                published_by=v.published_by,
            )
            for v in versions
        ],
    )


@router.get("/topics/{topic_id}/statistics", response_model=TopicStatistics)
def get_topic_statistics(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get statistics for a topic.

    Only the topic creator or question creator can access this endpoint.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

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
    _verify_topic_ownership(db, topic, current_user.id)

    question_service = get_question_service()
    question = question_service.create(
        db=db,
        topic_id=topic_id,
        user_id=current_user.id,
        title=question_create.title,
        content_type=question_create.content_type,
        content_data=question_create.content_data,
        criteria_type=question_create.criteria_type,
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
    _verify_topic_ownership(db, topic, current_user.id)

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


@router.get("/questions/{question_id}", response_model=QuestionInDB)
def get_question(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a single question by ID.

    Only the topic creator can access this endpoint.
    Returns full question data including criteria.
    """
    question_service = get_question_service()

    question = question_service.get(db, question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = _get_topic_or_404(db, question.topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    return _question_to_response(question, include_criteria=True)


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
    _verify_topic_ownership(db, topic, current_user.id)

    question = question_service.update(
        db=db,
        question=question,
        title=question_update.title,
        content_type=question_update.content_type,
        content_data=question_update.content_data,
        criteria_type=question_update.criteria_type,
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
    _verify_topic_ownership(db, topic, current_user.id)

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
    _verify_topic_ownership(db, topic, current_user.id)

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


@router.get(
    "/questions/{question_id}/versions", response_model=QuestionVersionListResponse
)
def list_question_versions(
    question_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List all versions of a question.

    Only the topic creator can view question versions.
    """
    question_service = get_question_service()

    question = question_service.get(db, question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = _get_topic_or_404(db, question.topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    # Query versions
    query = db.query(EvalQuestionVersion).filter(
        EvalQuestionVersion.question_id == question_id
    )
    total = query.count()
    versions = (
        query.order_by(EvalQuestionVersion.published_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return QuestionVersionListResponse(
        total=total,
        items=[
            QuestionVersionInDB(
                id=v.id,
                question_id=v.question_id,
                version=v.version,
                content_data=v.content_data,
                criteria_data=v.criteria_data,
                published_at=v.published_at,
                published_by=v.published_by,
            )
            for v in versions
        ],
    )


# ============================================================================
# Permission Endpoints
# ============================================================================


@router.post(
    "/topics/{topic_id}/permissions",
    response_model=PermissionInDB,
    status_code=status.HTTP_201_CREATED,
)
def create_permission(
    topic_id: int,
    permission_create: PermissionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new permission for a user on a topic.

    Only the topic creator or question creator can manage permissions.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    # Validate role
    if permission_create.role not in ("respondent", "grader", "question_creator"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role must be 'respondent', 'grader', or 'question_creator'",
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


@router.put("/topics/{topic_id}/permissions", response_model=PermissionInDB)
def update_permission(
    topic_id: int,
    permission_create: PermissionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update permission for a user on a topic.

    Only the topic creator or question creator can manage permissions.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    # Validate role
    if permission_create.role not in ("respondent", "grader", "question_creator"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role must be 'respondent', 'grader', or 'question_creator'",
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
    _verify_topic_ownership(db, topic, current_user.id)

    permission_service = get_permission_service()
    permissions, total = permission_service.list_permissions(
        db=db,
        topic_id=topic_id,
        role=role,
        page=page,
        limit=limit,
    )

    # Get user info for all permissions
    user_ids = [perm.user_id for perm in permissions]
    users_map = {}
    if user_ids:
        users = db.query(User).filter(User.id.in_(user_ids)).all()
        users_map = {u.id: u for u in users}

    items = []
    for perm in permissions:
        user = users_map.get(perm.user_id)
        items.append(
            PermissionInDB(
                id=perm.id,
                topic_id=perm.topic_id,
                user_id=perm.user_id,
                role=perm.role,
                granted_by=perm.granted_by,
                granted_at=perm.granted_at,
                user_name=user.user_name if user else None,
                user_email=user.email if user else None,
            )
        )

    return PermissionListResponse(total=total, items=items)


@router.delete(
    "/topics/{topic_id}/permissions/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_permission(
    topic_id: int,
    user_id: int,
    role: Optional[str] = Query(None, description="Role to revoke (optional)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete/revoke permission for a user on a topic.

    Only the topic creator can manage permissions.
    If role is specified, only revoke that specific role.
    If role is not specified, revoke all permissions for that user.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    permission_service = get_permission_service()
    revoked = permission_service.revoke_permission(
        db=db,
        topic_id=topic_id,
        user_id=user_id,
        role=role,
    )
    db.commit()

    if not revoked:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Permission not found",
        )


@router.get("/topics/{topic_id}/graders", response_model=PermissionListResponse)
def get_graders(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get list of graders for a topic.

    Only the topic creator or question creator can view graders.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    permission_service = get_permission_service()
    permissions, total = permission_service.list_permissions(
        db=db,
        topic_id=topic_id,
        role="grader",
        page=page,
        limit=limit,
    )

    # Get user info for all permissions
    user_ids = [perm.user_id for perm in permissions]
    users_map = {}
    if user_ids:
        users = db.query(User).filter(User.id.in_(user_ids)).all()
        users_map = {u.id: u for u in users}

    items = []
    for perm in permissions:
        user = users_map.get(perm.user_id)
        items.append(
            PermissionInDB(
                id=perm.id,
                topic_id=perm.topic_id,
                user_id=perm.user_id,
                role=perm.role,
                granted_by=perm.granted_by,
                granted_at=perm.granted_at,
                user_name=user.user_name if user else None,
                user_email=user.email if user else None,
            )
        )

    return PermissionListResponse(total=total, items=items)


# ============================================================================
# Grading Configuration Endpoints
# ============================================================================


@router.get("/topics/{topic_id}/grading-config", response_model=GradingConfigResponse)
def get_grading_config(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get grading configuration for a topic.

    Only the topic creator or question creator can view grading configuration.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    config = topic.grading_team_config or {}

    # Try to get team name if team_id is configured
    team_name = None
    team_valid = True
    team_id = config.get("team_id")
    if team_id:
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.kind == "Team",
                Kind.is_active,
            )
            .first()
        )
        if team:
            team_name = team.name
        else:
            team_valid = False

    # Parse scorer_models from config (stored as dicts in JSON)
    scorer_models_data = config.get("scorer_models", [])
    scorer_models = (
        [ScorerModelConfig(**m) for m in scorer_models_data]
        if scorer_models_data
        else []
    )

    # Parse aggregator_model from config
    aggregator_model_data = config.get("aggregator_model")
    aggregator_model = (
        AggregatorModelConfig(**aggregator_model_data)
        if aggregator_model_data
        else None
    )

    return GradingConfigResponse(
        team_id=config.get("team_id"),
        auto_trigger=config.get("auto_trigger", False),
        trigger_condition=config.get("trigger_condition", "manual"),
        grading_timeout=config.get("grading_timeout", 3600),
        prompt_template=config.get("prompt_template"),
        model_id=config.get("model_id"),
        force_override_bot_model=config.get("force_override_bot_model", False),
        team_name=team_name,
        team_valid=team_valid,
        grading_mode=config.get("grading_mode", "single"),
        scorer_team_id=config.get("scorer_team_id"),
        aggregator_team_id=config.get("aggregator_team_id"),
        scorer_models=scorer_models,
        aggregator_model=aggregator_model,
        scorer_prompt_template=config.get("scorer_prompt_template"),
        aggregator_prompt_template=config.get("aggregator_prompt_template"),
    )


@router.put("/topics/{topic_id}/grading-config", response_model=GradingConfigResponse)
def update_grading_config(
    topic_id: int,
    config_update: GradingConfigUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update grading configuration for a topic.

    Only the topic creator or question creator can update grading configuration.

    Constraints:
    - Team must be of Chat shell type (for AI grading)
    - Team must belong to the user or be a public team
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    # Validate team_id if provided
    team_name = None
    team_valid = True
    if config_update.team_id:
        team = (
            db.query(Kind)
            .filter(
                Kind.id == config_update.team_id,
                Kind.kind == "Team",
                Kind.is_active,
            )
            .first()
        )

        if not team:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Team not found",
            )

        # Check access permission:
        # 1. User owns the team (team.user_id == current_user.id)
        # 2. Team is public (is_public=True in spec)
        # 3. Team belongs to a group the user is a member of
        has_access = False
        if team.user_id == current_user.id:
            has_access = True
        else:
            team_spec = team.json.get("spec", {}) if team.json else {}
            if team_spec.get("is_public", False):
                has_access = True
            elif team.namespace and team.namespace != "default":
                # Team belongs to a group - check if user is a member
                from app.services.group_permission import get_user_groups

                user_groups = get_user_groups(db, current_user.id)
                if team.namespace in user_groups:
                    has_access = True

        if not has_access:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to this team",
            )

        # Verify team shell type is Chat (optional validation)
        # This ensures the team can be used for AI grading
        team_name = team.name
        team_valid = True

    # Update grading config
    # Note: Must reassign the entire dict for SQLAlchemy to detect changes on JSON fields
    existing_config = topic.grading_team_config or {}
    updated_config = {
        **existing_config,
        "team_id": config_update.team_id,
        "auto_trigger": config_update.auto_trigger,
        "trigger_condition": config_update.trigger_condition,
        "grading_timeout": config_update.grading_timeout,
    }
    # Only include optional fields if they are explicitly provided (not None)
    if config_update.prompt_template is not None:
        updated_config["prompt_template"] = config_update.prompt_template
    if config_update.model_id is not None:
        updated_config["model_id"] = config_update.model_id
    if config_update.force_override_bot_model is not None:
        updated_config["force_override_bot_model"] = (
            config_update.force_override_bot_model
        )

    # Multi-model grading fields
    if config_update.grading_mode is not None:
        updated_config["grading_mode"] = config_update.grading_mode
    if config_update.scorer_team_id is not None:
        updated_config["scorer_team_id"] = config_update.scorer_team_id
    if config_update.aggregator_team_id is not None:
        updated_config["aggregator_team_id"] = config_update.aggregator_team_id
    if config_update.scorer_models is not None:
        updated_config["scorer_models"] = [
            m.model_dump() for m in config_update.scorer_models
        ]
    if config_update.aggregator_model is not None:
        updated_config["aggregator_model"] = config_update.aggregator_model.model_dump()
    if config_update.scorer_prompt_template is not None:
        updated_config["scorer_prompt_template"] = config_update.scorer_prompt_template
    if config_update.aggregator_prompt_template is not None:
        updated_config["aggregator_prompt_template"] = (
            config_update.aggregator_prompt_template
        )

    topic.grading_team_config = updated_config
    # Explicitly mark the JSON field as modified to ensure SQLAlchemy persists the change
    flag_modified(topic, "grading_team_config")

    db.commit()

    return GradingConfigResponse(
        team_id=config_update.team_id,
        auto_trigger=config_update.auto_trigger,
        trigger_condition=config_update.trigger_condition,
        grading_timeout=config_update.grading_timeout,
        prompt_template=config_update.prompt_template,
        model_id=config_update.model_id,
        force_override_bot_model=config_update.force_override_bot_model,
        team_name=team_name,
        team_valid=team_valid,
        grading_mode=config_update.grading_mode,
        scorer_team_id=config_update.scorer_team_id,
        aggregator_team_id=config_update.aggregator_team_id,
        scorer_models=config_update.scorer_models,
        aggregator_model=config_update.aggregator_model,
        scorer_prompt_template=config_update.scorer_prompt_template,
        aggregator_prompt_template=config_update.aggregator_prompt_template,
    )


# ============================================================================
# Topic Rollback Endpoint
# ============================================================================


@router.post("/topics/{topic_id}/rollback", response_model=TopicInDB)
def rollback_topic(
    topic_id: int,
    version: str = Query(..., description="Version to rollback to"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Rollback a topic to a specific version.

    This updates the current_version to the specified previous version.
    Only the topic creator or question creator can rollback.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    topic_service = get_topic_service()

    # Verify the version exists
    topic_version = topic_service.get_version(db, topic_id, version)
    if not topic_version:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Version not found",
        )

    # Update current version
    topic.current_version = version
    db.commit()

    return _topic_to_response(topic)


# ============================================================================
# Exam Session Management Endpoints
# ============================================================================


@router.get("/topics/{topic_id}/exam-sessions")
def get_topic_exam_sessions(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    phase: Optional[str] = Query(
        None, description="Filter by phase (intro, exam, review, completed)"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all exam sessions for a topic (author only).

    Returns session information including:
    - User ID and name
    - Start time
    - Current phase (intro, exam, review, completed)
    - Submit count
    - Selected question ID

    Supports filtering by phase and pagination.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    extra_data = topic.extra_data or {}

    # Build base query
    query = (
        db.query(EvalExamSession, User)
        .join(User, EvalExamSession.user_id == User.id)
        .filter(
            EvalExamSession.topic_id == topic_id,
            EvalExamSession.is_active == 1,
        )
    )

    # Apply phase filter if provided
    if phase:
        query = query.filter(EvalExamSession.current_phase == phase)

    # Get total count before pagination
    total = query.count()

    # Apply pagination
    sessions = query.offset((page - 1) * limit).limit(limit).all()

    # Build simplified session list without redundant topic data
    # Use batch processing for better performance with many sessions
    exam_session_service = get_exam_session_service()
    session_objects = [s for s, _ in sessions]
    sessions_status = exam_session_service.get_sessions_status_batch(session_objects)

    session_list = []
    for session, user in sessions:
        session_status = sessions_status.get(session.user_id, {})
        session_list.append(
            {
                "user_id": session.user_id,
                "user_name": user.user_name if user else f"User {session.user_id}",
                "user_email": user.email if user else None,
                "current_phase": session.current_phase,
                "started_at": (
                    session.started_at.isoformat() if session.started_at else None
                ),
                "selected_question_id": session.selected_question_id or None,
                "exam_duration_seconds": session_status.get("exam_duration_seconds"),
                "remaining_seconds": session_status.get("remaining_seconds", 0),
                "is_overtime": session_status.get("is_overtime", False),
            }
        )

    # Return topic info at top level + simplified sessions list
    return {
        "topic": {
            "id": topic.id,
            "name": topic.name,
            "description": extra_data.get("description"),
            "exam_mode": True,
            "intro_duration_minutes": extra_data.get("introDurationMinutes", 5),
            "exam_duration_minutes": extra_data.get("examDurationMinutes", 50),
            "review_duration_minutes": extra_data.get("reviewDurationMinutes", 5),
        },
        "sessions": session_list,
        "total": total,
        "page": page,
        "limit": limit,
    }


@router.post("/topics/{topic_id}/exam-sessions/{user_id}/reset")
def reset_user_exam_session(
    topic_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Reset exam session for a user (author only).

    Soft deletes the active session, allowing the user to start fresh.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    exam_session_service = get_exam_session_service()
    exam_session_service.reset_session(db, topic_id, user_id)

    return {"success": True, "message": "Exam session reset successfully"}


class UpdateSessionPhaseRequest(BaseModel):
    """Schema for updating exam session phase (author only)."""

    target_phase: str = Field(
        ..., description="Target phase to set (intro, exam, review, completed)"
    )
    force: bool = Field(
        default=False, description="Force transition even if not in valid sequence"
    )


@router.post("/topics/{topic_id}/exam-sessions/{user_id}/update-phase")
def update_user_exam_session_phase(
    topic_id: int,
    user_id: int,
    request: UpdateSessionPhaseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update exam session phase for a user (author only).

    This allows the topic author to manually control a user's exam session state:
    - intro: Initial phase
    - exam: Exam answering phase
    - review: Review phase
    - completed: Completed (triggers grading task creation)

    By default, only valid transitions are allowed. Set force=true to allow any transition.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    exam_session_service = get_exam_session_service()

    # Get user's active session
    session = exam_session_service.get_active_session(db, topic_id, user_id)
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active exam session found for this user",
        )

    # Validate target phase
    valid_phases = ["intro", "exam", "review", "completed"]
    if request.target_phase not in valid_phases:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid phase. Must be one of: {', '.join(valid_phases)}",
        )

    previous_phase = session.current_phase

    # Check if transition is valid (unless force=true)
    if not request.force:
        valid_transitions = {
            "intro": ["exam"],
            "exam": ["review", "completed"],  # Allow skip to completed
            "review": ["completed"],
            "completed": [],
        }
        if request.target_phase not in valid_transitions.get(previous_phase, []):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot transition from '{previous_phase}' to '{request.target_phase}'. "
                f"Use force=true to override.",
            )

    # If transitioning to completed, use complete_exam_session (handles text conversion)
    # Otherwise, use regular update_session_phase
    if request.target_phase == "completed":
        exam_session_service.complete_exam_session(db=db, session=session)

        # Create grading tasks
        from wecode.api.evaluation.respondent import (
            _create_grading_tasks_for_exam_completion,
        )

        _create_grading_tasks_for_exam_completion(
            db=db,
            topic_id=topic_id,
            user_id=user_id,
            topic=topic,
        )
    else:
        exam_session_service.update_session_phase(
            db=db,
            session=session,
            target_phase=request.target_phase,
        )

    return {
        "success": True,
        "message": f"Session phase updated from '{previous_phase}' to '{request.target_phase}'",
        "previous_phase": previous_phase,
        "current_phase": request.target_phase,
        "user_id": user_id,
    }


@router.post("/topics/{topic_id}/exam-sessions/{user_id}/force-end")
def force_end_exam_session(
    topic_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Force end a user's exam session and trigger grading (author only).

    This immediately sets the session to 'completed' and creates grading tasks
    for all submitted answers. Useful when a user abandons the exam or
    encounters technical issues.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    exam_session_service = get_exam_session_service()

    # Get user's active session
    session = exam_session_service.get_active_session(db, topic_id, user_id)
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active exam session found for this user",
        )

    # Cannot force-end an already completed session
    if session.current_phase == "completed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Session is already completed",
        )

    previous_phase = session.current_phase

    # Use complete_exam_session to end the exam (handles text conversion)
    exam_session_service.complete_exam_session(db=db, session=session)

    # Create grading tasks
    from wecode.api.evaluation.respondent import (
        _create_grading_tasks_for_exam_completion,
    )

    _create_grading_tasks_for_exam_completion(
        db=db,
        topic_id=topic_id,
        user_id=user_id,
        topic=topic,
    )

    return {
        "success": True,
        "message": f"Session force-ended (was: {previous_phase}) and grading tasks created",
        "previous_phase": previous_phase,
        "current_phase": "completed",
        "user_id": user_id,
    }


@router.get("/topics/{topic_id}/exam-sessions/{user_id}/detail")
def get_exam_session_detail(
    topic_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get detailed exam session information including all answers and attachments (author only).

    Returns comprehensive session data for reviewing a candidate's submission:
    - Session status and timing information
    - User information
    - All answers with content and attachments
    - Selected question details
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    exam_session_service = get_exam_session_service()

    # Get user's session (including inactive/archived ones)
    session = (
        db.query(EvalExamSession)
        .filter(
            EvalExamSession.topic_id == topic_id,
            EvalExamSession.user_id == user_id,
        )
        .order_by(EvalExamSession.id.desc())
        .first()
    )

    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No exam session found for this user",
        )

    # Get user info
    user = db.query(User).filter(User.id == user_id).first()

    # Get session status
    session_status = exam_session_service.get_session_status(session)

    # Get all questions for this topic
    questions = (
        db.query(EvalQuestion)
        .filter(
            EvalQuestion.topic_id == topic_id,
            EvalQuestion.is_active == True,
        )
        .order_by(EvalQuestion.order_index.asc())
        .all()
    )

    # Get all answers for this user in this topic
    question_ids = [q.id for q in questions]
    answers = (
        db.query(EvalAnswer)
        .filter(
            EvalAnswer.question_id.in_(question_ids),
            EvalAnswer.respondent_id == user_id,
            EvalAnswer.is_latest == True,
        )
        .all()
    )

    # Build answers map by question_id
    answers_map = {a.question_id: a for a in answers}

    # Build question list with answers
    questions_with_answers = []
    for question in questions:
        answer = answers_map.get(question.id)
        questions_with_answers.append(
            {
                "id": question.id,
                "title": question.title,
                "content_type": question.content_type,
                "content_data": question.content_data,
                "order_index": question.order_index,
                "answer": (
                    {
                        "id": answer.id,
                        "content_type": answer.content_type,
                        "content_data": answer.content_data,
                        "submitted_at": (
                            answer.submitted_at.isoformat()
                            if answer.submitted_at
                            else None
                        ),
                        "question_version": answer.question_version,
                    }
                    if answer
                    else None
                ),
            }
        )

    # Get all answers from session extra_data (for exam mode with allAnswers)
    session_all_answers = {}
    if session.extra_data and "allAnswers" in session.extra_data:
        session_all_answers = session.extra_data.get("allAnswers", {})

    return {
        "session": {
            "user_id": session.user_id,
            "user_name": user.user_name if user else f"User {session.user_id}",
            "user_email": user.email if user else None,
            "current_phase": session.current_phase,
            "started_at": (
                session.started_at.isoformat() if session.started_at else None
            ),
            "completed_at": (
                session.completed_at.isoformat() if session.completed_at else None
            ),
            "selected_question_id": session.selected_question_id or None,
            "is_active": session.is_active == 1,
            **session_status,
        },
        "topic": {
            "id": topic.id,
            "name": topic.name,
            "description": (
                topic.extra_data.get("description") if topic.extra_data else None
            ),
        },
        "questions": questions_with_answers,
        "session_all_answers": session_all_answers,
    }
