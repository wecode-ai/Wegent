# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reusable conversion and indexing rules for knowledge documents.

Documents that need conversion (PDF, DOCX, ...) are converted to Markdown
before indexing, and the result enters the same document index as plain content:
one logical space, one document reference, and one chunk metadata shape. This
module owns those rules, so every side converts, names, and normalizes the same
way without loading Wegent product ORM models, database sessions or task
workers.

Adapters supply the conversion engine, the content, the storage connection and
the embedding executor. Deleting a document uses the identical reference, so a
removed document leaves no chunk its own index call created. The module never
talks to a converter service or a vector store itself.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Protocol, runtime_checkable

# Object-key prefix for converted source attachments. It keeps converted images
# in a namespace of their own instead of mixing them with user uploads.
DOCUMENT_CONVERSION_PREFIX = "doc-converter"

# A conversion may start only while the document waits for it, and may complete
# only while the document is converting. Both keep the same accepted
# pre-states, which is why a late start and a duplicate completion are refused.
CONVERSION_START_STATUSES = frozenset({"queued", "pending_conversion"})
CONVERSION_COMPLETE_STATUSES = frozenset({"converting", "pending_conversion"})


class KnowledgeDocumentError(ValueError):
    """Raised when a document conversion or index request violates module rules."""


@dataclass(frozen=True)
class ConversionRequest:
    """One document that has to be converted before it can be indexed."""

    binary_data: bytes
    file_extension: str
    original_filename: str
    knowledge_base_name: str
    document_id: int


@dataclass(frozen=True)
class ConversionEngineResult:
    """Raw conversion engine output, normalized by :func:`convert_content`."""

    markdown_bytes: bytes
    uploaded_images: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ConvertedContent:
    """Converted Markdown plus the identity the callback and index both use."""

    markdown_bytes: bytes
    converted_name: str
    storage_prefix: str
    uploaded_images: tuple[tuple[str, str], ...] = ()


@runtime_checkable
class ContentConversionAdapter(Protocol):
    """Supplies the conversion engine and the formats it can convert."""

    def supports_conversion(self, extension: str) -> bool:
        """Return whether the local conversion engine accepts this extension."""

    def convert(
        self, *, binary_data: bytes, extension: str, storage_prefix: str
    ) -> ConversionEngineResult:
        """Convert one document's binary content to Markdown."""


@dataclass(frozen=True)
class DocumentIndexRequest:
    """One document body about to enter a knowledge base's index."""

    knowledge_id: str
    binary_data: bytes
    source_file: str
    file_extension: str
    user_id: int
    document_id: int | None = None
    splitter_config: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class DocumentChunkMetadata:
    """The identity every chunk of one document carries in the index."""

    knowledge_id: str
    doc_ref: str
    source_file: str
    created_at: str


@dataclass(frozen=True)
class DocumentDeleteRequest:
    """One indexed document about to leave a knowledge base's index."""

    knowledge_id: str
    doc_ref: str
    user_id: int | None = None


@dataclass(frozen=True)
class DocumentStateDecision:
    """Whether a conversion event may mutate the current attempt."""

    should_execute: bool
    reason: str


@runtime_checkable
class DocumentIndexAdapter(Protocol):
    """Supplies the storage connection and embedding executor for one index."""

    async def index_chunks(
        self, *, metadata: DocumentChunkMetadata, request: DocumentIndexRequest
    ) -> Mapping[str, Any]:
        """Split, embed and store one document's chunks under ``metadata``."""

    async def delete_document(
        self, *, request: DocumentDeleteRequest
    ) -> Mapping[str, Any]:
        """Remove every chunk stored under ``request.doc_ref``."""


def normalize_document_extension(file_extension: str) -> str:
    """Return the bare, lower-case extension a conversion is dispatched with."""
    normalized = (file_extension or "").lstrip(".").strip().lower()
    if not normalized:
        raise KnowledgeDocumentError("file_extension is required")
    return normalized


