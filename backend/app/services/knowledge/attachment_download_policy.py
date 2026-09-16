# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge-document policy checks for generic attachment binary exits."""

from typing import Literal

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.services.knowledge.document_download_policy import (
    require_document_download_allowed,
)

AttachmentAccessPurpose = Literal[
    "download", "playback", "executor", "share", "preview"
]

# Extensions the source-file previewer renders inline. A "preview" purpose is
# only honoured for these, so it cannot become a generic bypass of the download
# policy for arbitrary attachments.
PREVIEWABLE_SOURCE_EXTENSIONS = frozenset({"pdf", "doc", "docx", "xls", "xlsx", "pptx"})


def _normalize_extension(file_extension: str | None) -> str | None:
    normalized = (file_extension or "").strip().lstrip(".").lower()
    return normalized or None


def require_attachment_download_allowed(
    db: Session,
    *,
    attachment_id: int,
    mime_type: str | None,
    purpose: AttachmentAccessPurpose,
    file_extension: str | None = None,
) -> None:
    """Apply KB original-file policy only to attachments linked to a document.

    Unrelated task, chat, and ordinary attachments intentionally leave through the
    existing attachment flow. Historical duplicate links retain the old first-row
    behaviour, but make it deterministic for every database backend.
    """
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.attachment_id == attachment_id)
        .order_by(KnowledgeDocument.id)
        .first()
    )
    if document is None:
        return

    normalized_mime_type = (mime_type or "").lower()
    if purpose == "playback" and normalized_mime_type.startswith(("image/", "video/")):
        return

    if purpose == "preview":
        extension = _normalize_extension(file_extension) or _normalize_extension(
            document.file_extension
        )
        if extension in PREVIEWABLE_SOURCE_EXTENSIONS:
            # Source previews fetch the same bytes as a download would; for the
            # types the previewer renders, reading them is allowed even when
            # the knowledge base forbids original-file downloads.
            return

    knowledge_base = (
        db.query(Kind)
        .filter(
            Kind.id == document.kind_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if knowledge_base is None:
        return

    require_document_download_allowed(db, knowledge_base)
