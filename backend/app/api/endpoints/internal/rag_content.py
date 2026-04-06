# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal attachment streaming endpoint for knowledge_runtime."""

from __future__ import annotations

import logging
from collections.abc import Iterator

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.adapter.attachments import _build_content_disposition
from app.models.subtask_context import ContextStatus, ContextType
from app.services.auth import extract_token_from_header
from app.services.auth.rag_download_token import verify_rag_download_token
from app.services.context import context_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rag/content", tags=["internal-rag-content"])


def _binary_stream(binary_data: bytes) -> Iterator[bytes]:
    yield binary_data


def _verify_rag_download_authorization(
    attachment_id: int,
    authorization: str = Header(default=""),
) -> None:
    """Validate Bearer token for internal RAG attachment download."""

    token = extract_token_from_header(authorization)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
        )

    token_info = verify_rag_download_token(token)
    if token_info is None or token_info.attachment_id != attachment_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid RAG download token",
        )


@router.get("/{attachment_id}")
async def stream_rag_attachment_content(
    attachment_id: int,
    _: None = Depends(_verify_rag_download_authorization),
    db: Session = Depends(get_db),
):
    """Stream attachment binary content for knowledge_runtime."""

    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
    )
    if context is None or context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if context.status != ContextStatus.READY.value:
        raise HTTPException(status_code=409, detail="Attachment is not ready")

    binary_data = context_service.get_attachment_binary_data(
        db=db,
        context=context,
    )
    if binary_data is None:
        logger.error(
            "Failed to retrieve binary data for internal RAG attachment %s",
            attachment_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve attachment data",
        )

    return StreamingResponse(
        _binary_stream(binary_data),
        media_type=context.mime_type,
        headers={
            "Content-Disposition": _build_content_disposition(context.original_filename)
        },
    )
