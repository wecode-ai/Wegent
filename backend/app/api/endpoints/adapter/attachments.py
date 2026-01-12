# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment API endpoints for file upload and management.

Uses the unified context service for managing attachments as subtask contexts.
"""

import logging
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask_context import ContextType
from app.models.user import User
from app.schemas.subtask_context import (
    AttachmentDetailResponse,
    AttachmentResponse,
    TruncationInfo,
)
from app.services.attachment.parser import DocumentParseError, DocumentParser
from app.services.context import context_service

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/upload", response_model=AttachmentResponse)
async def upload_attachment(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Upload a document file for chat attachment.

    Supported file types:
    - PDF (.pdf)
    - Word (.doc, .docx)
    - PowerPoint (.ppt, .pptx)
    - Excel (.xls, .xlsx, .csv)
    - Plain text (.txt)
    - Markdown (.md)
    - Images (.jpg, .jpeg, .png, .gif, .bmp, .webp)

    Limits:
    - Maximum file size: 100 MB
    - Maximum extracted text: 1,500,000 characters (auto-truncated if exceeded)

    Returns:
        Attachment details including ID, processing status, and truncation info
    """
    logger.info(
        f"[attachments.py] upload_attachment: user_id={current_user.id}, filename={file.filename}"
    )

    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required")

    # Read file content using chunked streaming to avoid loading
    # entire file into memory (important for multi-worker deployments)
    try:
        CHUNK_SIZE = 1024 * 1024  # 1MB chunks
        chunks = []
        file_size = 0
        while chunk := await file.read(CHUNK_SIZE):
            file_size += len(chunk)
            # Check size during streaming to fail fast
            if not DocumentParser.validate_file_size(file_size):
                max_size_mb = DocumentParser.get_max_file_size() / (1024 * 1024)
                raise HTTPException(
                    status_code=400,
                    detail=f"File size exceeds maximum limit ({max_size_mb} MB)",
                )
            chunks.append(chunk)
        binary_data = b"".join(chunks)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading uploaded file: {e}")
        raise HTTPException(
            status_code=400, detail="Failed to read uploaded file"
        ) from e

    try:
        context, truncation_info = context_service.upload_attachment(
            db=db,
            user_id=current_user.id,
            filename=file.filename,
            binary_data=binary_data,
        )

        # Build truncation info for response
        response_truncation_info = None
        if truncation_info and truncation_info.is_truncated:
            response_truncation_info = TruncationInfo(
                is_truncated=True,
                original_length=truncation_info.original_length,
                truncated_length=truncation_info.truncated_length,
                truncation_message_key="content_truncated",
            )

        return AttachmentResponse(
            id=context.id,
            filename=context.original_filename,
            file_size=context.file_size,
            mime_type=context.mime_type,
            status=(
                context.status
                if isinstance(context.status, str)
                else context.status.value
            ),
            file_extension=context.file_extension,
            text_length=context.text_length,
            error_message=context.error_message,
            truncation_info=response_truncation_info,
            created_at=context.created_at,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except DocumentParseError as e:
        # Return error with error_code for i18n mapping
        error_code = getattr(e, "error_code", None)
        raise HTTPException(
            status_code=400,
            detail={
                "message": str(e),
                "error_code": error_code,
            },
        ) from e
    except Exception as e:
        logger.error(f"Error uploading attachment: {e}", exc_info=True)
        raise HTTPException(
            status_code=500, detail="Failed to upload attachment"
        ) from e


@router.get("/{attachment_id}", response_model=AttachmentDetailResponse)
async def get_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get attachment details by ID.

    Returns:
        Attachment details including status and metadata
    """
    # Get context without user_id filter first
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
    )

    if context is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Verify it's an attachment type
    if context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Check access permission:
    # 1. User is the uploader
    # 2. User is the task owner
    # 3. User is a member of the task that contains this attachment
    has_access = context.user_id == current_user.id

    if not has_access and context.subtask_id > 0:
        # Check if user is a task owner or member
        from app.models.subtask import Subtask
        from app.models.task import TaskResource
        from app.models.task_member import MemberStatus, TaskMember

        subtask = db.query(Subtask).filter(Subtask.id == context.subtask_id).first()
        if subtask:
            # Check if user is the task owner
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == subtask.task_id,
                    TaskResource.kind == "Task",
                    TaskResource.user_id == current_user.id,
                )
                .first()
            )
            if task:
                has_access = True
            else:
                # Check if user is a task member
                task_member = (
                    db.query(TaskMember)
                    .filter(
                        TaskMember.task_id == subtask.task_id,
                        TaskMember.user_id == current_user.id,
                        TaskMember.status == MemberStatus.ACTIVE,
                    )
                    .first()
                )
                has_access = task_member is not None

    if not has_access:
        raise HTTPException(status_code=404, detail="Attachment not found")

    return AttachmentDetailResponse.from_context(context)


@router.get("/{attachment_id}/download")
async def download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Download the original file.

    Returns:
        File binary data with appropriate content type
    """
    # Get context without user_id filter first
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
    )
    if context is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Verify it's an attachment type
    if context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Check access permission:
    # 1. User is the uploader
    # 2. User is the task owner
    # 3. User is a member of the task that contains this attachment
    has_access = context.user_id == current_user.id

    if not has_access and context.subtask_id > 0:
        # Check if user is a task owner or member
        from app.models.subtask import Subtask
        from app.models.task import TaskResource
        from app.models.task_member import MemberStatus, TaskMember

        subtask = db.query(Subtask).filter(Subtask.id == context.subtask_id).first()
        if subtask:
            # Check if user is the task owner
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == subtask.task_id,
                    TaskResource.kind == "Task",
                    TaskResource.user_id == current_user.id,
                )
                .first()
            )
            if task:
                has_access = True
            else:
                # Check if user is a task member
                task_member = (
                    db.query(TaskMember)
                    .filter(
                        TaskMember.task_id == subtask.task_id,
                        TaskMember.user_id == current_user.id,
                        TaskMember.status == MemberStatus.ACTIVE,
                    )
                    .first()
                )
                has_access = task_member is not None

    if not has_access:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Get binary data from the appropriate storage backend
    binary_data = context_service.get_attachment_binary_data(
        db=db,
        context=context,
    )

    if binary_data is None:
        logger.error(
            f"Failed to retrieve binary data for attachment {attachment_id}, "
            f"storage_backend={context.storage_backend}, "
            f"storage_key={context.storage_key}"
        )
        raise HTTPException(
            status_code=500, detail="Failed to retrieve attachment data"
        )

    # Encode filename for Content-Disposition header to support non-ASCII characters
    # Use RFC 5987 encoding: filename*=UTF-8''encoded_filename
    encoded_filename = quote(context.original_filename)

    return Response(
        content=binary_data,
        media_type=context.mime_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"
        },
    )


