# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared API endpoints for evaluation module.

Provides endpoints accessible to all roles:
- Report viewing (with permission check)
- File upload/download with presigned URLs
"""

import logging
import os
import re
from enum import Enum
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.models.evaluation import GradingTaskStatus
from wecode.schemas.evaluation import GradingTaskInDB
from wecode.service.evaluation import (
    get_grading_service,
    get_permission_service,
    get_question_service,
    get_storage_service,
    get_topic_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ============================================================================
# Schemas for file operations
# ============================================================================


class FileType(str, Enum):
    """Supported file types for upload."""

    QUESTION_CONTENT = "question_content"
    QUESTION_CRITERIA = "question_criteria"
    ANSWER_ATTACHMENT = "answer_attachment"


class FileUploadRequest(BaseModel):
    """Request schema for file upload."""

    file_type: FileType = Field(..., description="Type of file being uploaded")
    filename: str = Field(
        ..., min_length=1, max_length=255, description="Original filename"
    )
    topic_id: int = Field(..., description="Topic ID for the file")
    question_id: Optional[int] = Field(
        None,
        description="Question ID (required for question_content/question_criteria)",
    )
    content_type: Optional[str] = Field(
        "application/octet-stream", description="MIME type of the file"
    )


class FileUploadResponse(BaseModel):
    """Response schema for file upload."""

    key: str = Field(..., description="Storage key for the file")
    upload_url: str = Field(..., description="Presigned PUT URL for uploading")
    expires_in: int = Field(..., description="URL expiration time in seconds")


class FileDownloadRequest(BaseModel):
    """Request schema for file download."""

    s3_path: str = Field(..., description="S3 storage path of the file")


class FileDownloadResponse(BaseModel):
    """Response schema for file download."""

    download_url: str = Field(..., description="Presigned GET URL for downloading")
    expires_in: int = Field(..., description="URL expiration time in seconds")


# ============================================================================
# Report viewing endpoint
# ============================================================================


@router.get("/reports/{report_id}", response_model=GradingTaskInDB)
def view_report(
    report_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    View a published grading report.

    Permission check:
    - User is the topic creator, OR
    - User is a grader for the topic, OR
    - User is the respondent who submitted the answer
    """
    topic_service = get_topic_service()
    question_service = get_question_service()
    grading_service = get_grading_service()
    permission_service = get_permission_service()

    # Get the grading task (report)
    task = grading_service.get(db, report_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )

    # Get the question to find the topic
    question = question_service.get(db, task.question_id)
    if not question:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Question not found",
        )

    # Get the topic
    topic = topic_service.get(db, question.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Permission check: user is topic creator
    is_creator = topic.creator_id == current_user.id

    # Permission check: user is grader
    is_grader = permission_service.can_grade(db, topic, current_user.id)

    # Permission check: user is the respondent who submitted the answer
    is_own_respondent = task.respondent_id == current_user.id

    # Only allow access if user has permission
    if not (is_creator or is_grader or is_own_respondent):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to view this report",
        )

    # For respondents (not creators/graders), only allow viewing published reports
    if is_own_respondent and not is_creator and not is_grader:
        if task.status != GradingTaskStatus.PUBLISHED:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This report is not yet published",
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


# ============================================================================
# File upload endpoint
# ============================================================================


@router.post("/files/upload", response_model=FileUploadResponse)
def upload_file(
    request: FileUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a presigned URL for file upload.

    Accepts file types:
    - question_content: Question content attachments (requires creator/grader permission)
    - question_criteria: Grading criteria attachments (requires creator/grader permission)
    - answer_attachment: Answer submission attachments (requires respondent permission)

    Returns a presigned PUT URL that the client can use to upload the file directly to S3.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()
    storage_service = get_storage_service()

    # Validate topic exists
    topic = topic_service.get(db, request.topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Permission check based on file type
    if request.file_type in (FileType.QUESTION_CONTENT, FileType.QUESTION_CRITERIA):
        # Question content/criteria requires creator or grader permission
        if not permission_service.can_grade(db, topic, current_user.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload question files",
            )

        # question_id is required for question files
        if not request.question_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="question_id is required for question files",
            )

    elif request.file_type == FileType.ANSWER_ATTACHMENT:
        # Answer attachment requires respondent permission
        if not permission_service.can_answer(db, topic, current_user.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload answer attachments",
            )

    # Generate storage key
    key = storage_service.generate_upload_key(
        file_type=request.file_type.value,
        user_id=current_user.id,
        topic_id=request.topic_id,
        question_id=request.question_id,
        filename=request.filename,
    )

    # Generate presigned PUT URL
    expires_in = 3600  # 1 hour
    upload_url = storage_service.get_presigned_put_url(key, expires=expires_in)

    if not upload_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate upload URL. Storage service may not be configured.",
        )

    return FileUploadResponse(
        key=key,
        upload_url=upload_url,
        expires_in=expires_in,
    )