def conversion_output_name(original_filename: str, file_extension: str) -> str:
    """Return the converted Markdown filename derived from the source file.

    The source stem is kept and the source extension stays part of the converted
    name (``report.pdf`` -> ``report.pdf.md``), so the converted attachment
    remains traceable to the document it replaces.
    """
    extension = normalize_document_extension(file_extension)
    stem = os.path.splitext(original_filename)[0]
    return f"{stem}.{extension}.md"


def conversion_storage_prefix(
    knowledge_base_name: str, document_id: int, original_filename: str
) -> str:
    """Return the object-key prefix converted images are stored under."""
    stem = os.path.splitext(original_filename)[0]
    return "/".join(
        (
            DOCUMENT_CONVERSION_PREFIX,
            _sanitize_path_component(knowledge_base_name),
            str(document_id),
            _sanitize_path_component(stem),
        )
    )


def convert_content(
    adapter: ContentConversionAdapter, request: ConversionRequest
) -> ConvertedContent:
    """Convert one document's content and return it with its index identity.

    Raises :class:`KnowledgeDocumentError` when the request cannot be converted
    (missing content, unsupported format, empty result). Engine failures
    propagate unchanged so the caller keeps its own failure classification.
    """
    extension = normalize_document_extension(request.file_extension)
    if not request.binary_data:
        raise KnowledgeDocumentError("conversion requires binary content")
    if not adapter.supports_conversion(extension):
        raise KnowledgeDocumentError(
            f"conversion for extension {extension!r} is not supported"
        )

    storage_prefix = conversion_storage_prefix(
        request.knowledge_base_name, request.document_id, request.original_filename
    )
    engine_result = adapter.convert(
        binary_data=request.binary_data,
        extension=extension,
        storage_prefix=storage_prefix,
    )
    if not engine_result.markdown_bytes:
        raise KnowledgeDocumentError(
            f"conversion produced no markdown for document {request.document_id}"
        )

    return ConvertedContent(
        markdown_bytes=engine_result.markdown_bytes,
        converted_name=conversion_output_name(
            request.original_filename, request.file_extension
        ),
        storage_prefix=storage_prefix,
        uploaded_images=tuple(engine_result.uploaded_images or ()),
    )


def decide_conversion_started(
    *,
    generation: int,
    current_generation: int | None,
    status: str | None,
) -> DocumentStateDecision:
    """Decide whether a converter may move a document into ``converting``."""
    return _decide_conversion_event(
        event="started",
        generation=generation,
        current_generation=current_generation,
        status=status,
        accepted_statuses=CONVERSION_START_STATUSES,
    )


def decide_conversion_completed(
    *,
    generation: int,
    current_generation: int | None,
    status: str | None,
) -> DocumentStateDecision:
    """Decide whether a completed conversion may replace the document body.

    A duplicate completion arrives after the first one already moved the
    document to ``queued`` (or further), and a superseded callback reports an
    older generation. Both are refused here, before any attachment is created,
    so a stale result can never be read back.
    """
    return _decide_conversion_event(
        event="completed",
        generation=generation,
        current_generation=current_generation,
        status=status,
        accepted_statuses=CONVERSION_COMPLETE_STATUSES,
    )


def build_document_chunk_metadata(
    *,
    knowledge_id: str | int,
    source_file: str,
    document_id: int | None,
    created_at: str | None = None,
) -> DocumentChunkMetadata:
    """Build the chunk identity for one document.

    A stored document is referenced by its own id, so a document-scoped query
    resolves the same reference the product shows. Content with no stored
    document yet gets a generated reference.
    """
    knowledge_id_value = str(knowledge_id).strip()
    if not knowledge_id_value:
        raise KnowledgeDocumentError("knowledge_id is required")
    if not source_file:
        raise KnowledgeDocumentError("source_file is required")

    doc_ref = str(document_id) if document_id is not None else _generate_doc_ref()
    return DocumentChunkMetadata(
        knowledge_id=knowledge_id_value,
        doc_ref=doc_ref,
        source_file=source_file,
        created_at=created_at or datetime.now(timezone.utc).isoformat(),
    )


