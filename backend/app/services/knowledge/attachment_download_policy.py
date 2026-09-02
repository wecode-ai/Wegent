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
    "download", "preview", "playback", "executor", "share"
]


def require_attachment_download_allowed(
    db: Session,
    *,
    attachment_id: int,
    mime_type: str | None,
    purpose: AttachmentAccessPurpose,
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
    if purpose in {"preview", "playback"} and normalized_mime_type.startswith(
        ("image/", "video/")
    ):
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
