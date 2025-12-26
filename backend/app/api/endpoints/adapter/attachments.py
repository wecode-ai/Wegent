# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment API endpoints for file upload and management.
"""

import logging
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.attachment import (
    AttachmentDetailResponse,
    AttachmentResponse,
    TruncationInfo,
)
from app.services.attachment import attachment_service
from app.services.attachment.parser import DocumentParseError, DocumentParser

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

    # Read file content
    try:
        binary_data = await file.read()
    except Exception as e:
        logger.error(f"Error reading uploaded file: {e}")
        raise HTTPException(
            status_code=400, detail="Failed to read uploaded file"
        ) from e

    # Validate file size before processing
    if not DocumentParser.validate_file_size(len(binary_data)):
        max_size_mb = DocumentParser.get_max_file_size() / (1024 * 1024)
        raise HTTPException(
            status_code=400,
            detail=f"File size exceeds maximum limit ({max_size_mb} MB)",
        )

    try:
        attachment, truncation_info = attachment_service.upload_attachment(
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
            id=attachment.id,
            filename=attachment.original_filename,
            file_size=attachment.file_size,
            mime_type=attachment.mime_type,
            status=attachment.status.value,
            text_length=attachment.text_length,
            error_message=attachment.error_message,
            truncation_info=response_truncation_info,
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
    # Get attachment without user_id filter first
    attachment = attachment_service.get_attachment(
        db=db,
        attachment_id=attachment_id,
    )

    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Check access permission:
    # 1. User is the uploader
    # 2. User is the task owner
    # 3. User is a member of the task that contains this attachment
    has_access = attachment.user_id == current_user.id

    if not has_access and attachment.subtask_id > 0:
        # Check if user is a task owner or member
        from app.models.kind import Kind
        from app.models.subtask import Subtask
        from app.models.task_member import MemberStatus, TaskMember

        subtask = db.query(Subtask).filter(Subtask.id == attachment.subtask_id).first()
        if subtask:
            # Check if user is the task owner
            task = (
                db.query(Kind)
                .filter(
                    Kind.id == subtask.task_id,
                    Kind.kind == "Task",
                    Kind.user_id == current_user.id,
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

    return AttachmentDetailResponse(
        id=attachment.id,
        filename=attachment.original_filename,
        file_size=attachment.file_size,
        mime_type=attachment.mime_type,
        status=attachment.status.value,
        text_length=attachment.text_length,
        error_message=attachment.error_message,
        subtask_id=attachment.subtask_id,
        file_extension=attachment.file_extension,
        created_at=attachment.created_at.isoformat() if attachment.created_at else "",
    )


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
    # Get attachment without user_id filter first
    attachment = attachment_service.get_attachment(
        db=db,
        attachment_id=attachment_id,
    )
    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Check access permission:
    # 1. User is the uploader
    # 2. User is the task owner
    # 3. User is a member of the task that contains this attachment
    has_access = attachment.user_id == current_user.id

    if not has_access and attachment.subtask_id > 0:
        # Check if user is a task owner or member
        from app.models.kind import Kind
        from app.models.subtask import Subtask
        from app.models.task_member import MemberStatus, TaskMember

        subtask = db.query(Subtask).filter(Subtask.id == attachment.subtask_id).first()
        if subtask:
            # Check if user is the task owner
            task = (
                db.query(Kind)
                .filter(
                    Kind.id == subtask.task_id,
                    Kind.kind == "Task",
                    Kind.user_id == current_user.id,
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
    # For MySQL storage, this returns attachment.binary_data
    # For external storage (MinIO/S3), this retrieves from the storage backend
    binary_data = attachment_service.get_attachment_binary_data(
        db=db,
        attachment=attachment,
    )

    if binary_data is None:
        logger.error(
            f"Failed to retrieve binary data for attachment {attachment_id}, "
            f"storage_backend={attachment.storage_backend}, "
            f"storage_key={attachment.storage_key}"
        )
        raise HTTPException(
            status_code=500, detail="Failed to retrieve attachment data"
        )

    # Encode filename for Content-Disposition header to support non-ASCII characters
    # Use RFC 5987 encoding: filename*=UTF-8''encoded_filename
    encoded_filename = quote(attachment.original_filename)

    return Response(
        content=binary_data,
        media_type=attachment.mime_type,
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
    attachment = attachment_service.get_attachment(
        db=db,
        attachment_id=attachment_id,
        user_id=current_user.id,
    )

    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # subtask_id == 0 means unlinked, > 0 means linked to a subtask
    if attachment.subtask_id > 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete attachment that is linked to a message",
        )

    success = attachment_service.delete_attachment(
        db=db,
        attachment_id=attachment_id,
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
    attachment = attachment_service.get_attachment_by_subtask(
        db=db,
        subtask_id=subtask_id,
    )

    if attachment is None:
        return None

    # Verify ownership
    if attachment.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    return AttachmentDetailResponse(
        id=attachment.id,
        filename=attachment.original_filename,
        file_size=attachment.file_size,
        mime_type=attachment.mime_type,
        status=attachment.status.value,
        text_length=attachment.text_length,
        error_message=attachment.error_message,
        subtask_id=attachment.subtask_id,
        file_extension=attachment.file_extension,
        created_at=attachment.created_at.isoformat() if attachment.created_at else "",
    )
