# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External knowledge document access helpers."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import quote

import jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextType, SubtaskContext
from app.services.knowledge.knowledge_service import KnowledgeService

DOWNLOAD_TOKEN_HEADER = "X-Wegent-Download-Token"
DOCUMENT_DOWNLOAD_TOKEN_EXPIRES_SECONDS = 300
DOCUMENT_DOWNLOAD_TOKEN_TYPE = "external_knowledge_document_download"
ALLOWED_DOWNLOAD_DISPOSITIONS = frozenset({"inline", "attachment"})
INLINE_PREVIEW_MIME_TYPES = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "text/plain",
        "text/markdown",
        "text/csv",
    }
)


class ExternalDocumentAccessError(ValueError):
    """External document access error with a stable API error code."""

    def __init__(self, message: str, code: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class ExternalDocumentAccess:
    """Document access information for an external knowledge user."""

    document: KnowledgeDocument
    attachment: Optional[SubtaskContext]
    content_readable: bool
    downloadable: bool
    previewable: bool
    mime_type: Optional[str]
    file_name: str
    file_extension: Optional[str]
    file_size: Optional[int]

    @property
    def knowledge_base_id(self) -> int:
        return self.document.kind_id


@dataclass(frozen=True)
class DocumentDownloadToken:
    """Verified external document download token payload."""

    user_id: int
    document_id: int
    disposition: str


@dataclass(frozen=True)
class ExternalDocumentFile:
    """Resolved original document file for an external download request."""

    content: bytes
    media_type: str
    content_disposition: str


def normalize_disposition(disposition: str) -> str:
    """Normalize and validate a download disposition."""
    if not isinstance(disposition, str):
        raise ExternalDocumentAccessError("disposition must be a string", "bad_request")
    normalized = disposition.strip().lower()
    if normalized not in ALLOWED_DOWNLOAD_DISPOSITIONS:
        raise ExternalDocumentAccessError(
            "disposition must be either inline or attachment", "bad_request"
        )
    return normalized


def normalize_file_extension(file_extension: Optional[str]) -> Optional[str]:
    """Normalize external file extensions to a dotless representation."""
    normalized = (file_extension or "").strip().lstrip(".")
    return normalized or None


def build_content_disposition(disposition: str, file_name: str) -> str:
    """Build RFC 5987-compatible Content-Disposition for external downloads."""
    encoded_name = quote(file_name or "document", safe="")
    return (
        f"{disposition}; filename=\"{encoded_name}\"; filename*=UTF-8''{encoded_name}"
    )


def build_document_capabilities(
    document: KnowledgeDocument,
    attachment: Optional[SubtaskContext],
) -> ExternalDocumentAccess:
    """Build external metadata and capability flags for a document."""
    is_attachment = (
        attachment is not None
        and attachment.context_type == ContextType.ATTACHMENT.value
    )
    mime_type = attachment.mime_type if is_attachment and attachment.mime_type else None
    file_name = (
        attachment.original_filename
        if is_attachment and attachment.original_filename
        else document.name
    )
    file_extension = (
        attachment.file_extension
        if is_attachment and attachment.file_extension
        else document.file_extension
    )
    file_extension = normalize_file_extension(file_extension)
    file_size = (
        attachment.file_size
        if is_attachment and attachment.file_size is not None
        else document.file_size
    )
    downloadable = bool(is_attachment and attachment.storage_key)
    previewable = bool(
        downloadable and mime_type and mime_type.lower() in INLINE_PREVIEW_MIME_TYPES
    )

    return ExternalDocumentAccess(
        document=document,
        attachment=attachment if is_attachment else None,
        content_readable=bool(is_attachment and attachment.extracted_text),
        downloadable=downloadable,
        previewable=previewable,
        mime_type=mime_type,
        file_name=file_name,
        file_extension=file_extension,
        file_size=file_size,
    )


def load_attachment_map(
    db: Session,
    documents: list[KnowledgeDocument],
) -> dict[int, SubtaskContext]:
    """Load document attachments in bulk and index them by attachment ID."""
    attachment_ids = {
        document.attachment_id
        for document in documents
        if document.attachment_id and document.attachment_id > 0
    }
    if not attachment_ids:
        return {}

    attachments = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(attachment_ids),
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .all()
    )
    return {attachment.id: attachment for attachment in attachments}