# ============================================================================
# File download endpoint
# ============================================================================


# Get the S3 prefix from environment (same as storage service)
_EVAL_S3_PREFIX = os.getenv("EVAL_S3_PREFIX", "evaluation")

# Path patterns for permission verification (prefix can vary, e.g., evaluation, evaluation_dev)
# Pattern format: {prefix}/questions/{topic_id}/{question_id}/...
PATH_PATTERNS = {
    # {prefix}/questions/{topic_id}/{question_id}/...
    "question": re.compile(rf"^{re.escape(_EVAL_S3_PREFIX)}/questions/(\d+)/(\d+)/"),
    # {prefix}/criteria/{topic_id}/{question_id}/...
    "criteria": re.compile(rf"^{re.escape(_EVAL_S3_PREFIX)}/criteria/(\d+)/(\d+)/"),
    # {prefix}/answers/{user_id}/{topic_id}/{question_id}/...
    "answer": re.compile(rf"^{re.escape(_EVAL_S3_PREFIX)}/answers/(\d+)/(\d+)/(\d+)/"),
    # {prefix}/reports/{user_id}/{topic_id}/{question_id}/...
    "report": re.compile(rf"^{re.escape(_EVAL_S3_PREFIX)}/reports/(\d+)/(\d+)/(\d+)/"),
}


@router.get("/files/download", response_model=FileDownloadResponse)
def download_file(
    s3_path: str = Query(..., description="S3 storage path of the file"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a presigned URL for file download.

    Permission is verified based on the S3 path pattern:
    - Question content: Anyone who can view the topic can download
    - Criteria: Topic creator or grader can download (not respondents)
    - Answer: Topic creator, grader, or the answer owner can download
    - Report: Topic creator, grader, or the respondent can download
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()
    storage_service = get_storage_service()

    # Parse path to determine type and extract IDs
    topic_id = None
    allowed = False

    # Check question content pattern
    match = PATH_PATTERNS["question"].match(s3_path)
    if match:
        topic_id = int(match.group(1))
        topic = topic_service.get(db, topic_id)
        if topic:
            # Question content: anyone who can view the topic can download
            # (creators, graders, and respondents all need to see question content)
            allowed = permission_service.can_view_topic(db, topic, current_user.id)

    # Check criteria pattern
    if not allowed:
        match = PATH_PATTERNS["criteria"].match(s3_path)
        if match:
            topic_id = int(match.group(1))
            topic = topic_service.get(db, topic_id)
            if topic:
                # Criteria: only creator or grader can download (not respondents)
                allowed = permission_service.can_view_criteria(db, topic, current_user.id)

    # Check answer pattern
    if not allowed:
        match = PATH_PATTERNS["answer"].match(s3_path)
        if match:
            user_id = int(match.group(1))
            topic_id = int(match.group(2))
            topic = topic_service.get(db, topic_id)
            if topic:
                # Answer: creator, grader, or the answer owner
                if user_id == current_user.id:
                    allowed = True
                else:
                    allowed = permission_service.can_grade(db, topic, current_user.id)

    # Check report pattern
    if not allowed:
        match = PATH_PATTERNS["report"].match(s3_path)
        if match:
            respondent_id = int(match.group(1))
            topic_id = int(match.group(2))
            topic = topic_service.get(db, topic_id)
            if topic:
                # Report: creator, grader, or the respondent
                if respondent_id == current_user.id:
                    allowed = True
                else:
                    allowed = permission_service.can_grade(db, topic, current_user.id)

    # If no pattern matched or permission denied
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to download this file",
        )

    # Check if file exists
    if not storage_service.exists(s3_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Generate presigned GET URL
    expires_in = 3600  # 1 hour
    download_url = storage_service.get_presigned_url(s3_path, expires=expires_in)

    if not download_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate download URL. Storage service may not be configured.",
        )

    return FileDownloadResponse(
        download_url=download_url,
        expires_in=expires_in,
    )
