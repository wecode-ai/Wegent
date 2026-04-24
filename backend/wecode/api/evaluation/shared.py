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

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
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
    EXAM_ATTACHMENT = "exam_attachment"
    TOPIC_ATTACHMENT = "topic_attachment"


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
        grading_mode=grading_mode,
    )


# ============================================================================
# File upload endpoint (backend proxy mode)
# ============================================================================


@router.post("/files/upload", response_model=FileUploadResponse)
async def upload_file(
    file: UploadFile = File(..., description="File to upload"),
    file_type: FileType = Form(..., description="Type of file being uploaded"),
    topic_id: int = Form(..., description="Topic ID for the file"),
    question_id: Optional[int] = Form(
        None, description="Question ID (required for question files)"
    ),
    slot: Optional[str] = Form(
        None, description="Slot identifier for exam attachments"
    ),
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

    elif file_type == FileType.EXAM_ATTACHMENT:
        # Exam attachment requires respondent permission
        if not permission_service.can_answer(db, topic, current_user.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload exam attachments",
            )

    elif file_type == FileType.TOPIC_ATTACHMENT:
        # Topic attachment requires author permission (topic creator)
        if topic.creator_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload topic attachments",
            )

    # Validate file type for exam attachments
    if file_type == FileType.EXAM_ATTACHMENT and question_id:
        question_service = get_question_service()
        question = question_service.get(db, question_id)
        if question and question.content_data:
            answer_slots = question.content_data.get("answerSlots", [])

            # Determine which slots to validate against
            slots_to_check = []
            if slot:
                # If slot is specified, validate against that specific slot
                slots_to_check = [s for s in answer_slots if s.get("key") == slot]
            else:
                # If no slot specified, validate against all file-upload slots
                # (attachment, link+attachment, link_or_attachment modes)
                slots_to_check = [
                    s for s in answer_slots
                    if s.get("inputMode") in ("attachment", "link+attachment", "link_or_attachment")
                ]

            # Collect all allowed extensions from relevant slots
            all_allowed_extensions = []
            accept_display_list = []
            for answer_slot in slots_to_check:
                accept = answer_slot.get("accept", "")
                if accept:
                    allowed_extensions = [
                        ext.strip().lower()
                        for ext in accept.split(",")
                        if ext.strip()
                    ]
                    all_allowed_extensions.extend(allowed_extensions)
                    accept_display_list.append(accept)

            # Validate file extension if we have any restrictions
            if all_allowed_extensions:
                filename_lower = (file.filename or "").lower()
                if not any(
                    filename_lower.endswith(ext) for ext in all_allowed_extensions
                ):
                    # Format allowed types for display (remove dots and deduplicate)
                    allowed_types = ", ".join(
                        sorted(set(
                            acc.replace(".", "").upper()
                            for acc in accept_display_list
                        ))
                    )
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"文件格式不支持，仅允许上传以下格式：{allowed_types}",
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
        slot=slot,
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
# Text-to-file upload endpoint (backend proxy mode)
# ============================================================================


class TextUploadRequest(BaseModel):
    """Request schema for uploading text as a file."""

    content: str = Field(..., description="Text content to upload as file")
    filename: str = Field(..., description="Filename for the uploaded file")
    file_type: FileType = Field(..., description="Type of file")
    topic_id: int = Field(..., description="Topic ID")
    question_id: Optional[int] = Field(None, description="Question ID")
    slot: Optional[str] = Field(
        None, description="Slot identifier for exam attachments"
    )