def get_document_access_or_raise(
    db: Session,
    *,
    user_id: int,
    document_id: int,
) -> ExternalDocumentAccess:
    """Load a document and validate the external user's KB access."""
    document = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document_id).first()
    )
    if document is None:
        raise ExternalDocumentAccessError("Document not found", "not_found")

    knowledge_base, has_access = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=document.kind_id,
        user_id=user_id,
    )
    if knowledge_base is None:
        raise ExternalDocumentAccessError("Knowledge base not found", "not_found")
    if not has_access:
        raise ExternalDocumentAccessError("Access denied to this document", "forbidden")

    attachment = None
    if document.attachment_id and document.attachment_id > 0:
        attachment = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.id == document.attachment_id,
                SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            )
            .first()
        )
    return build_document_capabilities(document, attachment)


def get_document_file_or_raise(
    db: Session,
    *,
    user_id: int,
    document_id: int,
    disposition: str,
) -> ExternalDocumentAccess:
    """Validate a file download request and return document access metadata."""
    access = get_document_access_or_raise(
        db,
        user_id=user_id,
        document_id=document_id,
    )
    if not access.downloadable or access.attachment is None:
        raise ExternalDocumentAccessError(
            "Document file is unavailable", "file_unavailable"
        )
    if disposition == "inline" and not access.previewable:
        raise ExternalDocumentAccessError(
            "Document file is not previewable", "unsupported_media_type"
        )
    return access


def load_document_file_or_raise(
    db: Session,
    *,
    user_id: int,
    document_id: int,
    disposition: str,
) -> ExternalDocumentFile:
    """Load a validated original document file for external download."""
    from app.services.context.context_service import context_service

    access = get_document_file_or_raise(
        db,
        user_id=user_id,
        document_id=document_id,
        disposition=disposition,
    )
    binary_data = context_service.get_attachment_binary_data(
        db=db,
        context=access.attachment,
    )
    if binary_data is None:
        raise ExternalDocumentAccessError(
            "Document file is unavailable", "file_unavailable"
        )

    return ExternalDocumentFile(
        content=binary_data,
        media_type=access.mime_type or "application/octet-stream",
        content_disposition=build_content_disposition(disposition, access.file_name),
    )


def create_document_download_token(
    *,
    user_id: int,
    document_id: int,
    disposition: str,
    expires_seconds: int = DOCUMENT_DOWNLOAD_TOKEN_EXPIRES_SECONDS,
) -> str:
    """Create a short-lived signed token for external document downloads."""
    expire = datetime.now(timezone.utc) + timedelta(seconds=expires_seconds)
    payload = {
        "type": DOCUMENT_DOWNLOAD_TOKEN_TYPE,
        "user_id": user_id,
        "document_id": document_id,
        "disposition": disposition,
        "exp": expire,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_document_download_token(token: str) -> Optional[DocumentDownloadToken]:
    """Verify a document download token and return its payload."""
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None

    if payload.get("type") != DOCUMENT_DOWNLOAD_TOKEN_TYPE:
        return None

    user_id = payload.get("user_id")
    document_id = payload.get("document_id")
    disposition = payload.get("disposition")
    if (
        type(user_id) is not int
        or user_id <= 0
        or type(document_id) is not int
        or document_id <= 0
        or disposition not in ALLOWED_DOWNLOAD_DISPOSITIONS
    ):
        return None

    return DocumentDownloadToken(
        user_id=user_id,
        document_id=document_id,
        disposition=disposition,
    )
