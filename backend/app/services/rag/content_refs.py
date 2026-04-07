# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for generating content references for knowledge_runtime."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask_context import ContextType
from app.services.auth.rag_download_token import create_rag_download_token
from app.services.context import context_service
from shared.models import (
    BackendAttachmentStreamContentRef,
    PresignedUrlContentRef,
)

DEFAULT_CONTENT_REF_TTL_SECONDS = 300


def build_content_ref_for_attachment(
    *,
    db: Session,
    attachment_id: int,
    expires_delta_seconds: int = DEFAULT_CONTENT_REF_TTL_SECONDS,
) -> BackendAttachmentStreamContentRef | PresignedUrlContentRef:
    """Build a content reference for an attachment used by remote indexing."""

    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
    )
    if context is None or context.context_type != ContextType.ATTACHMENT.value:
        raise ValueError(f"Attachment {attachment_id} not found")

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_delta_seconds)
    presigned_url = context_service.get_attachment_url(
        db=db,
        context=context,
        expires=expires_delta_seconds,
    )
    if presigned_url:
        return PresignedUrlContentRef(
            kind="presigned_url",
            url=presigned_url,
            expires_at=expires_at,
        )

    auth_token = create_rag_download_token(
        attachment_id=attachment_id,
        expires_delta_seconds=expires_delta_seconds,
    )
    base_url = settings.BACKEND_INTERNAL_URL.rstrip("/")
    return BackendAttachmentStreamContentRef(
        kind="backend_attachment_stream",
        url=f"{base_url}{settings.API_PREFIX}/internal/rag/content/{attachment_id}",
        auth_token=auth_token,
        expires_at=expires_at,
    )
