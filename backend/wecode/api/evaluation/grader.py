# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Grader API endpoints.

This module provides endpoints for the "grader" role to manage
grading tasks, view answers, and publish reports.
"""

import logging
from datetime import datetime
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.models.evaluation import (
    EvalAnswer,
    EvalGradingTask,
    EvalPermission,
    EvalQuestion,
    EvalTopic,
    GradingTaskStatus,
    PermissionRole,
)
from wecode.schemas.evaluation import (
    AnswerInDB,
    GradingTaskExecuteRequest,
    GradingTaskInDB,
    GradingTaskListResponse,
    GradingTaskPublishRequest,
    GradingTaskUpdateReportRequest,
    MultiModelGradingConfig,
    QuestionInDB,
    TopicStatistics,
)
from wecode.service.evaluation import (
    get_answer_service,
    get_grading_service,
    get_permission_service,
    get_question_service,
    get_topic_service,
)
from wecode.service.evaluation.grading_service import (
    build_multi_model_config as build_base_multi_model_config,
)
from wecode.service.evaluation.storage_service import EvalStorageService

logger = logging.getLogger(__name__)
router = APIRouter()


# ============================================================================
# Dashboard Schemas
# ============================================================================


class GraderDashboardStats(BaseModel):
    """Dashboard statistics for a grader."""

    pending_count: int = Field(0, description="Number of pending grading tasks")
    running_count: int = Field(0, description="Number of running grading tasks")
    completed_count: int = Field(0, description="Number of completed grading tasks")
    failed_count: int = Field(0, description="Number of failed grading tasks")
    published_count: int = Field(0, description="Number of published reports")
    total_answers: int = Field(0, description="Total number of answers to grade")
    total_topics: int = Field(0, description="Total number of accessible topics")
    recent_activity: List[GradingTaskInDB] = Field(
        default_factory=list, description="Recent grading activity"
    )


class AnswerWithGradingInfo(AnswerInDB):
    """Answer with associated grading task information."""

    grading_task: Optional[GradingTaskInDB] = Field(
        None, description="Associated grading task"
    )
    question_title: Optional[str] = Field(None, description="Question title")
    topic_id: Optional[int] = Field(None, description="Topic ID")
    topic_name: Optional[str] = Field(None, description="Topic name")


class AnswerWithGradingListResponse(BaseModel):
    """Paginated list response for answers with grading info."""

    total: int
    items: List[AnswerWithGradingInfo]


class ReportInDB(BaseModel):
    """Schema for published report data."""

    id: int
    answer_id: int
    question_id: int
    question_version: str
    respondent_id: int
    grader_id: int
    report_data: dict
    report_s3_path: str
    published_at: Optional[str]

    # Additional info
    respondent_name: Optional[str] = None
    question_title: Optional[str] = None
    topic_id: Optional[int] = None
    topic_name: Optional[str] = None

    class Config:
        from_attributes = True


class ReportListResponse(BaseModel):
    """Paginated list response for published reports."""

    total: int
    items: List[ReportInDB]


# ============================================================================
# Helper Functions
# ============================================================================


def _check_grader_permission(
    db: Session,
    topic: EvalTopic,
    user_id: int,
    permission_service,
):
    """
    Check if user has grader permission for a topic.

    Raises HTTPException if not authorized.
    """
    if not permission_service.can_grade(db, topic, user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have grader permission for this topic",
        )


def _get_topic_ids_with_grader_access(
    db: Session,
    user_id: int,
    permission_service,
) -> List[int]:
    """
    Get all topic IDs where user has grader access.

    Returns topic IDs where user is creator OR has grader permission.
    Grader permission includes both 'grader' and 'question_creator' roles,
    consistent with PermissionService.has_permission() logic.
    """
    # Topics where user is creator
    created_topics = (
        db.query(EvalTopic.id)
        .filter(
            EvalTopic.creator_id == user_id,
            EvalTopic.is_active,
        )
        .all()
    )

    # Topics where user has grader permission
    # This aligns with PermissionService.has_permission() logic where
    # GRADER role check includes both GRADER and QUESTION_CREATOR roles
    grader_topics = (
        db.query(EvalPermission.topic_id)
        .filter(
            EvalPermission.user_id == user_id,
            EvalPermission.role.in_(
                [PermissionRole.GRADER, PermissionRole.QUESTION_CREATOR]
            ),
        )
        .all()
    )

    topic_ids = set()
    for (topic_id,) in created_topics:
        topic_ids.add(topic_id)
    for (topic_id,) in grader_topics:
        topic_ids.add(topic_id)

    return list(topic_ids)


def _convert_task_to_schema(
    task: EvalGradingTask,
    question_title: Optional[str] = None,
    respondent_name: Optional[str] = None,
    topic_id: Optional[int] = None,
    topic_name: Optional[str] = None,
    submitted_at: Optional[datetime] = None,
) -> GradingTaskInDB:
    """Convert a grading task model to schema."""
    # Get grading_mode from report_data (stored there since there's no dedicated column)
    report_data = task.report_data or {}
    grading_mode = (
        report_data.get("grading_mode") if isinstance(report_data, dict) else None
    )
    return GradingTaskInDB(
        id=task.id,
        answer_id=task.answer_id,
        question_id=task.question_id,
        question_version=task.question_version,
        respondent_id=task.respondent_id,
        grader_id=task.grader_id,
        team_id=task.team_id,
        task_id=task.task_id,
        status=task.status,
        report_data=report_data,
        report_s3_path=task.report_s3_path,
        created_at=task.created_at,
        started_at=task.started_at,
        completed_at=task.completed_at,
        published_at=task.published_at,
        version=task.version,
        question_title=question_title,
        respondent_name=respondent_name,
        topic_id=topic_id,
        topic_name=topic_name,
        submitted_at=submitted_at,
        grading_mode=grading_mode,
    )


def _convert_answer_to_schema(answer: EvalAnswer) -> AnswerInDB:
    """Convert an answer model to schema."""
    return AnswerInDB(
        id=answer.id,
        question_id=answer.question_id,
        question_version=answer.question_version,
        respondent_id=answer.respondent_id,
        content_type=answer.content_type,
        content_data=answer.content_data,
        submitted_at=answer.submitted_at,
        is_latest=answer.is_latest,
    )


# ============================================================================
# Topic Endpoints (Grader View)
# ============================================================================


class GraderTopicInDB(BaseModel):
    """Topic information for grader view."""

    id: int
    name: str
    creator_id: int
    visibility: str
    status: int
    current_version: str
    created_at: str
    updated_at: str
    # Statistics
    total_answers: int = Field(0, description="Total answers submitted")
    pending_tasks: int = Field(0, description="Pending grading tasks")
    completed_tasks: int = Field(0, description="Completed grading tasks")
    published_tasks: int = Field(0, description="Published reports")

    class Config:
        from_attributes = True


class GraderTopicListResponse(BaseModel):
    """Paginated list response for grader topics."""

    total: int
    items: List[GraderTopicInDB]


@router.get("/topics", response_model=GraderTopicListResponse)
def list_grader_topics(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List all topics where the current user has grader access.

    Returns topics where user is creator OR has grader permission,
    along with grading statistics for each topic.
    """
    permission_service = get_permission_service()

    # Get topic IDs with grader access
    topic_ids = _get_topic_ids_with_grader_access(
        db, current_user.id, permission_service
    )

    if not topic_ids:
        return GraderTopicListResponse(total=0, items=[])

    # Query topics with pagination
    query = db.query(EvalTopic).filter(
        EvalTopic.id.in_(topic_ids),
        EvalTopic.is_active,
    )

    total = query.count()
    topics = (
        query.order_by(EvalTopic.updated_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    items = []
    for topic in topics:
        # Get question IDs for this topic - use scalar_subquery for IN clause
        question_ids = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id == topic.id,
                EvalQuestion.is_active,
            )
            .scalar_subquery()
        )

        # Count answers
        total_answers = (
            db.query(func.count(EvalAnswer.id))
            .filter(EvalAnswer.question_id.in_(question_ids))
            .scalar()
            or 0
        )

        # Count tasks by status
        pending = (
            db.query(func.count(EvalGradingTask.id))
            .filter(
                EvalGradingTask.question_id.in_(question_ids),
                EvalGradingTask.status == GradingTaskStatus.PENDING,
            )
            .scalar()
            or 0
        )

        completed = (
            db.query(func.count(EvalGradingTask.id))
            .filter(
                EvalGradingTask.question_id.in_(question_ids),
                EvalGradingTask.status == GradingTaskStatus.COMPLETED,
            )
            .scalar()
            or 0
        )

        published = (
            db.query(func.count(EvalGradingTask.id))
            .filter(
                EvalGradingTask.question_id.in_(question_ids),
                EvalGradingTask.status == GradingTaskStatus.PUBLISHED,
            )
            .scalar()
            or 0
        )

        items.append(
            GraderTopicInDB(
                id=topic.id,
                name=topic.name,
                creator_id=topic.creator_id,
                visibility=topic.visibility,
                status=topic.status,
                current_version=topic.current_version,
                created_at=topic.created_at.isoformat(),
                updated_at=topic.updated_at.isoformat(),
                total_answers=total_answers,
                pending_tasks=pending,
                completed_tasks=completed,
                published_tasks=published,
            )
        )

    return GraderTopicListResponse(total=total, items=items)