@router.post("/files/upload-text", response_model=FileUploadResponse)
async def upload_text_as_file(
    request: TextUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Upload text content as a file through backend proxy.

    This endpoint converts text content to a file and uploads it to S3.
    Useful for uploading supplementary notes or other text-based content.
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
        if not permission_service.can_grade(db, topic, current_user.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload question files",
            )
        if not request.question_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="question_id is required for question files",
            )

    elif request.file_type == FileType.EXAM_ATTACHMENT:
        # Exam attachment requires respondent permission
        if not permission_service.can_answer(db, topic, current_user.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload exam attachments",
            )

    elif request.file_type == FileType.TOPIC_ATTACHMENT:
        # Topic attachment requires author permission (topic creator)
        if topic.creator_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to upload topic attachments",
            )

    # Convert text to bytes
    try:
        file_content = request.content.encode("utf-8")
        file_size = len(file_content)
    except Exception as e:
        logger.error(f"[Evaluation] Failed to encode text content: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to encode text content",
        )

    # Determine content type based on filename extension
    content_type = "text/plain"
    if request.filename.endswith(".md"):
        content_type = "text/markdown"
    elif request.filename.endswith(".json"):
        content_type = "application/json"

    # Generate storage key
    key = storage_service.generate_upload_key(
        file_type=request.file_type.value,
        user_id=current_user.id,
        topic_id=request.topic_id,
        question_id=request.question_id,
        slot=request.slot,
        filename=request.filename,
    )

    # Upload to S3 via backend
    uploaded_key = storage_service.upload_file(
        key=key,
        data=file_content,
        content_type=content_type,
        filename=request.filename,
    )

    if not uploaded_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to upload file to storage",
        )

    return FileUploadResponse(
        key=uploaded_key,
        filename=request.filename,
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
        # {prefix}/reports/{user_id}/{topic_id}/{question_id}/...
        "report": re.compile(rf"^{escaped_prefix}/reports/(\d+)/(\d+)/(\d+)/"),
        # {prefix}/exam/{user_id}/{topic_id}/{question_id}/{slot}/... or
        # {prefix}/exam/{user_id}/{topic_id}/{question_id}/{timestamp}/...
        "exam": re.compile(rf"^{escaped_prefix}/exam/(\d+)/(\d+)/(\d+)/[^/]+/"),
        # {prefix}/topics/{topic_id}/{slot}/{filename} (topic-level attachments like intro video)
        "topic": re.compile(rf"^{escaped_prefix}/topics/(\d+)/[^/]+/[^/]+"),
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

    # Check exam attachment pattern
    match = path_patterns["exam"].match(s3_path)
    if match:
        user_id = int(match.group(1))
        topic_id = int(match.group(2))
        topic = topic_service.get(db, topic_id)
        if topic:
            # User can download their own exam attachments
            if user_id == current_user.id:
                return True
            # Graders can download exam attachments
            return permission_service.can_grade(db, topic, current_user.id)
        return False

    # Check topic attachment pattern (e.g., intro video)
    match = path_patterns["topic"].match(s3_path)
    if match:
        topic_id = int(match.group(1))
        topic = topic_service.get(db, topic_id)
        if topic:
            # Anyone who can view the topic can access topic-level attachments
            return permission_service.can_view_topic(db, topic, current_user.id)
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

    # Handle potential '+' to space conversion issue
    # Some URL encodings use '+' for space, but FastAPI may not decode it
    s3_path_normalized = s3_path.replace("+", " ")

    # Verify permission
    if not _verify_download_permission(s3_path_normalized, current_user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to download this file",
        )

    # Get file info first to check existence and get size
    file_info = storage_service.get_file_info(s3_path_normalized)
    if file_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Get file stream
    file_stream = storage_service.get_stream(s3_path_normalized)
    if file_stream is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Extract filename from normalized path
    filename = s3_path_normalized.split("/")[-1]

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


@router.get("/files/stream")
def stream_file(
    request: Request,
    s3_path: str = Query(..., description="S3 storage path of the file"),
    token: str = Query(
        None, description="JWT token for authentication (for video/audio tags)"
    ),
    db: Session = Depends(get_db),
):
    """
    Stream a file through backend proxy for inline viewing (no S3 URL exposure).

    Supports HTTP Range requests for video seeking/scrubbing.
    Unlike download, this endpoint uses Content-Disposition: inline
    to allow in-browser playback of media files (video, audio, images, etc.)

    Authentication: Supports both Authorization header and query parameter token.
    The query parameter is needed for HTML5 video/audio tags which cannot set headers.

    Permission is verified based on the S3 path pattern (same as download).

    Returns the file content as a streaming response for inline viewing.
    """
    # Authenticate user - try query token first (for video tags), then header
    current_user = None
    if token:
        current_user = security.get_current_user_from_token(token, db)
    if not current_user:
        # Try to get from Authorization header
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            header_token = auth_header[7:]
            current_user = security.get_current_user_from_token(header_token, db)

    if not current_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        )

    storage_service = get_storage_service()

    # Handle potential '+' to space conversion issue
    # Some URL encodings use '+' for space, but FastAPI may not decode it
    s3_path_normalized = s3_path.replace("+", " ")

    # Verify permission (use normalized path)
    if not _verify_download_permission(s3_path_normalized, current_user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to preview this file",
        )

    # Get file info first to check existence and get size (use normalized path)
    file_info = storage_service.get_file_info(s3_path_normalized)
    if file_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    file_size = file_info.get("size", 0)

    # Extract filename from normalized path
    filename = s3_path_normalized.split("/")[-1]

    # Determine content type
    content_type = file_info.get("content_type", "application/octet-stream")
    if content_type == "application/octet-stream" and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        content_type_map = {
            # Video types
            "mp4": "video/mp4",
            "webm": "video/webm",
            "mov": "video/quicktime",
            "avi": "video/x-msvideo",
            "mkv": "video/x-matroska",
            # Image types
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "gif": "image/gif",
            "svg": "image/svg+xml",
            "webp": "image/webp",
            # Audio types
            "mp3": "audio/mpeg",
            "wav": "audio/wav",
            "ogg": "audio/ogg",
            # Document types (for inline viewing)
            "pdf": "application/pdf",
            "txt": "text/plain",
            "md": "text/markdown",
        }
        content_type = content_type_map.get(ext, content_type)

    # RFC 5987 encoding for non-ASCII filenames
    encoded_filename = quote(filename, safe="")
    content_disposition = (
        f'inline; filename="{encoded_filename}"; '
        f"filename*=UTF-8''{encoded_filename}"
    )

    # Parse Range header for partial content requests
    range_header = request.headers.get("range")

    if range_header:
        # Parse range header: "bytes=start-end" or "bytes=start-"
        try:
            range_spec = range_header.replace("bytes=", "")
            if "-" in range_spec:
                parts = range_spec.split("-")
                start = int(parts[0]) if parts[0] else 0
                end = int(parts[1]) if parts[1] else file_size - 1
            else:
                start = int(range_spec)
                end = file_size - 1

            # Validate range
            if start >= file_size:
                return Response(
                    status_code=416,  # Range Not Satisfiable
                    headers={"Content-Range": f"bytes */{file_size}"},
                )

            # Clamp end to file size
            end = min(end, file_size - 1)
            content_length = end - start + 1

            # Get range stream
            file_stream = storage_service.get_range_stream(
                s3_path_normalized, start, end
            )
            if file_stream is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="File not found",
                )

            # Return 206 Partial Content
            return StreamingResponse(
                file_stream,
                status_code=206,
                media_type=content_type,
                headers={
                    "Content-Disposition": content_disposition,
                    "Content-Length": str(content_length),
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                },
            )

        except (ValueError, IndexError):
            # Invalid range header, fall back to full file
            pass

    # No range request or invalid range - return full file
    file_stream = storage_service.get_stream(s3_path_normalized)
    if file_stream is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    return StreamingResponse(
        file_stream,
        media_type=content_type,
        headers={
            "Content-Disposition": content_disposition,
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes",
        },
    )


