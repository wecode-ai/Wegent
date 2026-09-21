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

from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.adapter.attachments import (
    _ensure_attachment_access,
    _require_attachment_download_allowed,
    _stream_external_attachment,
    _stream_remote_media,
    _stream_stored_attachment,
)
from app.core.security import AuthContext, get_api_key_from_header, get_auth_context
from app.models.subtask_context import ContextType, SubtaskContext
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


def get_api_key_auth_context(
    api_key: Annotated[str, Depends(get_api_key_from_header)],
    auth_context: Annotated[AuthContext, Depends(get_auth_context)],
) -> AuthContext:
    """Require API-key authentication for external attachment downloads."""
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key is required",
        )
    return auth_context


def _get_attachment_context_for_api_key(
    db: Session,
    attachment_id: int,
    auth_context: AuthContext,
) -> SubtaskContext:
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
    )
    if context is None or context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Attachment not found",
        )

    try:
        _ensure_attachment_access(db, context, auth_context.user)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied",
            ) from exc
        raise

    return context


def _generated_video_url(context: SubtaskContext) -> Optional[str]:
    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    video_metadata = type_data.get("video_metadata")
    if not isinstance(video_metadata, dict):
        return None
    video_url = video_metadata.get("video_url")
    return video_url if isinstance(video_url, str) and video_url else None


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
    - XMind (.xmind)
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


@router.get("/{attachment_id}/download")
@trace_async("download_attachment_open", "attachments.api")
async def download_attachment_open(
    attachment_id: int,
    auth_context: Annotated[AuthContext, Depends(get_api_key_auth_context)],
    db: Annotated[Session, Depends(get_db)],
    range_header: Optional[str] = Header(None, alias="Range"),
):
    """
    Download an attachment through the external API.

    This endpoint only accepts API-key authentication. It supports personal API
    keys and service API keys with wegent-username, then applies the same
    attachment access checks as the logged-in product download path.
    """
    context = _get_attachment_context_for_api_key(db, attachment_id, auth_context)
    _require_attachment_download_allowed(db, context, "download")

    external_response = await _stream_external_attachment(
        context,
        range_header=range_header,
    )
    if external_response is not None:
        return external_response

    video_url = _generated_video_url(context)
    if video_url:
        logger.info(
            "[attachments_open.py] Streaming remote video attachment: "
            "attachment_id=%s",
            attachment_id,
        )
        return await _stream_remote_media(
            video_url,
            context.original_filename,
            default_media_type=context.mime_type or "video/mp4",
            range_header=range_header,
        )

    return await _stream_stored_attachment(context)
