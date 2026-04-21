# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Open API endpoints for attachment upload.

These endpoints are designed for external callers and support flexible
authentication via personal API keys or service API keys with the
wegent-username header. Uses the unified context service for managing
attachments as subtask contexts.
"""

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import AuthContext, get_auth_context
from app.models.subtask_context import SubtaskContext
from app.schemas.subtask_context import AttachmentResponse, TruncationInfo
from app.services.attachment.parser import DocumentParseError, DocumentParser
from app.services.context import context_service
from app.services.context.context_service import NotFoundException
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

router = APIRouter()

# Constants for attachment upload
UPLOAD_CHUNK_SIZE_BYTES = 8192  # 8KB chunks for streaming read
BYTES_PER_MIB = 1024 * 1024
UNLINKED_SUBTASK_ID = 0  # subtask_id=0 indicates unlinked attachment


def _build_attachment_response(
    context: SubtaskContext,
    truncation_info: Optional[TruncationInfo],
) -> AttachmentResponse:
    """Build AttachmentResponse from context and truncation info."""
    response_truncation_info = None
    if truncation_info and truncation_info.is_truncated:
        response_truncation_info = TruncationInfo(
            is_truncated=True,
            original_length=truncation_info.original_length,
            truncated_length=truncation_info.truncated_length,
            truncation_message_key="content_truncated",
        )

    return AttachmentResponse.from_context(context, response_truncation_info)


@router.post(
    "/upload",
    response_model=AttachmentResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_async("upload_attachment_open", "attachments.api")
async def upload_attachment_open(
    file: Annotated[UploadFile, File(...)],
    auth_context: Annotated[AuthContext, Depends(get_auth_context)],
    db: Annotated[Session, Depends(get_db)],
) -> AttachmentResponse:
    """
    Upload a document file for use with OpenAPI endpoints.

    This endpoint is designed for external callers and supports flexible
    authentication via API keys. Uploaded attachments can be referenced
    by their ID in subsequent API calls:
    - POST /v1/responses with attachment_ids
    - POST /knowledge/documents with source_type=attachment

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
    - Maximum extracted text: 500,000 characters (auto-truncated if exceeded)

    Authentication:
        - Personal API key: Uploads attachment under the key owner's account
        - Service API key: Requires wegent-username header to specify the target user

    Returns:
        Attachment details including ID, processing status, and truncation info.
        The attachment ID can be used to reference this file in other API calls.

    Example:
        ```python
        import requests

        # Upload file
        with open("document.pdf", "rb") as f:
            response = requests.post(
                "https://api.wegent.io/v1/attachments/upload",
                headers={"X-API-Key": "wg-..."},
                files={"file": f}
            )
        attachment_id = response.json()["id"]

        # Use in chat
        chat_response = requests.post(
            "https://api.wegent.io/v1/responses",
            headers={"X-API-Key": "wg-...", "Content-Type": "application/json"},
            json={
                "model": "default#my_team",
                "input": "Analyze this document",
                "attachment_ids": [attachment_id]
            }
        )
        ```
    """
    current_user = auth_context.user

    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Filename is required",
        )

    logger.info(
        f"[attachments_open.py] upload_attachment_open: user_id={current_user.id}, "
        f"filename=<redacted>"
    )

    # Stream file content with bounded size check
    binary_data = bytearray()
    max_file_size = DocumentParser.get_max_file_size()

    try:
        while chunk := await file.read(UPLOAD_CHUNK_SIZE_BYTES):
            binary_data.extend(chunk)
            # Check size after each chunk
            if len(binary_data) > max_file_size:
                max_size_mb = max_file_size / BYTES_PER_MIB
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"File size exceeds maximum limit ({max_size_mb} MB)",
                )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading uploaded file: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read uploaded file",
        ) from e

    try:
        # Upload attachment using context service (subtask_id=0 for unlinked attachments)
        # Convert bytearray to bytes for type consistency
        context, truncation_info = context_service.upload_attachment(
            db=db,
            user_id=current_user.id,
            filename=file.filename,
            binary_data=bytes(binary_data),
            subtask_id=UNLINKED_SUBTASK_ID,  # Unlinked attachment - will be linked later via API
        )

        logger.info(
            f"[attachments_open.py] Attachment uploaded: id={context.id}, "
            f"user_id={current_user.id}, filename=<redacted>"
        )

        return _build_attachment_response(context, truncation_info)

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
    except NotFoundException as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Attachment not found",
        ) from e
    except DocumentParseError as e:
        error_code = getattr(e, "error_code", None)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "message": str(e),
                "error_code": error_code,
            },
        ) from e
    except Exception as e:
        logger.error(f"Error uploading attachment: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to upload attachment",
        ) from e