def finalize_index_result(
    result: Mapping[str, Any], metadata: DocumentChunkMetadata
) -> dict[str, Any]:
    """Normalize one engine's index result into the shared document result."""
    finalized = dict(result)
    finalized.setdefault("doc_ref", metadata.doc_ref)
    finalized.setdefault("knowledge_id", metadata.knowledge_id)
    finalized.setdefault("source_file", metadata.source_file)
    finalized.setdefault("created_at", metadata.created_at)

    if "chunk_count" not in finalized:
        chunks_data = finalized.get("chunks_data")
        if isinstance(chunks_data, list):
            finalized["chunk_count"] = len(chunks_data)
        elif isinstance(chunks_data, dict):
            finalized["chunk_count"] = chunks_data.get(
                "total_count", finalized.get("indexed_count", 0)
            )
        else:
            finalized["chunk_count"] = finalized.get("indexed_count", 0)
    return finalized


async def index_document(
    adapter: DocumentIndexAdapter, request: DocumentIndexRequest
) -> dict[str, Any]:
    """Index one document body under the shared identity and result shape."""
    metadata = build_document_chunk_metadata(
        knowledge_id=request.knowledge_id,
        source_file=request.source_file,
        document_id=request.document_id,
    )
    result = await adapter.index_chunks(metadata=metadata, request=request)
    return finalize_index_result(result, metadata)


def build_document_delete_request(
    *,
    knowledge_id: str | int,
    doc_ref: str | int,
    user_id: int | None = None,
) -> DocumentDeleteRequest:
    """Build the delete identity for one stored document.

    ``doc_ref`` is the reference :func:`build_document_chunk_metadata` wrote for
    the document, so deleting it removes exactly the chunks its index call
    created and never another document's.
    """
    knowledge_id_value = str(knowledge_id).strip()
    if not knowledge_id_value:
        raise KnowledgeDocumentError("knowledge_id is required")
    doc_ref_value = str(doc_ref).strip()
    if not doc_ref_value:
        raise KnowledgeDocumentError("doc_ref is required")
    return DocumentDeleteRequest(
        knowledge_id=knowledge_id_value, doc_ref=doc_ref_value, user_id=user_id
    )


async def delete_document(
    adapter: DocumentIndexAdapter, request: DocumentDeleteRequest
) -> dict[str, Any]:
    """Delete one document's chunks under the shared identity.

    The rule is idempotent: a reference that currently holds no chunks reports
    zero deletions instead of failing, so a repeated delete is a no-op and a
    retry after a partial cleanup cannot turn into an error.
    """
    result = await adapter.delete_document(request=request)
    finalized = dict(result or {})
    finalized.setdefault("knowledge_id", request.knowledge_id)
    finalized.setdefault("doc_ref", request.doc_ref)
    finalized.setdefault("deleted_chunks", 0)
    finalized.setdefault("status", "deleted")
    return finalized


def _decide_conversion_event(
    *,
    event: str,
    generation: int,
    current_generation: int | None,
    status: str | None,
    accepted_statuses: frozenset[str],
) -> DocumentStateDecision:
    """Apply the shared conversion lifecycle rule for one event."""
    if current_generation is None:
        return DocumentStateDecision(False, "document_not_found")
    if current_generation != generation:
        return DocumentStateDecision(False, "stale_generation")
    if status not in accepted_statuses:
        if event == "completed":
            return DocumentStateDecision(False, "stale_or_already_finalized")
        return DocumentStateDecision(False, f"unexpected_status_{status}")
    return DocumentStateDecision(True, f"conversion_{event}")


def _sanitize_path_component(value: str) -> str:
    """Strip traversal out of one object-key path component."""
    return (value or "").replace("..", "").replace("\\", "/").strip("/")


def _generate_doc_ref() -> str:
    return f"doc_{uuid.uuid4().hex[:12]}"
