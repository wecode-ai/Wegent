# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared API endpoints for evaluation module.

Provides endpoints accessible to all roles:
- Report viewing (with permission check)
- File upload/download with backend proxy (no S3 URL exposure to frontend)
"""

import logging
import os
import re
from enum import Enum
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
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


class FileUploadResponse(BaseModel):
    """Response schema for file upload (backend proxy mode)."""

    key: str = Field(..., description="Storage key for the file")
    filename: str = Field(..., description="Original filename")
    file_size: int = Field(..., description="File size in bytes")
    content_type: str = Field(..., description="MIME type of the file")


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
# File upload endpoint (backend proxy mode)
# ============================================================================


@router.post("/files/upload", response_model=FileUploadResponse)
async def upload_file(
    file: UploadFile = File(..., description="File to upload"),
    file_type: FileType = Form(..., description="Type of file being uploaded"),
    topic_id: int = Form(..., description="Topic ID for the file"),
    question_id: Optional[int] = Form(None, description="Question ID (required for question files)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Upload a file through backend proxy (no S3 URL exposure).

    Accepts file types:
    - question_content: Question content attachments (requires creator/grader permission)
    - question_criteria: Grading criteria attachments (requires creator/grader permission)
    - answer_attachment: Answer submission attachments (requires respondent permission)

    The file is uploaded directly to the backend, which proxies it to S3.
    This avoids exposing S3 URLs to the frontend (prevents Mixed Content issues).
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()
    storage_service = get_storage_service()

    # Validate topic exists
    topic = topic_service.get(db, topic_id)
    if not topic:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Topic not found",
        )

    # Permission check based on file type
    if file_type in (FileType.QUESTION_CONTENT, FileType.QUESTION_CRITERIA):
        # Question content/criteria requires creator or grader permission
        if not permission_service.can_grade(db, topic, current_user.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload question files",
            )

        # question_id is required for question files
        if not question_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="question_id is required for question files",
            )

    elif file_type == FileType.ANSWER_ATTACHMENT:
        # Answer attachment requires respondent permission
        if not permission_service.can_answer(db, topic, current_user.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload answer attachments",
            )

    # Read file content
    try:
        file_content = await file.read()
        file_size = len(file_content)
    except Exception as e:
        logger.error(f"[Evaluation] Failed to read uploaded file: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read uploaded file",
        )

    # Generate storage key
    filename = file.filename or "unnamed"
    content_type = file.content_type or "application/octet-stream"

    key = storage_service.generate_upload_key(
        file_type=file_type.value,
        user_id=current_user.id,
        topic_id=topic_id,
        question_id=question_id,
        filename=filename,
    )

    # Upload to S3 via backend
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

    return FileUploadResponse(
        key=uploaded_key,
        filename=filename,
        file_size=file_size,
        content_type=content_type,
    )


# ============================================================================
# File download endpoint (backend proxy mode)
# ============================================================================


def _get_path_patterns() -> dict:
    """
    Get path patterns for permission verification.

    This function is called at runtime to ensure the correct S3 prefix is used,
    even if the environment variable is set after module load.

    Pattern format: {prefix}/questions/{topic_id}/{question_id}/...
    """
    # Get the S3 prefix from environment (same as storage service)
    prefix = os.getenv("EVAL_S3_PREFIX", "evaluation")
    escaped_prefix = re.escape(prefix)
    return {
        # {prefix}/questions/{topic_id}/{question_id}/...
        "question": re.compile(rf"^{escaped_prefix}/questions/(\d+)/(\d+)/"),
        # {prefix}/criteria/{topic_id}/{question_id}/...
        "criteria": re.compile(rf"^{escaped_prefix}/criteria/(\d+)/(\d+)/"),
        # {prefix}/answers/{user_id}/{topic_id}/{question_id}/...
        "answer": re.compile(rf"^{escaped_prefix}/answers/(\d+)/(\d+)/(\d+)/"),
        # {prefix}/reports/{user_id}/{topic_id}/{question_id}/...
        "report": re.compile(rf"^{escaped_prefix}/reports/(\d+)/(\d+)/(\d+)/"),
    }


def _verify_download_permission(
    s3_path: str,
    current_user: User,
    db: Session,
) -> bool:
    """
    Verify download permission based on S3 path pattern.

    Returns True if user has permission to download the file.
    """
    topic_service = get_topic_service()
    permission_service = get_permission_service()

    path_patterns = _get_path_patterns()
    logger.debug(f"Download file request: s3_path={s3_path}, user_id={current_user.id}")

    # Check question content pattern
    match = path_patterns["question"].match(s3_path)
    if match:
        topic_id = int(match.group(1))
        topic = topic_service.get(db, topic_id)
        if topic:
            return permission_service.can_view_topic(db, topic, current_user.id)
        return False

    # Check criteria pattern
    match = path_patterns["criteria"].match(s3_path)
    if match:
        topic_id = int(match.group(1))
        topic = topic_service.get(db, topic_id)
        if topic:
            return permission_service.can_view_criteria(db, topic, current_user.id)
        return False

    # Check answer pattern
    match = path_patterns["answer"].match(s3_path)
    if match:
        user_id = int(match.group(1))
        topic_id = int(match.group(2))
        topic = topic_service.get(db, topic_id)
        if topic:
            if user_id == current_user.id:
                return True
            return permission_service.can_grade(db, topic, current_user.id)
        return False

    # Check report pattern
    match = path_patterns["report"].match(s3_path)
    if match:
        respondent_id = int(match.group(1))
        topic_id = int(match.group(2))
        topic = topic_service.get(db, topic_id)
        if topic:
            if respondent_id == current_user.id:
                return True
            return permission_service.can_grade(db, topic, current_user.id)
        return False

    return False


@router.get("/files/download")
def download_file(
    s3_path: str = Query(..., description="S3 storage path of the file"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Download a file through backend proxy (no S3 URL exposure).

    Permission is verified based on the S3 path pattern:
    - Question content: Anyone who can view the topic can download
    - Criteria: Topic creator or grader can download (not respondents)
    - Answer: Topic creator, grader, or the answer owner can download
    - Report: Topic creator, grader, or the respondent can download

    Returns the file content as a streaming response.
    Uses streaming to avoid loading entire file into memory.
    """
    storage_service = get_storage_service()

    # Verify permission
    if not _verify_download_permission(s3_path, current_user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to download this file",
        )

    # Get file info first to check existence and get size
    file_info = storage_service.get_file_info(s3_path)
    if file_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Get file stream
    file_stream = storage_service.get_stream(s3_path)
    if file_stream is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Extract filename from path
    filename = s3_path.split("/")[-1]

    # Try to determine content type based on file extension or use stored content type
    content_type = file_info.get("content_type", "application/octet-stream")
    if content_type == "application/octet-stream" and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        content_type_map = {
            "pdf": "application/pdf",
            "doc": "application/msword",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls": "application/vnd.ms-excel",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt": "application/vnd.ms-powerpoint",
            "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "txt": "text/plain",
            "md": "text/markdown",
            "json": "application/json",
            "xml": "application/xml",
            "zip": "application/zip",
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "gif": "image/gif",
            "svg": "image/svg+xml",
        }
        content_type = content_type_map.get(ext, content_type)

    # RFC 5987 encoding for non-ASCII filenames
    encoded_filename = quote(filename, safe="")
    content_disposition = (
        f'attachment; filename="{encoded_filename}"; '
        f"filename*=UTF-8''{encoded_filename}"
    )

    # Return file as streaming response (memory efficient for large files)
    return StreamingResponse(
        file_stream,
        media_type=content_type,
        headers={
            "Content-Disposition": content_disposition,
            "Content-Length": str(file_info.get("size", 0)),
        },
    )