# ============================================================================
# File content endpoint (for reading text files)
# ============================================================================


@router.get("/files/content", response_class=PlainTextResponse)
def get_file_content(
    s3_path: str = Query(..., description="S3 storage path of the file"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get file content as text through backend proxy (no S3 URL exposure).

    This endpoint is specifically designed for reading text file content
    (like supplementary notes) back into the UI for editing.

    Permission is verified based on the S3 path pattern (same as download).

    Returns the file content as plain text (no JSON wrapping).
    """
    storage_service = get_storage_service()

    # Handle potential '+' to space conversion issue
    s3_path_normalized = s3_path.replace("+", " ")

    # Verify permission (same as download)
    if not _verify_download_permission(s3_path_normalized, current_user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to access this file",
        )

    # Get file info first to check existence
    file_info = storage_service.get_file_info(s3_path_normalized)
    if file_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Get file stream
    file_stream = storage_service.get_stream(s3_path_normalized)
    if file_stream is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Read file content
    try:
        content_bytes = b"".join(file_stream)
        # Try to decode as UTF-8
        content = content_bytes.decode("utf-8")
    except UnicodeDecodeError:
        # If not valid UTF-8, return as base64 or raise error
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is not a valid text file",
        )
    except Exception as e:
        logger.error(f"[Evaluation] Failed to read file content: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to read file content",
        )

    # Return content as plain text (no JSON wrapping)
    return PlainTextResponse(content=content)
