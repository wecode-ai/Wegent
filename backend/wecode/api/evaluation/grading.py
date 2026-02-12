# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Grading task API endpoints.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.models.evaluation import GradingTaskStatus
from wecode.schemas.evaluation import (
    GradingTaskExecuteRequest,
    GradingTaskInDB,
    GradingTaskListResponse,
    GradingTaskPublishRequest,
    GradingTaskUpdateReportRequest,
)
from wecode.service.evaluation import (
    get_grading_service,
    get_permission_service,
    get_question_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/topics/{topic_id}/grading-tasks", response_model=GradingTaskListResponse)
def list_grading_tasks(
    topic_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    status_filter: Optional[int] = Query(None, alias="status", description="Filter by status"),
    respondent_id: Optional[int] = Query(None, description="Filter by respondent"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List grading tasks for a topic. Only graders/creators can see all tasks.
    """
    topic_service = get_topic_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_grade(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to view grading tasks",
        )

    tasks, total = grading_service.list_tasks(
        db=db,
        topic_id=topic_id,
        status=status_filter,
        respondent_id=respondent_id,
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


@router.get("/grading-tasks/{task_id}", response_model=GradingTaskInDB)
def get_grading_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get grading task details.

    - Graders/Creators can see any task
    - Respondents can see their own published tasks
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

    # Check permission
    can_grade = permission_service.can_grade(db, topic, current_user.id)
    is_own_task = task.respondent_id == current_user.id
    is_published = task.status == GradingTaskStatus.PUBLISHED

    if not can_grade and not (is_own_task and is_published):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to view this grading task",
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


@router.post("/grading-tasks/{task_id}/execute", response_model=GradingTaskInDB)
def execute_grading_task(
    task_id: int,
    request: GradingTaskExecuteRequest = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Execute a grading task using AI team.
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

    if task.status not in (GradingTaskStatus.PENDING, GradingTaskStatus.FAILED):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Task is already running or completed",
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

    if not permission_service.can_grade(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to execute grading",
        )

    # Get team ID
    team_id = None
    if request and request.team_id:
        team_id = request.team_id
    elif topic.grading_team_config:
        team_id = topic.grading_team_config.get("team_id")

    if not team_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No grading team configured",
        )

    task = grading_service.execute(db, task, team_id, current_user.id)
    db.commit()

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


@router.put("/grading-tasks/{task_id}/report", response_model=GradingTaskInDB)
def update_grading_report(
    task_id: int,
    request: GradingTaskUpdateReportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update grading report content before publishing.
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

    if task.status not in (GradingTaskStatus.COMPLETED,):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can only update completed tasks before publishing",
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

    if not permission_service.can_grade(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to update grading reports",
        )

    task = grading_service.update_report(db, task, request.report_content)
    db.commit()

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


@router.post("/grading-tasks/{task_id}/publish", response_model=GradingTaskInDB)
def publish_grading_report(
    task_id: int,
    request: GradingTaskPublishRequest = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish a grading report to the respondent.
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

    if task.status != GradingTaskStatus.COMPLETED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can only publish completed grading tasks",
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

    if not permission_service.can_grade(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to publish grading reports",
        )

    report_content = request.report_content if request else None
    task = grading_service.publish(db, task, report_content)
    db.commit()

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


@router.post("/topics/{topic_id}/grading-tasks/batch-execute")
def batch_execute_grading_tasks(
    topic_id: int,
    task_ids: List[int],
    team_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Execute multiple grading tasks.
    """
    topic_service = get_topic_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_grade(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to execute grading",
        )

    # Get team ID
    effective_team_id = team_id
    if not effective_team_id and topic.grading_team_config:
        effective_team_id = topic.grading_team_config.get("team_id")

    if not effective_team_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No grading team configured",
        )

    tasks = grading_service.batch_execute(db, task_ids, effective_team_id, current_user.id)
    db.commit()

    return {"executed_count": len(tasks), "task_ids": [t.id for t in tasks]}


@router.post("/topics/{topic_id}/grading-tasks/batch-publish")
def batch_publish_grading_reports(
    topic_id: int,
    task_ids: List[int],
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Publish multiple grading reports.
    """
    topic_service = get_topic_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    if not permission_service.can_grade(db, topic, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to publish grading reports",
        )

    tasks = grading_service.batch_publish(db, task_ids)
    db.commit()

    return {"published_count": len(tasks), "task_ids": [t.id for t in tasks]}


@router.get("/my/grading-reports", response_model=GradingTaskListResponse)
def list_my_grading_reports(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    topic_id: Optional[int] = Query(None, description="Filter by topic"),
    status_filter: Optional[int] = Query(
        GradingTaskStatus.PUBLISHED, alias="status", description="Filter by status"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List current user's grading reports (as respondent).

    By default, only shows published reports.
    """
    grading_service = get_grading_service()

    tasks, total = grading_service.list_by_respondent(
        db=db,
        respondent_id=current_user.id,
        topic_id=topic_id,
        status=status_filter,
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