@router.get("/{attachment_id}/executor-download")
async def executor_download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Download attachment for executor.

    This endpoint is called by the Executor to download attachments
    to the workspace. It uses JWT token authentication and validates
    that the attachment belongs to the current user.

    Returns:
        File binary data with appropriate content type
    """
    # Get context and verify ownership
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
        user_id=current_user.id,
    )

    if context is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Verify it's an attachment type
    if context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Get binary data from the appropriate storage backend
    binary_data = context_service.get_attachment_binary_data(
        db=db,
        context=context,
    )

    if binary_data is None:
        logger.error(
            f"Failed to retrieve binary data for attachment {attachment_id}, "
            f"storage_backend={context.storage_backend}, "
            f"storage_key={context.storage_key}"
        )
        raise HTTPException(
            status_code=500, detail="Failed to retrieve attachment data"
        )

    # Encode filename for Content-Disposition header
    encoded_filename = quote(context.original_filename)

    return Response(
        content=binary_data,
        media_type=context.mime_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"
        },
    )


@router.delete("/{attachment_id}")
async def delete_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete an attachment.

    Only attachments that are not linked to a subtask can be deleted.

    Returns:
        Success message
    """
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
        user_id=current_user.id,
    )

    if context is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Verify it's an attachment type
    if context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # subtask_id == 0 means unlinked, > 0 means linked to a subtask
    if context.subtask_id > 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete attachment that is linked to a message",
        )

    success = context_service.delete_context(
        db=db,
        context_id=attachment_id,
        user_id=current_user.id,
    )

    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete attachment")

    return {"message": "Attachment deleted successfully"}


@router.get("/subtask/{subtask_id}", response_model=Optional[AttachmentDetailResponse])
async def get_attachment_by_subtask(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get attachment by subtask ID.

    Returns:
        Attachment details or null if no attachment exists
    """
    context = context_service.get_attachment_by_subtask(
        db=db,
        subtask_id=subtask_id,
    )

    if context is None:
        return None

    # Verify ownership
    if context.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    return AttachmentDetailResponse.from_context(context)
