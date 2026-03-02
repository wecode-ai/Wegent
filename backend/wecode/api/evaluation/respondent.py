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

NOTE: Respondents CANNOT view any grading status or results.
This is a business security requirement to ensure evaluation fairness.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.exceptions import BusinessException
from wecode.models.evaluation import (
    EvalAnswer,
    EvalGradingTask,
    GradingTaskStatus,
    QuestionStatus,
    TopicStatus,
)
from wecode.schemas.evaluation import (
    AnswerCreate,
    AnswerInDB,
    AnswerListResponse,
    QuestionInDB,
    QuestionListResponse,
    RespondentProgress,
    TopicInDB,
    TopicListResponse,
)
from wecode.service.evaluation import (
    get_answer_service,
    get_exam_session_service,
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
    question_service = get_question_service()

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
        # Get published question count for each topic
        _, published_count = question_service.list_questions(
            db=db,
            topic_id=topic.id,
            page=1,
            limit=1,
            status=QuestionStatus.PUBLISHED,
        )

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
            "question_count": published_count,
            "published_question_count": published_count,
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
    question_service = get_question_service()
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

    # Get published question count
    _, published_count = question_service.list_questions(
        db=db,
        topic_id=topic_id,
        page=1,
        limit=1,
        status=QuestionStatus.PUBLISHED,
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
        question_count=published_count,
        published_question_count=published_count,
    )


@router.get("/topics/{topic_id}/progress", response_model=RespondentProgress)
def get_my_progress(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get current user's progress for a topic.

    Returns:
    - Total questions in the topic
    - Number of questions answered by user
    - Completion rate (0-1)

    NOTE: Does NOT return any grading-related information.
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

    # Get total published questions
    questions, total_questions = question_service.list_questions(
        db=db,
        topic_id=topic_id,
        page=1,
        limit=1000,  # Get all questions
        status=QuestionStatus.PUBLISHED,
    )
    question_ids = [q.id for q in questions]

    # Count answered questions
    from wecode.models.evaluation import EvalAnswer

    answered_count = 0
    if question_ids:
        answered_count = (
            db.query(EvalAnswer.question_id)
            .filter(
                EvalAnswer.question_id.in_(question_ids),
                EvalAnswer.respondent_id == current_user.id,
                EvalAnswer.is_latest,
            )
            .distinct()
            .count()
        )

    # Calculate completion rate
    completion_rate = answered_count / total_questions if total_questions > 0 else 0.0

    # NOTE: published_reports is always 0 for respondents
    # Respondents cannot see any grading information
    return RespondentProgress(
        total_questions=total_questions,
        answered_questions=answered_count,
        published_reports=0,  # Always 0 - respondents cannot see grading info
        completion_rate=completion_rate,
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

    # Check if there's a newer version since user's last answer
    has_new_version = False
    from wecode.models.evaluation import EvalAnswer

    latest_answer = (
        db.query(EvalAnswer)
        .filter(
            EvalAnswer.question_id == question_id,
            EvalAnswer.respondent_id == current_user.id,
            EvalAnswer.is_latest,
        )
        .first()
    )
    if latest_answer:
        # If user has answered and the question version is different
        if latest_answer.question_version != question.current_version:
            has_new_version = True

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
        has_new_version=has_new_version,
        latest_version=question.current_version,
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
    get_answer_service()
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
        query = query.filter(EvalAnswer.is_latest)

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


# NOTE: Grading Report Endpoints have been REMOVED for respondents.
# Respondents cannot view any grading status or results.
# This is a business security requirement to ensure evaluation fairness.
# Grading reports are only visible to Authors and Graders.


# ============================================================================
# Exam Endpoints
# ============================================================================


@router.get("/topics/{topic_id}/exam")
def get_exam_data(
    topic_id: int,
    create_session: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get exam data for a topic.

    Returns topic with extra_data, all questions with content_data,
    any existing answer from the current user, and exam session status.

    Only works for topics with examMode enabled in extra_data.

    Args:
        create_session: If True, creates a new exam session (for "进入考试" action).
                       If False, returns existing session or "ready" state.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    permission_service = get_permission_service()
    answer_service = get_answer_service()
    exam_session_service = get_exam_session_service()

    # Get topic
    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Check permission
    if not permission_service.can_view_topic(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to view this topic",
        )

    # Check if topic is published
    if topic.status != TopicStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This topic is not yet available",
        )

    # Check if topic has examMode enabled
    extra_data = topic.extra_data or {}
    if not extra_data.get("examMode"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This topic is not configured for exam mode",
        )

    # Get all published questions for the topic
    questions, _ = question_service.list_questions(
        db=db,
        topic_id=topic_id,
        page=1,
        limit=1000,  # Get all questions
        status=QuestionStatus.PUBLISHED,
        include_criteria=False,  # Never include criteria for respondents
    )

    # Format questions (remove criteria from content_data)
    formatted_questions = []
    for q in questions:
        content_data = {
            k: v for k, v in (q.content_data or {}).items() if k != "_criteria"
        }
        formatted_questions.append(
            {
                "id": q.id,
                "topic_id": q.topic_id,
                "title": q.title,
                "content_type": q.content_type,
                "content_data": content_data,
                "status": q.status,
                "current_version": q.current_version,
                "order_index": q.order_index,
                "creator_id": q.creator_id,
                "created_at": q.created_at.isoformat() if q.created_at else None,
                "updated_at": q.updated_at.isoformat() if q.updated_at else None,
                "is_active": q.is_active,
            }
        )

    # Sort questions by order_index
    formatted_questions.sort(key=lambda x: x["order_index"])

    # Check for existing answer from current user
    # For exam mode, we store the answer at topic level (question_id will be the first question or 0)
    existing_answer = None
    if formatted_questions:

        first_question_id = formatted_questions[0]["id"]
        answer = answer_service.get_latest_answer(
            db=db,
            question_id=first_question_id,
            respondent_id=current_user.id,
        )
        if answer:
            existing_answer = {
                "id": answer.id,
                "question_id": answer.question_id,
                "question_version": answer.question_version,
                "respondent_id": answer.respondent_id,
                "content_type": answer.content_type,
                "content_data": answer.content_data,
                "submitted_at": (
                    answer.submitted_at.isoformat() if answer.submitted_at else None
                ),
                "is_latest": answer.is_latest,
            }

    # Get or create exam session (three-phase: intro, exam, review)
    duration = extra_data.get("duration", {})
    intro_duration = duration.get("intro", 5)
    exam_duration = duration.get("exam", 50)
    review_duration = duration.get("review", 5)

    if create_session:
        # Create session explicitly (user clicked "进入考试")
        session = exam_session_service.get_or_create_session(
            db=db,
            topic_id=topic_id,
            user_id=current_user.id,
            intro_duration=intro_duration,
            exam_duration=exam_duration,
            review_duration=review_duration,
        )
        session_status = exam_session_service.get_session_status(session)
    else:
        # Check for existing session only
        session = exam_session_service.get_active_session(
            db=db, topic_id=topic_id, user_id=current_user.id
        )
        if session:
            session_status = exam_session_service.get_session_status(session)
        else:
            # Return "ready" state - no session yet
            session_status = {
                "phase": "ready",
                "started_at": None,
                "intro_end_at": None,
                "exam_end_at": None,
                "review_end_at": None,
                "remaining_seconds": 0,
                "is_overtime": False,
                "submit_count": 0,
                "selected_question_id": None,
            }

    # Format topic
    formatted_topic = {
        "id": topic.id,
        "name": topic.name,
        "creator_id": topic.creator_id,
        "visibility": topic.visibility,
        "status": topic.status,
        "current_version": topic.current_version,
        "extra_data": extra_data,
        "created_at": topic.created_at.isoformat() if topic.created_at else None,
        "updated_at": topic.updated_at.isoformat() if topic.updated_at else None,
        "is_active": topic.is_active,
    }

    return {
        "topic": formatted_topic,
        "questions": formatted_questions,
        "userAnswer": existing_answer,
        "session": session_status,
    }


class ExamSubmitRequest(BaseModel):
    """Schema for exam submission request."""

    selectedQuestionId: int = Field(..., description="The selected question ID")
    participantName: str = Field(..., description="Name of the participant")
    content_data: Dict[str, Any] = Field(
        ...,
        description="Exam content data including examMode, attachments, etc.",
    )


@router.post("/topics/{topic_id}/exam/submit")
def submit_exam(
    topic_id: int,
    request: ExamSubmitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Submit an exam answer for a topic (multiple submissions allowed).

    Creates or updates an answer with content_type='mixed' containing exam-specific data.
    The answer is associated with the selected question.
    Records submission in exam session for tracking.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    answer_service = get_answer_service()
    permission_service = get_permission_service()
    exam_session_service = get_exam_session_service()

    # Get topic
    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Check permission
    if not permission_service.can_answer(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to submit answers for this topic",
        )

    # Check if topic is published
    if topic.status != TopicStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot submit answer to unpublished topic",
        )

    # Check if topic has examMode enabled
    extra_data = topic.extra_data or {}
    if not extra_data.get("examMode"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This topic is not configured for exam mode",
        )

    # Get session and validate timing
    session = exam_session_service.get_or_create_session(
        db=db, topic_id=topic_id, user_id=current_user.id
    )

    # Validate submission is allowed (time not expired)
    try:
        exam_session_service.validate_submission_allowed(session)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    # Verify the selected question exists and belongs to this topic
    question = question_service.get(db, request.selectedQuestionId)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    if question.topic_id != topic_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Selected question does not belong to this topic",
        )

    if question.status != QuestionStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot submit answer to unpublished question",
        )

    # Build content data for exam submission
    content_data = {
        **request.content_data,
        "examMode": True,
        "participantName": request.participantName,
        "selectedTopicId": topic_id,
    }

    # Include supplementaryNotesFiles if supplementaryNotes is provided
    if request.content_data.get("supplementaryNotes"):
        content_data["supplementaryNotes"] = request.content_data["supplementaryNotes"]

    # Check for existing answer to allow multiple submissions
    existing_answer = answer_service.get_latest_answer(
        db=db,
        question_id=request.selectedQuestionId,
        respondent_id=current_user.id,
    )

    if existing_answer:
        # Update existing answer (merge content data)
        existing_content = existing_answer.content_data or {}
        updated_content = {**existing_content, **content_data}
        existing_answer.content_data = updated_content
        existing_answer.submitted_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing_answer)
        answer = existing_answer
    else:
        # Submit new answer - don't create grading task yet
        # Grading task will be created when user ends the exam (phase -> completed)
        answer = answer_service.submit(
            db=db,
            question_id=request.selectedQuestionId,
            user_id=current_user.id,
            content_type="mixed",
            content_data=content_data,
            auto_create_grading=False,
        )
        db.commit()

    # Record submission in session
    exam_session_service.record_submission(db, session)

    return {
        "id": answer.id,
        "question_id": answer.question_id,
        "question_version": answer.question_version,
        "respondent_id": answer.respondent_id,
        "content_type": answer.content_type,
        "content_data": answer.content_data,
        "submitted_at": (
            answer.submitted_at.isoformat() if answer.submitted_at else None
        ),
        "is_latest": answer.is_latest,
        "submit_count": session.submit_count,
    }