@router.get("/topics/{topic_id}", response_model=GraderTopicInDB)
def get_grader_topic(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get detailed topic information for a grader.

    Returns topic info with grading statistics.
    Requires grader permission for the topic.
    """
    permission_service = get_permission_service()
    topic_service = get_topic_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # Get question IDs for this topic - use scalar_subquery for IN clause
    question_ids = (
        db.query(EvalQuestion.id)
        .filter(
            EvalQuestion.topic_id == topic.id,
            EvalQuestion.is_active,
        )
        .scalar_subquery()
    )

    # Count answers
    total_answers = (
        db.query(func.count(EvalAnswer.id))
        .filter(EvalAnswer.question_id.in_(question_ids))
        .scalar()
        or 0
    )

    # Count tasks by status
    pending = (
        db.query(func.count(EvalGradingTask.id))
        .filter(
            EvalGradingTask.question_id.in_(question_ids),
            EvalGradingTask.status == GradingTaskStatus.PENDING,
        )
        .scalar()
        or 0
    )

    completed = (
        db.query(func.count(EvalGradingTask.id))
        .filter(
            EvalGradingTask.question_id.in_(question_ids),
            EvalGradingTask.status == GradingTaskStatus.COMPLETED,
        )
        .scalar()
        or 0
    )

    published = (
        db.query(func.count(EvalGradingTask.id))
        .filter(
            EvalGradingTask.question_id.in_(question_ids),
            EvalGradingTask.status == GradingTaskStatus.PUBLISHED,
        )
        .scalar()
        or 0
    )

    return GraderTopicInDB(
        id=topic.id,
        name=topic.name,
        creator_id=topic.creator_id,
        visibility=topic.visibility,
        status=topic.status,
        current_version=topic.current_version,
        created_at=topic.created_at.isoformat(),
        updated_at=topic.updated_at.isoformat(),
        total_answers=total_answers,
        pending_tasks=pending,
        completed_tasks=completed,
        published_tasks=published,
    )


@router.get("/topics/{topic_id}/statistics", response_model=TopicStatistics)
def get_grader_topic_statistics(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get statistics for a topic (grader view).

    Requires grader permission for the topic.
    """
    permission_service = get_permission_service()
    topic_service = get_topic_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # Reuse the topic service statistics method
    stats = topic_service.get_statistics(db, topic_id)

    return TopicStatistics(**stats)


# ============================================================================
# Dashboard Endpoints
# ============================================================================


@router.get("/dashboard", response_model=GraderDashboardStats)
def get_grader_dashboard(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get dashboard statistics for the grader.

    Returns aggregated task counts by status and recent activity
    across all topics where the user has grader access.
    """
    permission_service = get_permission_service()

    # Get topic IDs with grader access
    topic_ids = _get_topic_ids_with_grader_access(
        db, current_user.id, permission_service
    )

    if not topic_ids:
        return GraderDashboardStats()

    # Get question IDs for these topics - use scalar_subquery for IN clause
    question_ids_query = (
        db.query(EvalQuestion.id)
        .filter(
            EvalQuestion.topic_id.in_(topic_ids),
            EvalQuestion.is_active,
        )
        .scalar_subquery()
    )

    # Count tasks by status
    status_counts = (
        db.query(EvalGradingTask.status, func.count(EvalGradingTask.id))
        .filter(EvalGradingTask.question_id.in_(question_ids_query))
        .group_by(EvalGradingTask.status)
        .all()
    )

    counts = {s: c for s, c in status_counts}

    # Count total answers
    total_answers = (
        db.query(func.count(EvalAnswer.id))
        .filter(
            EvalAnswer.question_id.in_(question_ids_query),
            EvalAnswer.is_latest,
        )
        .scalar()
    )

    # Get recent activity (last 10 tasks)
    recent_tasks = (
        db.query(EvalGradingTask)
        .filter(EvalGradingTask.question_id.in_(question_ids_query))
        .order_by(EvalGradingTask.created_at.desc())
        .limit(10)
        .all()
    )

    return GraderDashboardStats(
        pending_count=counts.get(GradingTaskStatus.PENDING, 0),
        running_count=counts.get(GradingTaskStatus.RUNNING, 0),
        completed_count=counts.get(GradingTaskStatus.COMPLETED, 0),
        failed_count=counts.get(GradingTaskStatus.FAILED, 0),
        published_count=counts.get(GradingTaskStatus.PUBLISHED, 0),
        total_answers=total_answers or 0,
        total_topics=len(topic_ids),
        recent_activity=[_convert_task_to_schema(t) for t in recent_tasks],
    )


# ============================================================================
# Grading Tasks Endpoints
# ============================================================================


@router.get("/tasks", response_model=GradingTaskListResponse)
def list_grader_tasks(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    status_filter: Optional[int] = Query(
        None, alias="status", description="Filter by status"
    ),
    topic_id: Optional[int] = Query(None, description="Filter by topic"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List grading tasks accessible to the grader.

    Supports filtering by status and topic.
    """
    permission_service = get_permission_service()
    topic_service = get_topic_service()

    # If topic_id specified, verify grader permission
    if topic_id:
        topic = topic_service.get(db, topic_id)
        if not topic:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Topic not found",
            )
        _check_grader_permission(db, topic, current_user.id, permission_service)
        topic_ids = [topic_id]
    else:
        # Get all topics with grader access
        topic_ids = _get_topic_ids_with_grader_access(
            db, current_user.id, permission_service
        )

    if not topic_ids:
        return GradingTaskListResponse(total=0, items=[])

    # Get question IDs for these topics - use scalar_subquery for IN clause
    question_ids_query = (
        db.query(EvalQuestion.id)
        .filter(
            EvalQuestion.topic_id.in_(topic_ids),
            EvalQuestion.is_active,
        )
        .scalar_subquery()
    )

    # Build base query with joins to fetch all related data in one query
    base_query = (
        db.query(
            EvalGradingTask,
            EvalQuestion.title.label("question_title"),
            EvalQuestion.topic_id.label("topic_id"),
            EvalTopic.name.label("topic_name"),
            User.user_name.label("respondent_name"),
            EvalAnswer.submitted_at.label("submitted_at"),
        )
        .join(EvalQuestion, EvalGradingTask.question_id == EvalQuestion.id)
        .join(EvalTopic, EvalQuestion.topic_id == EvalTopic.id)
        .outerjoin(User, EvalGradingTask.respondent_id == User.id)
        .outerjoin(EvalAnswer, EvalGradingTask.answer_id == EvalAnswer.id)
        .filter(EvalGradingTask.question_id.in_(question_ids_query))
    )

    if status_filter is not None:
        base_query = base_query.filter(EvalGradingTask.status == status_filter)

    # Get total count
    total = base_query.count()

    # Get paginated results
    results = (
        base_query.order_by(EvalGradingTask.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return GradingTaskListResponse(
        total=total,
        items=[
            _convert_task_to_schema(
                task,
                question_title=question_title,
                respondent_name=respondent_name,
                topic_id=topic_id,
                topic_name=topic_name,
                submitted_at=submitted_at,
            )
            for task, question_title, topic_id, topic_name, respondent_name, submitted_at in results
        ],
    )


@router.get("/tasks/{task_id}", response_model=GradingTaskInDB)
def get_grader_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get grading task details.

    Requires grader permission for the associated topic.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    task = grading_service.get(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grading task not found",
        )

    question = question_service.get(db, task.question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # Get respondent name
    respondent = db.query(User).filter(User.id == task.respondent_id).first()
    respondent_name = respondent.user_name if respondent else None

    # Get answer submission time
    answer = db.query(EvalAnswer).filter(EvalAnswer.id == task.answer_id).first()
    submitted_at = answer.submitted_at if answer else None

    return _convert_task_to_schema(
        task,
        question_title=question.title,
        respondent_name=respondent_name,
        topic_id=topic.id,
        topic_name=topic.name,
        submitted_at=submitted_at,
    )


def _validate_task_access(
    db: Session,
    task: EvalGradingTask,
    current_user_id: int,
    permission_service,
    allowed_statuses: list | None = None,
) -> EvalTopic:
    """
    Validate user has access to grading task.

    Args:
        task: The grading task to validate
        allowed_statuses: Optional list of allowed statuses for the operation

    Returns:
        The topic associated with the task

    Raises:
        HTTPException: If validation fails
    """
    if allowed_statuses and task.status not in allowed_statuses:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Task cannot be executed in current status",
        )

    # Get question and topic
    question = (
        db.query(EvalQuestion).filter(EvalQuestion.id == task.question_id).first()
    )
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = db.query(EvalTopic).filter(EvalTopic.id == question.topic_id).first()
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user_id, permission_service)

    return topic


def _get_task_for_grading(
    db: Session,
    task_id: int,
    grading_service,
    permission_service,
    current_user_id: int,
    allowed_statuses: list,
) -> tuple[EvalGradingTask, EvalTopic, int]:
    """Get and validate grading task with all related entities."""
    task = grading_service.get(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grading task not found",
        )

    topic = _validate_task_access(
        db, task, current_user_id, permission_service, allowed_statuses
    )

    # Get team ID from topic config (supports both single and multi modes)
    config = topic.grading_team_config or {}
    grading_mode = config.get("grading_mode", "single")

    if grading_mode == "multi":
        # Multi mode: use scorer_team_id
        team_id = config.get("scorer_team_id")
    else:
        # Single mode: use team_id
        team_id = config.get("team_id")

    if not team_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No grading team configured",
        )

    return task, topic, team_id


def _build_multi_model_config(
    topic: EvalTopic,
    request: Optional[GradingTaskExecuteRequest],
) -> Optional[MultiModelGradingConfig]:
    """
    Build multi-model grading config from topic config and request overrides.

    This function:
    1. Uses base config from topic.grading_team_config
    2. Applies request overrides if provided (for manual retry with different settings)
    """
    config = topic.grading_team_config or {}

    # Check if multi-model mode is enabled (from request or config)
    grading_mode = (
        request.grading_mode
        if request and request.grading_mode
        else config.get("grading_mode", "single")
    )

    if grading_mode != "multi":
        return None

    # Get base config from topic
    base_config = build_base_multi_model_config(config)

    # Apply request overrides if provided (for manual execution with custom settings)
    if request:
        scorer_team_id = request.scorer_team_id or (
            base_config.scorer_team_id if base_config else None
        )
        aggregator_team_id = request.aggregator_team_id or (
            base_config.aggregator_team_id if base_config else None
        )
        scorer_models = request.scorer_models or (
            base_config.scorer_models if base_config else []
        )
        aggregator_model = request.aggregator_model or (
            base_config.aggregator_model if base_config else None
        )
    else:
        # No request, use base config directly
        return base_config

    # Validate required fields
    if not all([scorer_team_id, aggregator_team_id, scorer_models, aggregator_model]):
        return None

    return MultiModelGradingConfig(
        scorer_team_id=scorer_team_id,
        aggregator_team_id=aggregator_team_id,
        scorer_models=scorer_models,
        aggregator_model=aggregator_model,
        scorer_prompt_template=config.get("scorer_prompt_template"),
        aggregator_prompt_template=config.get("aggregator_prompt_template"),
    )


@router.post("/tasks/{task_id}/execute", response_model=GradingTaskInDB)
def execute_grader_task(
    task_id: int,
    request: GradingTaskExecuteRequest = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Execute AI grading for a pending or failed task."""
    grading_service = get_grading_service()

    task, topic, team_id = _get_task_for_grading(
        db,
        task_id,
        grading_service,
        get_permission_service(),
        current_user.id,
        [GradingTaskStatus.PENDING, GradingTaskStatus.FAILED],
    )

    if request and request.team_id:
        team_id = request.team_id

    model_id = request.model_id if request else None
    force_override = request.force_override_bot_model if request else False

    # Check for multi-model grading configuration
    multi_model_config = _build_multi_model_config(topic, request)

    task = grading_service.execute(
        db,
        task,
        team_id,
        current_user.id,
        model_id=model_id,
        force_override_bot_model=force_override,
        multi_model_config=multi_model_config,
    )
    db.commit()

    return _convert_task_to_schema(task)


@router.post("/tasks/{task_id}/retry", response_model=GradingTaskInDB)
def retry_grader_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Retry AI grading for tasks in any status except non-existent.

    Note: All grading configuration (mode, team, models) is determined by
    topic's original configuration set by the topic author. Graders can only
    trigger the retry, cannot modify any configuration.
    """
    grading_service = get_grading_service()

    # Allow retry for all statuses - AI report is independent of publish status
    task, topic, team_id = _get_task_for_grading(
        db,
        task_id,
        grading_service,
        get_permission_service(),
        current_user.id,
        None,  # Allow any status
    )

    # Always use topic's original config - graders cannot modify anything
    config = topic.grading_team_config or {}
    grading_mode = config.get("grading_mode", "single")

    if grading_mode == "multi":
        multi_model_config = _build_multi_model_config(topic, None)
        task = grading_service.execute(
            db,
            task,
            team_id,
            current_user.id,
            multi_model_config=multi_model_config,
        )
    else:
        # Single mode - use config from topic, no overrides
        # Extract model config from topic config
        model_id = config.get("model_id")
        # When model_id is specified, default force_override to True for consistency
        # with multi-model mode behavior (ScorerModelConfig defaults force_override=True)
        force_override = config.get(
            "force_override_bot_model", True if model_id else False
        )
        task = grading_service.execute(
            db,
            task,
            team_id,
            current_user.id,
            model_id=model_id,
            force_override_bot_model=force_override,
        )

    db.commit()

    return _convert_task_to_schema(task)


@router.put("/tasks/{task_id}/report", response_model=GradingTaskInDB)
def update_grader_task_report(
    task_id: int,
    request: GradingTaskUpdateReportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update report content before publishing.

    The task must be in COMPLETED status.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    task = grading_service.get(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grading task not found",
        )

    # Allow updating human report draft in any status except RUNNING
    # Design: human_report is always a draft that can be edited and re-published
    if task.status == GradingTaskStatus.RUNNING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot update tasks that are currently running",
        )

    question = question_service.get(db, task.question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # Optimistic locking: check version before updating
    if task.version != request.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Report has been modified by another user",
                "current_version": task.version,
                "current_report": task.report_data,
            },
        )

    task = grading_service.update_report(
        db, task, request.report_content, current_user.id
    )
    db.commit()

    return _convert_task_to_schema(task)


@router.post("/tasks/{task_id}/publish", response_model=GradingTaskInDB)
def publish_grader_task(
    task_id: int,
    request: GradingTaskPublishRequest = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish a grading report to the respondent.

    The task must be in COMPLETED status or PENDING status with a human report.
    This allows manual grading when no AI grading bot is configured.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    task = grading_service.get(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grading task not found",
        )

    # Allow publishing if task is COMPLETED, or PENDING/FAILED with a human report
    # This supports manual-only grading scenarios
    # Also allow re-publishing if already PUBLISHED (to update the published report)
    report_data = task.report_data or {}
    has_human_report = bool(
        report_data.get("human_report", {}).get("content")
        or report_data.get("human_report", {}).get("s3_path")
    )

    # Allow re-publishing PUBLISHED tasks (for updating published reports from draft)
    # Allow publishing COMPLETED tasks
    # Allow publishing PENDING/FAILED tasks if they have a human report
    allowed_statuses = [GradingTaskStatus.COMPLETED, GradingTaskStatus.PUBLISHED]
    if has_human_report:
        allowed_statuses.extend([GradingTaskStatus.PENDING, GradingTaskStatus.FAILED])

    if task.status not in allowed_statuses:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can only publish completed grading tasks or tasks with a human report",
        )

    question = question_service.get(db, task.question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    report_content = request.report_content if request else None
    task = grading_service.publish(db, task, report_content)
    db.commit()

    return _convert_task_to_schema(task)


# ============================================================================
# Report Upload Endpoints
# ============================================================================


class ReportUploadRequest(BaseModel):
    """Request body for report file upload."""

    filename: str = Field(..., description="Filename of the report")
    content_type: str = Field("application/octet-stream", description="MIME type")


class ReportUploadResponse(BaseModel):
    """Response for report file upload (backend proxy mode)."""

    key: str = Field(..., description="Storage key for the file")
    filename: str = Field(..., description="Original filename")
    file_size: int = Field(..., description="File size in bytes")
    content_type: str = Field(..., description="MIME type of the file")


class ReportPublishWithAttachmentRequest(BaseModel):
    """Request body for publishing with an uploaded attachment."""

    attachment_key: str = Field(..., description="S3 key of the uploaded attachment")
    attachment_filename: str = Field(..., description="Filename of the attachment")
    attachment_size: Optional[int] = Field(None, description="File size in bytes")
    attachment_content_type: Optional[str] = Field(None, description="MIME type")


@router.post("/tasks/{task_id}/report/upload", response_model=ReportUploadResponse)
async def upload_report_file(
    task_id: int,
    file: UploadFile = File(..., description="Report file to upload"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Upload a report file through backend proxy (no S3 URL exposure).

    The task must be in COMPLETED status.
    Use this to upload a file as the final report before publishing.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    task = grading_service.get(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grading task not found",
        )

    # Allow uploading report in PENDING, FAILED, or COMPLETED status (before publishing)
    if task.status not in [
        GradingTaskStatus.PENDING,
        GradingTaskStatus.FAILED,
        GradingTaskStatus.COMPLETED,
    ]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can only upload report for tasks that are pending, failed, or completed",
        )

    # Cannot upload if already published
    if task.status == GradingTaskStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot upload report for published tasks",
        )

    question = question_service.get(db, task.question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # Read file content
    try:
        file_content = await file.read()
        file_size = len(file_content)
    except Exception as e:
        logger.error(f"[Grader] Failed to read uploaded file: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read uploaded file",
        )

    # Generate storage key
    filename = file.filename or "report"
    content_type = file.content_type or "application/octet-stream"
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    key = f"evaluation/reports/{task.respondent_id}/{question.topic_id}/{task.question_id}/{timestamp}/final_{filename}"

    # Upload to S3 via backend
    storage_service = EvalStorageService()
    uploaded_key = storage_service.upload_file(
        key=key,
        data=file_content,
        content_type=content_type,
        filename=filename,
    )

    if not uploaded_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to upload file to storage",
        )

    return ReportUploadResponse(
        key=uploaded_key,
        filename=filename,
        file_size=file_size,
        content_type=content_type,
    )


@router.post("/tasks/{task_id}/publish-with-attachment", response_model=GradingTaskInDB)
def publish_grader_task_with_attachment(
    task_id: int,
    request: ReportPublishWithAttachmentRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish a grading report with an uploaded attachment as the final report.

    Use this endpoint after uploading a file via the upload-url endpoint.
    Allows publishing COMPLETED tasks or re-publishing PUBLISHED tasks.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    task = grading_service.get(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grading task not found",
        )

    # Allow publishing COMPLETED tasks or re-publishing PUBLISHED tasks
    if task.status not in [GradingTaskStatus.COMPLETED, GradingTaskStatus.PUBLISHED]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can only publish completed or already published grading tasks",
        )

    question = question_service.get(db, task.question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # Build attachment info
    attachment = {
        "key": request.attachment_key,
        "filename": request.attachment_filename,
        "size": request.attachment_size,
        "content_type": request.attachment_content_type,
    }

    task = grading_service.publish(db, task, report_content=None, attachment=attachment)
    db.commit()

    return _convert_task_to_schema(task)


@router.get("/tasks/{task_id}/report/download")
def download_report_file(
    task_id: int,
    version: Optional[str] = Query(
        None, description="Report version: ai, human, or final"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Download a report file through backend proxy (no S3 URL exposure).

    Args:
        task_id: Grading task ID
        version: Report version to download (ai, human, final). Defaults to latest available.

    Returns:
        File content as StreamingResponse (streaming for better performance)
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    task = grading_service.get(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grading task not found",
        )

    question = question_service.get(db, task.question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    report_data = task.report_data or {}

    # Determine which S3 path to use
    s3_path = None
    filename = "report.md"
    content_type = "text/markdown"

    if version == "ai":
        s3_path = report_data.get("ai_report", {}).get("s3_path")
        filename = "ai_report.md"
    elif version == "human":
        s3_path = report_data.get("human_report", {}).get("s3_path")
        filename = "human_report.md"
    elif version == "final":
        final_report = report_data.get("final_report", {})
        s3_path = final_report.get("s3_path")
        attachment = final_report.get("attachment")
        if attachment:
            filename = attachment.get("filename", "final_report")
            content_type = attachment.get("content_type", "application/octet-stream")
        else:
            filename = "final_report.md"
    else:
        # Default: try final, then human, then ai
        if report_data.get("final_report", {}).get("s3_path"):
            s3_path = report_data["final_report"]["s3_path"]
            attachment = report_data["final_report"].get("attachment")
            if attachment:
                filename = attachment.get("filename", "final_report")
                content_type = attachment.get(
                    "content_type", "application/octet-stream"
                )
            else:
                filename = "final_report.md"
        elif report_data.get("human_report", {}).get("s3_path"):
            s3_path = report_data["human_report"]["s3_path"]
            filename = "human_report.md"
        elif report_data.get("ai_report", {}).get("s3_path"):
            s3_path = report_data["ai_report"]["s3_path"]
            filename = "ai_report.md"
        else:
            s3_path = task.report_s3_path

    if not s3_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report file not found in storage",
        )

    # Get file info and stream from S3
    storage_service = EvalStorageService()
    file_info = storage_service.get_file_info(s3_path)
    if file_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report file not found in storage",
        )

    file_stream = storage_service.get_stream(s3_path)
    if file_stream is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report file not found in storage",
        )

    # Use stored content type if available
    if (
        file_info.get("content_type")
        and file_info["content_type"] != "application/octet-stream"
    ):
        content_type = file_info["content_type"]

    # RFC 5987 encoding for non-ASCII filenames
    encoded_filename = quote(filename, safe="")
    content_disposition = (
        f'attachment; filename="{encoded_filename}"; '
        f"filename*=UTF-8''{encoded_filename}"
    )

    return StreamingResponse(
        file_stream,
        media_type=content_type,
        headers={
            "Content-Disposition": content_disposition,
            "Content-Length": str(file_info.get("size", 0)),
        },
    )


# ============================================================================
# Batch Operations
# ============================================================================


class BatchExecuteRequest(BaseModel):
    """Request body for batch execute."""

    task_ids: List[int] = Field(..., description="List of task IDs to execute")
    team_id: Optional[int] = Field(None, description="Override team ID for grading")
    model_id: Optional[str] = Field(
        None, description="Optional model ID to override bot's default model"
    )
    force_override_bot_model: bool = Field(
        False, description="Whether to force override bot's model selection"
    )


class BatchExecuteResponse(BaseModel):
    """Response for batch execute."""

    executed_count: int
    task_ids: List[int]


class BatchPublishResponse(BaseModel):
    """Response for batch publish."""

    published_count: int
    task_ids: List[int]


@router.post("/tasks/batch-execute", response_model=BatchExecuteResponse)
def batch_execute_grader_tasks(
    request: BatchExecuteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Execute multiple grading tasks in batch.

    Only tasks in PENDING or FAILED status will be executed.
    Requires grader permission for each task's associated topic.
    """
    grading_service = get_grading_service()
    permission_service = get_permission_service()
    topic_service = get_topic_service()
    question_service = get_question_service()

    executed_ids = []

    for task_id in request.task_ids:
        task = grading_service.get(db, task_id)
        if not task:
            continue

        if task.status not in (GradingTaskStatus.PENDING, GradingTaskStatus.FAILED):
            continue

        # Check permission
        question = question_service.get(db, task.question_id)
        if not question:
            continue

        topic = topic_service.get(db, question.topic_id)
        if not topic:
            continue

        if not permission_service.can_grade(db, topic, current_user.id):
            continue

        # Get team ID
        team_id = request.team_id
        if not team_id and topic.grading_team_config:
            team_id = topic.grading_team_config.get("team_id")

        if not team_id:
            continue

        try:
            grading_service.execute(
                db,
                task,
                team_id,
                current_user.id,
                model_id=request.model_id,
                force_override_bot_model=request.force_override_bot_model,
            )
            executed_ids.append(task_id)
        except Exception as e:
            logger.warning(f"Failed to execute task {task_id}: {e}")
            continue

    db.commit()

    return BatchExecuteResponse(
        executed_count=len(executed_ids),
        task_ids=executed_ids,
    )


@router.post("/tasks/batch-publish", response_model=BatchPublishResponse)
def batch_publish_grader_tasks(
    task_ids: List[int],
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish multiple grading reports in batch.

    Only tasks in COMPLETED status will be published.
    Requires grader permission for each task's associated topic.
    """
    grading_service = get_grading_service()
    permission_service = get_permission_service()
    topic_service = get_topic_service()
    question_service = get_question_service()

    published_ids = []

    for task_id in task_ids:
        task = grading_service.get(db, task_id)
        if not task:
            continue

        if task.status != GradingTaskStatus.COMPLETED:
            continue

        # Check permission
        question = question_service.get(db, task.question_id)
        if not question:
            continue

        topic = topic_service.get(db, question.topic_id)
        if not topic:
            continue

        if not permission_service.can_grade(db, topic, current_user.id):
            continue

        try:
            grading_service.publish(db, task, None)
            published_ids.append(task_id)
        except Exception as e:
            logger.warning(f"Failed to publish task {task_id}: {e}")
            continue

    db.commit()

    return BatchPublishResponse(
        published_count=len(published_ids),
        task_ids=published_ids,
    )


# ============================================================================
# Answers Endpoints
# ============================================================================


@router.get("/answers", response_model=AnswerWithGradingListResponse)
def list_grader_answers(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    topic_id: Optional[int] = Query(None, description="Filter by topic"),
    question_id: Optional[int] = Query(None, description="Filter by question"),
    respondent_id: Optional[int] = Query(None, description="Filter by respondent"),
    latest_only: bool = Query(True, description="Only show latest answers"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List all answers accessible to the grader.

    Supports filtering by topic, question, and respondent.
    """
    permission_service = get_permission_service()
    topic_service = get_topic_service()
    grading_service = get_grading_service()

    # If topic_id specified, verify grader permission
    if topic_id:
        topic = topic_service.get(db, topic_id)
        if not topic:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Topic not found",
            )
        _check_grader_permission(db, topic, current_user.id, permission_service)
        topic_ids = [topic_id]
    else:
        # Get all topics with grader access
        topic_ids = _get_topic_ids_with_grader_access(
            db, current_user.id, permission_service
        )

    if not topic_ids:
        return AnswerWithGradingListResponse(total=0, items=[])

    # Build base query
    if question_id:
        # Verify question belongs to accessible topic
        question = db.query(EvalQuestion).filter(EvalQuestion.id == question_id).first()
        if not question or question.topic_id not in topic_ids:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Question not found or not accessible",
            )
        query = db.query(EvalAnswer).filter(EvalAnswer.question_id == question_id)
    else:
        # Get question IDs for these topics - use scalar_subquery for IN clause
        question_ids_query = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id.in_(topic_ids),
                EvalQuestion.is_active,
            )
            .scalar_subquery()
        )
        query = db.query(EvalAnswer).filter(
            EvalAnswer.question_id.in_(question_ids_query)
        )

    if respondent_id is not None:
        query = query.filter(EvalAnswer.respondent_id == respondent_id)

    if latest_only:
        query = query.filter(EvalAnswer.is_latest)

    total = query.count()
    answers = (
        query.order_by(EvalAnswer.submitted_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    # Enrich answers with grading info
    items = []
    for answer in answers:
        # Get grading task
        grading_task = grading_service.get_by_answer(db, answer.id)

        # Get question info
        question = (
            db.query(EvalQuestion).filter(EvalQuestion.id == answer.question_id).first()
        )

        # Get topic info
        topic = None
        if question:
            topic = (
                db.query(EvalTopic).filter(EvalTopic.id == question.topic_id).first()
            )

        item = AnswerWithGradingInfo(
            id=answer.id,
            question_id=answer.question_id,
            question_version=answer.question_version,
            respondent_id=answer.respondent_id,
            content_type=answer.content_type,
            content_data=answer.content_data,
            submitted_at=answer.submitted_at,
            is_latest=answer.is_latest,
            grading_task=(
                _convert_task_to_schema(grading_task) if grading_task else None
            ),
            question_title=question.title if question else None,
            topic_id=topic.id if topic else None,
            topic_name=topic.name if topic else None,
        )
        items.append(item)

    return AnswerWithGradingListResponse(total=total, items=items)


@router.get("/answers/{answer_id}", response_model=AnswerWithGradingInfo)
def get_grader_answer(
    answer_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get answer detail with associated grading task.

    Requires grader permission for the topic.
    """
    answer_service = get_answer_service()
    topic_service = get_topic_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    answer = answer_service.get(db, answer_id)
    if not answer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Answer not found",
        )

    question = (
        db.query(EvalQuestion).filter(EvalQuestion.id == answer.question_id).first()
    )
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # Get grading task
    grading_task = grading_service.get_by_answer(db, answer.id)

    # Get respondent name
    respondent = db.query(User).filter(User.id == answer.respondent_id).first()
    respondent_name = respondent.user_name if respondent else None

    return AnswerWithGradingInfo(
        id=answer.id,
        question_id=answer.question_id,
        question_version=answer.question_version,
        respondent_id=answer.respondent_id,
        respondent_name=respondent_name,
        content_type=answer.content_type,
        content_data=answer.content_data,
        submitted_at=answer.submitted_at,
        is_latest=answer.is_latest,
        grading_task=_convert_task_to_schema(grading_task) if grading_task else None,
        question_title=question.title,
        topic_id=topic.id,
        topic_name=topic.name,
    )


@router.get("/questions/{question_id}", response_model=QuestionInDB)
def get_grader_question(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get question detail for grading.

    Requires grader permission for the topic.
    Returns question content and criteria for grading purposes.
    """
    question_service = get_question_service()
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    question = question_service.get(db, question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # For graders, include criteria data from content_data["_criteria"]
    # Structure: {"type": "text", "data": {"text": "...", "url": "...", "attachments": [...]}}
    criteria = (question.content_data or {}).get("_criteria", {})
    criteria_type = criteria.get("type")
    # Get the actual criteria data from the "data" field
    criteria_data = criteria.get("data", {}) if criteria else {}

    # Get content data without criteria
    content_data = {
        k: v for k, v in (question.content_data or {}).items() if k != "_criteria"
    }

    return QuestionInDB(
        id=question.id,
        topic_id=question.topic_id,
        title=question.title,
        content_type=question.content_type,
        content_data=content_data,
        order_index=question.order_index,
        status=question.status,
        current_version=question.current_version,
        creator_id=question.creator_id,
        created_at=question.created_at,
        updated_at=question.updated_at,
        criteria_type=criteria_type,
        criteria_data=criteria_data,
    )


@router.get("/topics/{topic_id}/answers", response_model=AnswerWithGradingListResponse)
def list_topic_answers_for_grader(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    question_id: Optional[int] = Query(None, description="Filter by question"),
    respondent_id: Optional[int] = Query(None, description="Filter by respondent"),
    latest_only: bool = Query(True, description="Only show latest answers"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List answers for a specific topic.

    Requires grader permission for the topic.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()
    grading_service = get_grading_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    # Build query
    if question_id:
        # Verify question belongs to this topic
        question = db.query(EvalQuestion).filter(EvalQuestion.id == question_id).first()
        if not question or question.topic_id != topic_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Question not found in this topic",
            )
        query = db.query(EvalAnswer).filter(EvalAnswer.question_id == question_id)
    else:
        # Get question IDs for this topic - use scalar_subquery for IN clause
        question_ids_query = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active,
            )
            .scalar_subquery()
        )
        query = db.query(EvalAnswer).filter(
            EvalAnswer.question_id.in_(question_ids_query)
        )

    if respondent_id is not None:
        query = query.filter(EvalAnswer.respondent_id == respondent_id)

    if latest_only:
        query = query.filter(EvalAnswer.is_latest)

    total = query.count()
    answers = (
        query.order_by(EvalAnswer.submitted_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    # Enrich answers with grading info
    items = []
    for answer in answers:
        # Get grading task
        grading_task = grading_service.get_by_answer(db, answer.id)

        # Get question info
        question = (
            db.query(EvalQuestion).filter(EvalQuestion.id == answer.question_id).first()
        )

        item = AnswerWithGradingInfo(
            id=answer.id,
            question_id=answer.question_id,
            question_version=answer.question_version,
            respondent_id=answer.respondent_id,
            content_type=answer.content_type,
            content_data=answer.content_data,
            submitted_at=answer.submitted_at,
            is_latest=answer.is_latest,
            grading_task=(
                _convert_task_to_schema(grading_task) if grading_task else None
            ),
            question_title=question.title if question else None,
            topic_id=topic.id,
            topic_name=topic.name,
        )
        items.append(item)

    return AnswerWithGradingListResponse(total=total, items=items)


# ============================================================================
# Reports Endpoints
# ============================================================================


@router.get("/reports", response_model=ReportListResponse)
def list_grader_reports(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    topic_id: Optional[int] = Query(None, description="Filter by topic"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List published reports accessible to the grader.

    Only includes reports with PUBLISHED status.
    """
    permission_service = get_permission_service()
    topic_service = get_topic_service()

    # If topic_id specified, verify grader permission
    if topic_id:
        topic = topic_service.get(db, topic_id)
        if not topic:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Topic not found",
            )
        _check_grader_permission(db, topic, current_user.id, permission_service)
        topic_ids = [topic_id]
    else:
        # Get all topics with grader access
        topic_ids = _get_topic_ids_with_grader_access(
            db, current_user.id, permission_service
        )

    if not topic_ids:
        return ReportListResponse(total=0, items=[])

    # Get question IDs for these topics - use scalar_subquery for IN clause
    question_ids_query = (
        db.query(EvalQuestion.id)
        .filter(
            EvalQuestion.topic_id.in_(topic_ids),
            EvalQuestion.is_active,
        )
        .scalar_subquery()
    )

    # Query published reports
    query = db.query(EvalGradingTask).filter(
        EvalGradingTask.question_id.in_(question_ids_query),
        EvalGradingTask.status == GradingTaskStatus.PUBLISHED,
    )

    total = query.count()
    tasks = (
        query.order_by(EvalGradingTask.published_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    # Convert to response
    items = []
    for task in tasks:
        # Get question info
        question = (
            db.query(EvalQuestion).filter(EvalQuestion.id == task.question_id).first()
        )

        # Get topic info
        topic = None
        if question:
            topic = (
                db.query(EvalTopic).filter(EvalTopic.id == question.topic_id).first()
            )

        item = ReportInDB(
            id=task.id,
            answer_id=task.answer_id,
            question_id=task.question_id,
            question_version=task.question_version,
            respondent_id=task.respondent_id,
            grader_id=task.grader_id,
            report_data=task.report_data or {},
            report_s3_path=task.report_s3_path,
            published_at=task.published_at.isoformat() if task.published_at else None,
            question_title=question.title if question else None,
            topic_id=topic.id if topic else None,
            topic_name=topic.name if topic else None,
        )
        items.append(item)

    return ReportListResponse(total=total, items=items)


@router.get("/reports/{report_id}", response_model=ReportInDB)
def get_grader_report(
    report_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get published report detail.

    Requires grader permission for the topic.
    """
    topic_service = get_topic_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    task = grading_service.get(db, report_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )

    if task.status != GradingTaskStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not published",
        )

    question = (
        db.query(EvalQuestion).filter(EvalQuestion.id == task.question_id).first()
    )
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    _check_grader_permission(db, topic, current_user.id, permission_service)

    return ReportInDB(
        id=task.id,
        answer_id=task.answer_id,
        question_id=task.question_id,
        question_version=task.question_version,
        respondent_id=task.respondent_id,
        grader_id=task.grader_id,
        report_data=task.report_data or {},
        report_s3_path=task.report_s3_path,
        published_at=task.published_at.isoformat() if task.published_at else None,
        question_title=question.title,
        topic_id=topic.id,
        topic_name=topic.name,
    )
