# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Owner-checked attachment sources and metadata for knowledge document reads."""

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import tuple_
from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextType, SubtaskContext


@dataclass(frozen=True)
class DocumentTextSources:
    """Owner-checked snapshots, with readability measured on full stored text."""

    original: Optional[SubtaskContext] = None
    converted: Optional[SubtaskContext] = None
    content_readable: bool = False

    def select_text(self) -> Optional[str]:
        """Prefer usable converted text, then original, preserving its whitespace."""
        for attachment in (self.converted, self.original):
            text = attachment.extracted_text if attachment is not None else None
            if isinstance(text, str) and text.strip():
                return text
        return None


def converted_attachment_id(document: KnowledgeDocument) -> Optional[int]:
    """Return only a positive database integer ID, without coercion."""
    config = document.source_config
    if not isinstance(config, dict):
        return None
    value = config.get("converted_attachment_id")
    return value if type(value) is int and 0 < value <= 2**63 - 1 else None


def load_document_text_sources(
    db: Session,
    documents: list[KnowledgeDocument],
    *,
    include_text: bool = True,
) -> dict[int, DocumentTextSources]:
    """Batch attachment metadata and optionally text, checking owner and type.

    Owner equality is not reverse document provenance. Existing content readers
    retain legacy conversion support; directories must request metadata only
    and expose saved document summaries, never attachment-derived previews.
    Neither mode loads binary or image blobs or changes persistent ORM state.
    """
    references = {
        document.id: (document.attachment_id, converted_attachment_id(document))
        for document in documents
    }
    owner_refs = {
        (document.user_id, attachment_id)
        for document in documents
        for attachment_id in references[document.id]
        if attachment_id and attachment_id > 0
    }
    if not owner_refs:
        return {document.id: DocumentTextSources() for document in documents}
    columns = [
        SubtaskContext.id,
        SubtaskContext.user_id,
        SubtaskContext.name,
        SubtaskContext.context_type,
        SubtaskContext.type_data,
        SubtaskContext.extracted_text.regexp_match(r"\S").label("content_readable"),
    ]
    if include_text:
        columns.append(SubtaskContext.extracted_text)
    rows = (
        db.query(*columns)
        .filter(
            SubtaskContext.id.in_({attachment_id for _, attachment_id in owner_refs}),
            tuple_(SubtaskContext.user_id, SubtaskContext.id).in_(owner_refs),
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .all()
    )
    snapshots = {
        (row.user_id, row.id): SubtaskContext(
            id=row.id,
            user_id=row.user_id,
            name=row.name,
            context_type=row.context_type,
            type_data=row.type_data,
            extracted_text=row.extracted_text if include_text else None,
        )
        for row in rows
    }
    readable_refs = {(row.user_id, row.id) for row in rows if row.content_readable}
    result = {}
    for document in documents:
        original_id, converted_id = references[document.id]
        original_ref = (document.user_id, original_id)
        converted_ref = (document.user_id, converted_id)
        result[document.id] = DocumentTextSources(
            original=snapshots.get(original_ref),
            converted=snapshots.get(converted_ref),
            content_readable=(
                original_ref in readable_refs or converted_ref in readable_refs
            ),
        )
    return result
