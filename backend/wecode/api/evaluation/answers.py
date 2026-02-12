# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Answer submission API endpoints.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.models.evaluation import QuestionStatus
from wecode.schemas.evaluation import (
    AnswerCreate,
    AnswerInDB,
    AnswerListResponse,
)
from wecode.service.evaluation import (
    get_answer_service,
    get_permission_service,
    get_question_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


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


@router.get("/questions/{question_id}/answers", response_model=AnswerListResponse)
def list_answers(
    question_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    respondent_id: Optional[int] = Query(None, description="Filter by respondent"),
    latest_only: bool = Query(False, description="Only show latest answers"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List answers for a question.

    - Graders/Creators can see all answers
    - Respondents can only see their own answers
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

    # Check if user can see all answers
    can_see_all = permission_service.can_view_all_answers(db, topic, current_user.id)

    # Force filter to current user if not grader/creator
    effective_respondent_id = respondent_id
    if not can_see_all:
        effective_respondent_id = current_user.id

    answers, total = answer_service.list_answers(
        db=db,
        question_id=question_id,
        respondent_id=effective_respondent_id,
        latest_only=latest_only,
        page=page,
        limit=limit,
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


@router.get("/questions/{question_id}/answers/me", response_model=AnswerListResponse)
def list_my_answers(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List current user's answers for a question (answer history).
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

    answers = answer_service.get_answer_history(db, question_id, current_user.id)

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

    return AnswerListResponse(total=len(items), items=items)


@router.get("/questions/{question_id}/version-check")
def check_version_update(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Check if there's a newer question version since the user's last answer.
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

    new_version = answer_service.check_version_update(db, question_id, current_user.id)

    return {
        "has_new_version": new_version is not None,
        "new_version": new_version,
        "current_version": question.current_version,
    }


@router.get("/topics/{topic_id}/my-progress")
def get_my_progress(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get current user's progress on a topic.
    """
    topic_service = get_topic_service()
    answer_service = get_answer_service()
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

    progress = answer_service.get_respondent_progress(db, topic_id, current_user.id)
    return progress
