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
from sqlalchemy.orm.attributes import flag_modified

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
    get_grading_service,
    get_permission_service,
    get_question_service,
    get_topic_service,
)
from wecode.service.evaluation.grading_service import (
    build_multi_model_config,
    get_grading_team_id,
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

    extra_data = topic.extra_data or {}

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

    # Get or create exam session to check selected question
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
                "selected_question_id": None,
                "exam_duration_seconds": None,
            }

    # Check for existing answers from current user
    # For exam mode, get answers for ALL questions in the topic
    existing_answer = None
    all_answers = {}
    if formatted_questions:
        # Get answers for all questions in the topic
        answers, _ = answer_service.list_by_topic(
            db=db,
            topic_id=topic_id,
            respondent_id=current_user.id,
            latest_only=True,
            limit=100,  # Get all answers
        )

        # Build a map of question_id -> answer data
        for answer in answers:
            all_answers[answer.question_id] = {
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

        # For backward compatibility, also set existing_answer to the currently selected question
        target_question_id = None
        if session and session.selected_question_id:
            target_question_id = session.selected_question_id
        elif formatted_questions:
            target_question_id = formatted_questions[0]["id"]

        if target_question_id and target_question_id in all_answers:
            existing_answer = all_answers[target_question_id]

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
        "allAnswers": all_answers,  # Include answers for all questions
        "session": session_status,
    }


class ExamSubmitRequest(BaseModel):
    """Schema for exam submission request."""

    selectedQuestionId: int = Field(..., description="The selected question ID")
    participantName: str = Field(..., description="Name of the participant")
    content_data: Dict[str, Any] = Field(
        ...,
        description="Exam content data including attachments, participant name, etc.",
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
        "participantName": request.participantName,
        "selectedTopicId": topic_id,
    }

    # Check for existing answer to allow multiple submissions
    existing_answer = answer_service.get_latest_answer(
        db=db,
        question_id=request.selectedQuestionId,
        respondent_id=current_user.id,
    )

    if existing_answer:
        # Update existing answer using service layer merge logic
        updated_content = answer_service.merge_content_data(
            existing_answer.content_data or {}, content_data
        )
        existing_answer.content_data = updated_content
        flag_modified(existing_answer, "content_data")
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
        # Merge existing content_data with new data using service layer
        updated_content = answer_service.merge_content_data(
            existing_answer.content_data or {}, request.content_data or {}
        )
        existing_answer.content_data = updated_content
        flag_modified(existing_answer, "content_data")
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
        updated_session = exam_session_service.advance_phase_with_conversion(
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


def _has_valid_answer_content(answer: Any, question: Any = None) -> bool:
    """
    Check if an answer has valid content for grading.

    If question is provided, validates against answerSlots configuration:
    - For each required slot, check if answer has valid content (text, link, or files)

    If no answerSlots configuration, falls back to checking any content existence.

    Args:
        answer: The answer object
        question: Optional question object with content_data.answerSlots

    Returns:
        True if answer has valid content for grading
    """
    if not answer or not answer.content_data:
        return False

    content_data = answer.content_data

    # Get answerSlots from question if available
    answer_slots = []
    if question and question.content_data:
        answer_slots = question.content_data.get("answerSlots", [])

    # New structure: answers dict with slot keys
    answers = content_data.get("answers", {})

    # If answerSlots are defined, validate required slots
    if answer_slots:
        for slot in answer_slots:
            if not slot.get("required", False):
                continue  # Skip optional slots
            slot_key = slot.get("key")
            if not slot_key:
                continue
            slot_answer = answers.get(slot_key, {})
            # A slot has valid content if it has non-empty text, link, OR files
            has_text = bool(slot_answer.get("text", "").strip())
            has_link = bool(slot_answer.get("link", "").strip())
            has_files = bool(slot_answer.get("files") and len(slot_answer["files"]) > 0)
            if not has_text and not has_link and not has_files:
                return False  # Required slot is empty
        # All required slots have content
        return True

    # Fallback: Check if any answer slot has content
    if answers:
        for slot_answer in answers.values():
            if isinstance(slot_answer, dict):
                has_text = bool(slot_answer.get("text", "").strip())
                has_link = bool(slot_answer.get("link", "").strip())
                has_files = bool(
                    slot_answer.get("files") and len(slot_answer["files"]) > 0
                )
                if has_text or has_link or has_files:
                    return True

    # Legacy fallback: Check old structure for backward compatibility
    attachments = content_data.get("attachments", {})

    # Check any attachment slot
    for slot_value in attachments.values():
        if isinstance(slot_value, list) and len(slot_value) > 0:
            return True
        if isinstance(slot_value, dict):
            if slot_value.get("files") and len(slot_value["files"]) > 0:
                return True
            if slot_value.get("link") and slot_value["link"].strip():
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
        if not _has_valid_answer_content(answer, question):
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

        # Get grading_mode from topic config
        grading_mode = None
        if topic and topic.grading_team_config:
            grading_mode = topic.grading_team_config.get("grading_mode")
            # Backward compatibility: if no grading_mode but has team_id, it's single mode
            if not grading_mode and topic.grading_team_config.get("team_id"):
                grading_mode = "single"

        # Create grading task with grading_mode in report_data
        report_data = {"grading_mode": grading_mode} if grading_mode else {}
        grading_task = EvalGradingTask(
            answer_id=answer.id,
            question_id=question.id,
            question_version=question.current_version,
            respondent_id=user_id,
            status=GradingTaskStatus.PENDING,
            report_data=report_data,
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

            # Get team_id based on grading mode (single or multi)
            team_id = get_grading_team_id(grading_config)
            grading_mode = grading_config.get("grading_mode", "single")

            logger.info(
                f"[Evaluation] Auto-trigger check for task {grading_task.id}: "
                f"auto_trigger={auto_trigger}, trigger_condition={trigger_condition}, "
                f"grading_mode={grading_mode}, team_id={team_id}"
            )

            if auto_trigger and trigger_condition == "on_submit" and team_id:
                try:
                    grading_service = get_grading_service()

                    # Build multi-model config if in multi mode
                    multi_model_config = build_multi_model_config(grading_config)
                    if multi_model_config:
                        logger.info(
                            f"[Evaluation] Using multi-model grading for task "
                            f"{grading_task.id} with {len(multi_model_config.scorer_models)} scorers"
                        )

                    # For single mode, extract model config from topic config
                    # When model_id is specified, default force_override to True
                    # for consistency with multi-model mode behavior
                    model_id = grading_config.get("model_id")
                    force_override = grading_config.get(
                        "force_override_bot_model", True if model_id else False
                    )

                    grading_service.execute(
                        db=db,
                        task=grading_task,
                        team_id=team_id,
                        user_id=topic.creator_id,
                        model_id=model_id,
                        force_override_bot_model=force_override,
                        multi_model_config=multi_model_config,
                    )
                    logger.info(
                        f"[Evaluation] Auto-triggered grading task {grading_task.id} "
                        f"for exam completion by user {user_id}"
                    )
                except Exception as e:
                    logger.error(
                        f"[Evaluation] Failed to auto-trigger grading task {grading_task.id}: {e}"
                    )
            else:
                logger.info(
                    f"[Evaluation] Auto-trigger skipped for task {grading_task.id}: "
                    f"conditions not met (auto_trigger={auto_trigger}, "
                    f"trigger_condition={trigger_condition}, team_id={team_id})"
                )

    db.commit()
    logger.info(
        f"[Evaluation] Exam completion grading tasks summary for user {user_id}: "
        f"created={created_count}, skipped={skipped_count}"
    )
