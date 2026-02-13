# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Respondent API endpoints.

This module provides endpoints for the respondent role (答题人):
- View available topics (public + permitted private)
- View questions (without grading criteria)
- Submit answers
- View answer history
- View published grading reports
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.models.evaluation import (
    GradingTaskStatus,
    QuestionStatus,
    TopicStatus,
    TopicVisibility,
)
from wecode.schemas.evaluation import (
    AnswerCreate,
    AnswerInDB,
    AnswerListResponse,
    GradingTaskInDB,
    GradingTaskListResponse,
    QuestionInDB,
    QuestionListResponse,
    TopicInDB,
    TopicListResponse,
)
from wecode.service.evaluation import (
    get_answer_service,
    get_grading_service,
    get_permission_service,
    get_question_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ============================================================================
# Topic Endpoints
# ============================================================================


@router.get("/topics", response_model=TopicListResponse)
def list_available_topics(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    search: Optional[str] = Query(None, description="Search by name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List topics available to the current respondent.

    Shows:
    - All published public topics
    - Private topics where user has 'respondent' permission
    """
    topic_service = get_topic_service()

    # Use the existing list_topics method which handles access control
    # It returns topics the user can access (public + permitted)
    topics, total = topic_service.list_topics(
        db=db,
        user_id=current_user.id,
        page=page,
        limit=limit,
        status=TopicStatus.PUBLISHED,  # Only published topics for respondents
        search=search,
        my_only=False,
    )

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
            "grading_team_config": {},  # Hide grading config from respondents
            "created_at": topic.created_at,
            "updated_at": topic.updated_at,
            "is_active": topic.is_active,
            "description": (topic.extra_data or {}).get("description"),
        }
        items.append(TopicInDB(**topic_dict))

    return TopicListResponse(total=total, items=items)


@router.get("/topics/{topic_id}", response_model=TopicInDB)
def get_topic_detail(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get topic detail for respondent view.

    Hides grading team configuration from respondents.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Check if respondent can view this topic
    if not permission_service.can_view_topic(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to view this topic",
        )

    # For respondents, only show published topics unless they're the creator
    if topic.status != TopicStatus.PUBLISHED and topic.creator_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This topic is not yet available",
        )

    return TopicInDB(
        id=topic.id,
        name=topic.name,
        creator_id=topic.creator_id,
        visibility=topic.visibility,
        status=topic.status,
        current_version=topic.current_version,
        extra_data=topic.extra_data or {},
        grading_team_config={},  # Hide grading config from respondents
        created_at=topic.created_at,
        updated_at=topic.updated_at,
        is_active=topic.is_active,
        description=(topic.extra_data or {}).get("description"),
    )


@router.get("/topics/{topic_id}/questions", response_model=QuestionListResponse)
def list_topic_questions(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List published questions for a topic.

    Only shows published questions and hides grading criteria from respondents.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
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

    # Respondents can only see published questions
    questions, total = question_service.list_questions(
        db=db,
        topic_id=topic_id,
        page=page,
        limit=limit,
        status=QuestionStatus.PUBLISHED,
        include_criteria=False,  # Never include criteria for respondents
    )

    items = []
    for q in questions:
        # Remove criteria from content_data if present
        content_data = {
            k: v for k, v in (q.content_data or {}).items() if k != "_criteria"
        }
        q_dict = {
            "id": q.id,
            "topic_id": q.topic_id,
            "title": q.title,
            "content_type": q.content_type,
            "content_data": content_data,
            "status": q.status,
            "current_version": q.current_version,
            "order_index": q.order_index,
            "creator_id": q.creator_id,
            "created_at": q.created_at,
            "updated_at": q.updated_at,
            "is_active": q.is_active,
            # Explicitly exclude criteria_data for respondents
        }
        items.append(QuestionInDB(**q_dict))

    return QuestionListResponse(total=total, items=items)


# ============================================================================
# Question Endpoints
# ============================================================================


@router.get("/questions/{question_id}", response_model=QuestionInDB)
def get_question_detail(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get question detail for respondent view.

    Shows question content but hides grading criteria.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
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

    if not permission_service.can_view_topic(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to view this question",
        )

    # Respondents can only see published questions
    if question.status != QuestionStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This question is not yet available",
        )

    # Remove criteria from content_data
    content_data = {
        k: v for k, v in (question.content_data or {}).items() if k != "_criteria"
    }

    return QuestionInDB(
        id=question.id,
        topic_id=question.topic_id,
        title=question.title,
        content_type=question.content_type,
        content_data=content_data,
        status=question.status,
        current_version=question.current_version,
        order_index=question.order_index,
        creator_id=question.creator_id,
        created_at=question.created_at,
        updated_at=question.updated_at,
        is_active=question.is_active,
        # Explicitly exclude criteria_data for respondents
    )


# ============================================================================
# Answer Endpoints
# ============================================================================


@router.post(
    "/questions/{question_id}/answers",
    response_model=AnswerInDB,
    status_code=status.HTTP_201_CREATED,
)
def submit_answer(
    question_id: int,
    answer_create: AnswerCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Submit an answer to a question.

    Requires:
    - Question must be published
    - User must have answer permission (for private topics)
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    answer_service = get_answer_service()
    permission_service = get_permission_service()

    question = question_service.get(db, question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    if question.status != QuestionStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot submit answer to unpublished question",
        )

    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_answer(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to answer this question",
        )

    # Build content data
    content_data = answer_create.content_data or {}
    if answer_create.content_text:
        content_data["text"] = answer_create.content_text

    answer = answer_service.submit(
        db=db,
        question_id=question_id,
        user_id=current_user.id,
        content_type=answer_create.content_type,
        content_data=content_data,
        auto_create_grading=True,
    )
    db.commit()

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


@router.get("/history", response_model=AnswerListResponse)
def list_my_answer_history(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    topic_id: Optional[int] = Query(None, description="Filter by topic"),
    question_id: Optional[int] = Query(None, description="Filter by question"),
    latest_only: bool = Query(True, description="Only show latest answers"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List current user's answer history across all topics.
    """
    answer_service = get_answer_service()
    from wecode.models.evaluation import EvalAnswer

    query = db.query(EvalAnswer).filter(EvalAnswer.respondent_id == current_user.id)

    if topic_id:
        # Get all questions for the topic and filter by question IDs
        question_service = get_question_service()
        questions, _ = question_service.list_questions(
            db=db, topic_id=topic_id, page=1, limit=1000
        )
        question_ids = [q.id for q in questions]
        if question_ids:
            query = query.filter(EvalAnswer.question_id.in_(question_ids))
        else:
            # No questions in topic, return empty
            return AnswerListResponse(total=0, items=[])

    if question_id:
        query = query.filter(EvalAnswer.question_id == question_id)

    if latest_only:
        query = query.filter(EvalAnswer.is_latest == True)

    total = query.count()
    answers = (
        query.order_by(EvalAnswer.submitted_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    items = []
    for answer in answers:
        items.append(
            AnswerInDB(
                id=answer.id,
                question_id=answer.question_id,
                question_version=answer.question_version,
                respondent_id=answer.respondent_id,
                content_type=answer.content_type,
                content_data=answer.content_data,
                submitted_at=answer.submitted_at,
                is_latest=answer.is_latest,
            )
        )

    return AnswerListResponse(total=total, items=items)


@router.get("/answers/{answer_id}", response_model=AnswerInDB)
def get_answer_detail(
    answer_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get answer detail.

    Respondents can only view their own answers.
    """
    answer_service = get_answer_service()

    answer = answer_service.get(db, answer_id)
    if not answer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Answer not found",
        )

    # Respondents can only view their own answers
    if answer.respondent_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only view your own answers",
        )

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
# Grading Report Endpoints
# ============================================================================


@router.get("/reports", response_model=GradingTaskListResponse)
def list_my_grading_reports(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    topic_id: Optional[int] = Query(None, description="Filter by topic"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List current user's grading reports (published only).

    Respondents can only see reports that have been published by graders.
    """
    grading_service = get_grading_service()

    # Only show PUBLISHED reports for respondents
    tasks, total = grading_service.list_by_respondent(
        db=db,
        respondent_id=current_user.id,
        topic_id=topic_id,
        status=GradingTaskStatus.PUBLISHED,
        page=page,
        limit=limit,
    )

    items = []
    for task in tasks:
        items.append(
            GradingTaskInDB(
                id=task.id,
                answer_id=task.answer_id,
                question_id=task.question_id,
                question_version=task.question_version,
                respondent_id=task.respondent_id,
                grader_id=task.grader_id,
                team_id=task.team_id,
                task_id=task.task_id,
                status=task.status,
                report_data=task.report_data or {},
                report_s3_path=task.report_s3_path,
                created_at=task.created_at,
                started_at=task.started_at,
                completed_at=task.completed_at,
                published_at=task.published_at,
            )
        )

    return GradingTaskListResponse(total=total, items=items)


@router.get("/reports/{report_id}", response_model=GradingTaskInDB)
def get_grading_report_detail(
    report_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get grading report detail.

    Respondents can only view their own published reports.
    """
    grading_service = get_grading_service()

    task = grading_service.get(db, report_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grading report not found",
        )

    # Respondents can only view their own reports
    if task.respondent_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only view your own grading reports",
        )

    # Respondents can only view published reports
    if task.status != GradingTaskStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This report has not been published yet",
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
        report_data=task.report_data or {},
        report_s3_path=task.report_s3_path,
        created_at=task.created_at,
        started_at=task.started_at,
        completed_at=task.completed_at,
        published_at=task.published_at,
    )
