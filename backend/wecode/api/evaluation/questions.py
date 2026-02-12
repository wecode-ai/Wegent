# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Question management API endpoints.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.schemas.evaluation import (
    QuestionCreate,
    QuestionInDB,
    QuestionListResponse,
    QuestionUpdate,
    QuestionVersionInDB,
)
from wecode.service.evaluation import (
    get_permission_service,
    get_question_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/topics/{topic_id}/questions", response_model=QuestionListResponse)
def list_questions(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    status_filter: Optional[int] = Query(None, alias="status", description="Filter by status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List questions for a topic.
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

    # Check if user can view criteria
    include_criteria = permission_service.can_view_criteria(db, topic, current_user.id)

    questions, total = question_service.list_questions(
        db=db,
        topic_id=topic_id,
        page=page,
        limit=limit,
        status=status_filter,
        include_criteria=include_criteria,
    )

    items = []
    for q in questions:
        q_dict = {
            "id": q.id,
            "topic_id": q.topic_id,
            "title": q.title,
            "content_type": q.content_type,
            "content_data": {k: v for k, v in (q.content_data or {}).items() if k != "_criteria"},
            "status": q.status,
            "current_version": q.current_version,
            "order_index": q.order_index,
            "creator_id": q.creator_id,
            "created_at": q.created_at,
            "updated_at": q.updated_at,
            "is_active": q.is_active,
        }

        if include_criteria:
            q_dict["criteria_data"] = (q.content_data or {}).get("_criteria", {})

        items.append(QuestionInDB(**q_dict))

    return QuestionListResponse(total=total, items=items)


@router.post(
    "/topics/{topic_id}/questions",
    response_model=QuestionInDB,
    status_code=status.HTTP_201_CREATED,
)
def create_question(
    topic_id: int,
    question_create: QuestionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new question in a topic. Only the topic creator can create questions.
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

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the topic creator can add questions",
        )

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

    return QuestionInDB(
        id=question.id,
        topic_id=question.topic_id,
        title=question.title,
        content_type=question.content_type,
        content_data={k: v for k, v in (question.content_data or {}).items() if k != "_criteria"},
        status=question.status,
        current_version=question.current_version,
        order_index=question.order_index,
        creator_id=question.creator_id,
        created_at=question.created_at,
        updated_at=question.updated_at,
        is_active=question.is_active,
        criteria_data=(question.content_data or {}).get("_criteria", {}),
    )


@router.get("/questions/{question_id}", response_model=QuestionInDB)
def get_question(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get question details by ID.
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

    include_criteria = permission_service.can_view_criteria(db, topic, current_user.id)

    q_dict = {
        "id": question.id,
        "topic_id": question.topic_id,
        "title": question.title,
        "content_type": question.content_type,
        "content_data": {k: v for k, v in (question.content_data or {}).items() if k != "_criteria"},
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


@router.put("/questions/{question_id}", response_model=QuestionInDB)
def update_question(
    question_id: int,
    question_update: QuestionUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a question. Only the topic creator can update.
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

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the topic creator can edit questions",
        )

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

    return QuestionInDB(
        id=question.id,
        topic_id=question.topic_id,
        title=question.title,
        content_type=question.content_type,
        content_data={k: v for k, v in (question.content_data or {}).items() if k != "_criteria"},
        status=question.status,
        current_version=question.current_version,
        order_index=question.order_index,
        creator_id=question.creator_id,
        created_at=question.created_at,
        updated_at=question.updated_at,
        is_active=question.is_active,
        criteria_data=(question.content_data or {}).get("_criteria", {}),
    )


@router.delete("/questions/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_question(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a question (soft delete). Only the topic creator can delete.
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

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the topic creator can delete questions",
        )

    question_service.delete(db, question)
    db.commit()


@router.post("/questions/{question_id}/publish", response_model=QuestionVersionInDB)
def publish_question(
    question_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish a question. Creates a new version.
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

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the topic creator can publish questions",
        )

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


@router.post("/topics/{topic_id}/questions/reorder", status_code=status.HTTP_200_OK)
def reorder_questions(
    topic_id: int,
    question_ids: List[int],
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Reorder questions in a topic.
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

    if not permission_service.can_edit_topic(topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the topic creator can reorder questions",
        )

    question_service.reorder_questions(db, topic_id, question_ids)
    db.commit()

    return {"message": "Questions reordered successfully"}
