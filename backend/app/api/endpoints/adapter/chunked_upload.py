# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chunked upload API endpoints for handling large file uploads.

Provides endpoints for:
- Initializing chunked uploads
- Uploading individual chunks
- Completing/finalizing uploads
- Aborting uploads
- Checking upload status
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.subtask_context import AttachmentResponse, TruncationInfo
from app.services.attachment.chunked_upload import (
    CHUNK_SIZE,
    ChunkedUploadError,
    chunked_upload_service,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class ChunkedUploadInitRequest(BaseModel):
    """Request to initialize a chunked upload."""

    filename: str = Field(..., description="Original filename")
    file_size: int = Field(..., gt=0, description="Total file size in bytes")
    chunk_size: Optional[int] = Field(
        None, ge=1024 * 1024, le=10 * 1024 * 1024, description="Chunk size (1-10MB)"
    )


class ChunkedUploadInitResponse(BaseModel):
    """Response for chunked upload initialization."""

    upload_id: str = Field(..., description="Unique upload session ID")
    total_chunks: int = Field(..., description="Number of chunks to upload")
    chunk_size: int = Field(..., description="Size of each chunk in bytes")


class ChunkUploadResponse(BaseModel):
    """Response for chunk upload."""

    chunk_index: int = Field(..., description="Index of uploaded chunk")
    received_chunks: int = Field(..., description="Total received chunks")
    total_chunks: int = Field(..., description="Total chunks expected")
    progress_percent: float = Field(..., description="Upload progress percentage")


class UploadStatusResponse(BaseModel):
    """Response for upload status check."""

    upload_id: str
    filename: str
    file_size: int
    total_chunks: int
    received_chunks: int
    missing_chunks: list[int]
    progress_percent: float
    created_at: float
    last_updated: float


def _build_attachment_response(
    context,
    truncation_info: Optional[TruncationInfo],
) -> AttachmentResponse:
    """Build attachment response from context."""
    response_truncation_info = None
    if truncation_info and truncation_info.is_truncated:
        response_truncation_info = TruncationInfo(
            is_truncated=True,
            original_length=truncation_info.original_length,
            truncated_length=truncation_info.truncated_length,
            truncation_message_key="content_truncated",
        )

    return AttachmentResponse.from_context(context, response_truncation_info)


@router.post("/init", response_model=ChunkedUploadInitResponse)
async def init_chunked_upload(
    request: ChunkedUploadInitRequest,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
):
    """
    Initialize a chunked upload session.

    This endpoint must be called before uploading any chunks.
    Returns an upload_id that must be used for subsequent chunk uploads.

    Limits:
    - Maximum file size: 100 MB
    - Maximum concurrent uploads per user: 10
    - Upload session expires after 24 hours

    Args:
        request: Upload initialization request with filename and file size

    Returns:
        Upload session details including upload_id and chunk configuration
    """
    logger.info(
        f"[chunked_upload] init: user_id={current_user.id}, "
        f"filename={request.filename}, file_size={request.file_size}"
    )

    try:
        chunk_size = request.chunk_size or CHUNK_SIZE
        upload_id, total_chunks, actual_chunk_size = (
            chunked_upload_service.init_chunked_upload(
                user_id=current_user.id,
                filename=request.filename,
                file_size=request.file_size,
                chunk_size=chunk_size,
            )
        )

        return ChunkedUploadInitResponse(
            upload_id=upload_id,
            total_chunks=total_chunks,
            chunk_size=actual_chunk_size,
        )

    except ChunkedUploadError as e:
        logger.warning(f"[chunked_upload] init failed: {e.message}")
        raise HTTPException(
            status_code=400,
            detail={"message": e.message, "error_code": e.error_code},
        ) from e
    except Exception as e:
        logger.exception(f"[chunked_upload] init error: {e}")
        raise HTTPException(
            status_code=500, detail="Failed to initialize upload"
        ) from e


@router.post("/{upload_id}/chunk", response_model=ChunkUploadResponse)
async def upload_chunk(
    upload_id: str,
    chunk_index: int = Form(..., ge=0, description="Index of this chunk (0-based)"),
    checksum: Optional[str] = Form(None, description="MD5 checksum for verification"),
    chunk: UploadFile = File(..., description="Chunk binary data"),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
):
    """
    Upload a single chunk of the file.

    Chunks can be uploaded in any order, but all chunks must be
    uploaded before calling the complete endpoint.

    Args:
        upload_id: Upload session ID from init
        chunk_index: Index of this chunk (0-based)
        checksum: Optional MD5 checksum for verification
        chunk: Chunk binary data

    Returns:
        Upload progress information
    """
    try:
        chunk_data = await chunk.read()

        received_count, total_chunks = chunked_upload_service.upload_chunk(
            upload_id=upload_id,
            user_id=current_user.id,
            chunk_index=chunk_index,
            chunk_data=chunk_data,
            checksum=checksum,
        )

        progress = round(received_count / total_chunks * 100, 1)

        return ChunkUploadResponse(
            chunk_index=chunk_index,
            received_chunks=received_count,
            total_chunks=total_chunks,
            progress_percent=progress,
        )

    except ChunkedUploadError as e:
        logger.warning(
            f"[chunked_upload] chunk upload failed: upload_id={upload_id}, "
            f"chunk_index={chunk_index}, error={e.message}"
        )
        raise HTTPException(
            status_code=400,
            detail={"message": e.message, "error_code": e.error_code},
        ) from e
    except Exception as e:
        logger.exception(
            f"[chunked_upload] chunk upload error: upload_id={upload_id}, "
            f"chunk_index={chunk_index}"
        )
        raise HTTPException(status_code=500, detail="Failed to upload chunk") from e


@router.post("/{upload_id}/complete", response_model=AttachmentResponse)
async def complete_chunked_upload(
    upload_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
):
    """
    Complete the chunked upload and create the attachment.

    This endpoint assembles all uploaded chunks, processes the file,
    and creates the attachment record. All chunks must be uploaded
    before calling this endpoint.

    Args:
        upload_id: Upload session ID from init

    Returns:
        Attachment details including ID and processing status
    """
    logger.info(
        f"[chunked_upload] completing: upload_id={upload_id}, user_id={current_user.id}"
    )

    try:
        context, truncation_info = chunked_upload_service.complete_chunked_upload(
            db=db,
            upload_id=upload_id,
            user_id=current_user.id,
        )

        return _build_attachment_response(context, truncation_info)

    except ChunkedUploadError as e:
        logger.warning(
            f"[chunked_upload] complete failed: upload_id={upload_id}, "
            f"error={e.message}"
        )
        raise HTTPException(
            status_code=400,
            detail={"message": e.message, "error_code": e.error_code},
        ) from e
    except Exception as e:
        logger.exception(f"[chunked_upload] complete error: upload_id={upload_id}")
        raise HTTPException(status_code=500, detail="Failed to complete upload") from e


@router.delete("/{upload_id}/abort")
async def abort_chunked_upload(
    upload_id: str,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
):
    """
    Abort a chunked upload and cleanup resources.

    Use this endpoint to cancel an in-progress upload and free up
    server resources.

    Args:
        upload_id: Upload session ID from init

    Returns:
        Success message
    """
    logger.info(
        f"[chunked_upload] aborting: upload_id={upload_id}, user_id={current_user.id}"
    )

    try:
        chunked_upload_service.abort_chunked_upload(
            upload_id=upload_id,
            user_id=current_user.id,
        )

        return {"message": "Upload aborted successfully"}

    except ChunkedUploadError as e:
        logger.warning(
            f"[chunked_upload] abort failed: upload_id={upload_id}, "
            f"error={e.message}"
        )
        raise HTTPException(
            status_code=400,
            detail={"message": e.message, "error_code": e.error_code},
        ) from e
    except Exception as e:
        logger.exception(f"[chunked_upload] abort error: upload_id={upload_id}")
        raise HTTPException(status_code=500, detail="Failed to abort upload") from e


@router.get("/{upload_id}/status", response_model=UploadStatusResponse)
async def get_upload_status(
    upload_id: str,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
):
    """
    Get the status of a chunked upload.

    Returns information about upload progress, including which chunks
    have been received and which are still missing.

    Args:
        upload_id: Upload session ID from init

    Returns:
        Upload status information
    """
    try:
        status = chunked_upload_service.get_upload_status(
            upload_id=upload_id,
            user_id=current_user.id,
        )

        return UploadStatusResponse(**status)

    except ChunkedUploadError as e:
        logger.warning(
            f"[chunked_upload] status failed: upload_id={upload_id}, "
            f"error={e.message}"
        )
        raise HTTPException(
            status_code=400,
            detail={"message": e.message, "error_code": e.error_code},
        ) from e
    except Exception as e:
        logger.exception(f"[chunked_upload] status error: upload_id={upload_id}")
        raise HTTPException(
            status_code=500, detail="Failed to get upload status"
        ) from e