class SelectQuestionRequest(BaseModel):
    """Schema for selecting a question in exam mode."""

    question_id: int = Field(..., description="The selected question ID")


@router.post("/topics/{topic_id}/exam/select-question")
def select_exam_question(
    topic_id: int,
    request: SelectQuestionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Record selected question for exam session.

    This allows tracking which question the user has chosen to answer.
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    permission_service = get_permission_service()
    exam_session_service = get_exam_session_service()

    # Get topic
    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Check permission
    if not permission_service.can_answer(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to answer this topic",
        )

    # Check if topic has examMode enabled
    extra_data = topic.extra_data or {}
    if not extra_data.get("examMode"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This topic is not configured for exam mode",
        )

    # Verify the question exists and belongs to this topic
    question = question_service.get(db, request.question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    if question.topic_id != topic_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Selected question does not belong to this topic",
        )

    # Get or create session and record question selection
    session = exam_session_service.get_or_create_session(
        db=db, topic_id=topic_id, user_id=current_user.id
    )
    exam_session_service.select_question(db, session, request.question_id)

    return {"success": True, "selected_question_id": request.question_id}


class ExamAttachmentsUpdateRequest(BaseModel):
    """Schema for updating exam attachments metadata."""

    selectedQuestionId: int = Field(..., description="The selected question ID")
    content_data: Dict[str, Any] = Field(
        ...,
        description="Partial content data with attachments to update",
    )


@router.patch("/topics/{topic_id}/exam/attachments")
def update_exam_attachments(
    topic_id: int,
    request: ExamAttachmentsUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update exam attachments metadata in real-time.

    This endpoint allows incremental updates to exam answer attachments
    without creating a new submission. Used for:
    - Adding/removing file attachments after upload
    - Updating supplementary notes file reference

    The answer must already exist (created by initial submit).
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    answer_service = get_answer_service()
    permission_service = get_permission_service()

    # Get topic
    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Check permission
    if not permission_service.can_answer(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to update answers for this topic",
        )

    # Check if topic has examMode enabled
    extra_data = topic.extra_data or {}
    if not extra_data.get("examMode"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This topic is not configured for exam mode",
        )

    # Verify the selected question exists and belongs to this topic
    question = question_service.get(db, request.selectedQuestionId)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    if question.topic_id != topic_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Selected question does not belong to this topic",
        )

    # Find existing answer
    existing_answer = answer_service.get_latest_answer(
        db=db,
        question_id=request.selectedQuestionId,
        respondent_id=current_user.id,
    )

    if not existing_answer:
        # Create initial answer if not exists
        content_data = {
            **request.content_data,
            "examMode": True,
            "selectedTopicId": request.selectedQuestionId,
        }
        answer = answer_service.submit(
            db=db,
            question_id=request.selectedQuestionId,
            user_id=current_user.id,
            content_type="mixed",
            content_data=content_data,
            auto_create_grading=False,
        )
        # Commit the transaction to persist the new answer
        db.commit()
        db.refresh(answer)
    else:
        # Merge existing content_data with new data
        existing_content = existing_answer.content_data or {}
        new_content = request.content_data or {}

        # Deep merge attachments if both exist
        if "attachments" in existing_content and "attachments" in new_content:
            merged_attachments = {
                **existing_content["attachments"],
                **new_content["attachments"],
            }
            new_content["attachments"] = merged_attachments

        # Handle supplementaryNotesFiles - use new value if provided, otherwise keep existing
        if "supplementaryNotesFiles" in new_content:
            # Use the new value (for delete operations)
            pass
        elif "supplementaryNotesFiles" in existing_content:
            # Keep existing value if not in new content
            new_content["supplementaryNotesFiles"] = existing_content[
                "supplementaryNotesFiles"
            ]

        # Handle supplementaryNotes text - preserve if not in new content
        if (
            "supplementaryNotes" not in new_content
            and "supplementaryNotes" in existing_content
        ):
            new_content["supplementaryNotes"] = existing_content["supplementaryNotes"]

        # Update content_data
        updated_content = {**existing_content, **new_content}
        existing_answer.content_data = updated_content
        db.commit()
        db.refresh(existing_answer)
        answer = existing_answer

    return {
        "id": answer.id,
        "question_id": answer.question_id,
        "question_version": answer.question_version,
        "respondent_id": answer.respondent_id,
        "content_type": answer.content_type,
        "content_data": answer.content_data,
        "submitted_at": (
            answer.submitted_at.isoformat() if answer.submitted_at else None
        ),
        "is_latest": answer.is_latest,
    }


class AdvancePhaseRequest(BaseModel):
    """Schema for advancing exam phase."""

    target_phase: str = Field(
        ..., description="Target phase to advance to (exam, review, completed)"
    )


@router.post("/topics/{topic_id}/exam/advance-phase")
def advance_exam_phase(
    topic_id: int,
    request: AdvancePhaseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Manually advance exam to the next phase.

    Phase transitions:
    - intro -> exam: User clicks "Start Exam" button
    - exam -> review: User clicks "End Exam" button or time expires
    - review -> completed: User clicks "Finish Exam" button or time expires

    This allows explicit user control over phase transitions rather than
    automatic time-based transitions.
    """
    exam_session_service = get_exam_session_service()
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    # Get topic
    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Check permission
    if not permission_service.can_answer(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to participate in this exam",
        )

    # Get current session
    session = exam_session_service.get_or_create_session(
        db=db, topic_id=topic_id, user_id=current_user.id
    )

    # Advance phase
    try:
        updated_session = exam_session_service.advance_phase(
            db=db, session=session, target_phase=request.target_phase
        )

        # Create grading tasks when exam is completed
        if request.target_phase == "completed":
            _create_grading_tasks_for_exam_completion(
                db=db,
                topic_id=topic_id,
                user_id=current_user.id,
                topic=topic,
            )

        # Get updated status
        session_status = exam_session_service.get_session_status(updated_session)

        return {
            "success": True,
            "previous_phase": session.current_phase,
            "current_phase": request.target_phase,
            "session": session_status,
        }
    except BusinessException as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


def _has_valid_answer_content(answer: Any) -> bool:
    """
    Check if an answer has valid content for grading.

    For exam mode answers, checks if there are any attachments
    (main, interaction, bonusAgent files, bonusMultimodal) or
    supplementary notes/files.
    """
    if not answer or not answer.content_data:
        return False

    content_data = answer.content_data

    # Check for exam mode content
    if content_data.get("examMode"):
        attachments = content_data.get("attachments", {})

        # Check main attachments
        if attachments.get("main") and len(attachments["main"]) > 0:
            return True

        # Check interaction attachments
        if attachments.get("interaction") and len(attachments["interaction"]) > 0:
            return True

        # Check bonusAgent files
        bonus_agent = attachments.get("bonusAgent", {})
        if bonus_agent.get("files") and len(bonus_agent["files"]) > 0:
            return True
        if bonus_agent.get("link") and bonus_agent["link"].strip():
            return True

        # Check bonusMultimodal attachments
        if (
            attachments.get("bonusMultimodal")
            and len(attachments["bonusMultimodal"]) > 0
        ):
            return True

        # Check supplementary notes files
        if (
            content_data.get("supplementaryNotesFiles")
            and len(content_data["supplementaryNotesFiles"]) > 0
        ):
            return True

        # Check supplementary notes text
        if (
            content_data.get("supplementaryNotes")
            and content_data["supplementaryNotes"].strip()
        ):
            return True

        return False

    # For non-exam mode, check for text content or attachments
    if content_data.get("text") and content_data["text"].strip():
        return True

    if content_data.get("attachments") and len(content_data["attachments"]) > 0:
        return True

    return False


def _create_grading_tasks_for_exam_completion(
    db: Session,
    topic_id: int,
    user_id: int,
    topic: Any,
) -> None:
    """
    Create grading tasks for all valid answers submitted by the user in the exam.

    This is called when the user completes the exam (phase -> completed).
    Creates grading tasks for all answers that have valid content and don't already have one.
    Supports multiple question answers - creates grading tasks for all questions
    that the user has submitted answers for.
    """
    answer_service = get_answer_service()
    question_service = get_question_service()

    # Get all published questions for this topic
    questions, _ = question_service.list_questions(
        db=db,
        topic_id=topic_id,
        page=1,
        limit=1000,
        status=QuestionStatus.PUBLISHED,
    )

    created_count = 0
    skipped_count = 0

    for question in questions:
        # Get the latest answer for this question by the user
        answer = answer_service.get_latest_answer(
            db=db,
            question_id=question.id,
            respondent_id=user_id,
        )

        if not answer:
            continue

        # Check if answer has valid content for grading
        if not _has_valid_answer_content(answer):
            logger.info(
                f"[Evaluation] Answer {answer.id} for question {question.id} has no valid content, skipping"
            )
            skipped_count += 1
            continue

        # Check if grading task already exists
        existing_task = (
            db.query(EvalGradingTask)
            .filter(
                EvalGradingTask.answer_id == answer.id,
                EvalGradingTask.question_id == question.id,
            )
            .first()
        )

        if existing_task:
            logger.info(
                f"[Evaluation] Grading task already exists for answer {answer.id}, skipping"
            )
            skipped_count += 1
            continue

        # Create grading task
        grading_task = EvalGradingTask(
            answer_id=answer.id,
            question_id=question.id,
            question_version=question.current_version,
            respondent_id=user_id,
            status=GradingTaskStatus.PENDING,
            report_data={},
        )
        db.add(grading_task)
        db.flush()

        created_count += 1
        logger.info(
            f"[Evaluation] Created grading task {grading_task.id} for answer {answer.id} "
            f"(question {question.id}, exam completed by user {user_id})"
        )

        # Check if auto_trigger is enabled for this topic
        if topic and topic.grading_team_config:
            grading_config = topic.grading_team_config
            auto_trigger = grading_config.get("auto_trigger", False)
            trigger_condition = grading_config.get("trigger_condition", "manual")
            team_id = grading_config.get("team_id")

            if auto_trigger and trigger_condition == "on_submit" and team_id:
                try:
                    from wecode.service.evaluation.grading_service import GradingService

                    grading_service = GradingService()
                    grading_service.execute(
                        db=db,
                        task=grading_task,
                        team_id=team_id,
                        user_id=topic.creator_id,
                    )
                    logger.info(
                        f"[Evaluation] Auto-triggered grading task {grading_task.id} "
                        f"for exam completion by user {user_id}"
                    )
                except Exception as e:
                    logger.error(
                        f"[Evaluation] Failed to auto-trigger grading task {grading_task.id}: {e}"
                    )

    db.commit()
    logger.info(
        f"[Evaluation] Exam completion grading tasks summary for user {user_id}: "
        f"created={created_count}, skipped={skipped_count}"
    )
