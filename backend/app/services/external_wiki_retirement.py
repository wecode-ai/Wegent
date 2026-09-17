# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""One-time retirement support for legacy live Wiki documents."""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
)
from app.services.knowledge.knowledge_service import KnowledgeService

LEGACY_LIVE_SOURCE_TYPE = "external_wiki"


@dataclass
class ExternalWikiLiveDocumentRetirementReport:
    """Exact legacy live-binding rows found for retirement."""

    document_ids: list[int] = field(default_factory=list)
    knowledge_base_ids: list[int] = field(default_factory=list)
    user_ids: list[int] = field(default_factory=list)
    external_identity_document_ids: list[int] = field(default_factory=list)
    attachment_ids: list[int] = field(default_factory=list)
    converted_attachment_ids: list[int] = field(default_factory=list)
    indexed_document_ids: list[int] = field(default_factory=list)
    applied: bool = False


def inspect_external_wiki_live_documents(
    db: Session,
) -> ExternalWikiLiveDocumentRetirementReport:
    """Inspect only documents created by the removed live Wiki binding path."""
    documents = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.source_type == LEGACY_LIVE_SOURCE_TYPE)
        .order_by(KnowledgeDocument.id.asc())
        .all()
    )
    return ExternalWikiLiveDocumentRetirementReport(
        document_ids=[document.id for document in documents],
        knowledge_base_ids=sorted({document.kind_id for document in documents}),
        user_ids=sorted({document.user_id for document in documents}),
        external_identity_document_ids=[
            document.id
            for document in documents
            if document.external_source is not None
        ],
        attachment_ids=sorted(
            {document.attachment_id for document in documents if document.attachment_id}
        ),
        converted_attachment_ids=sorted(
            {
                attachment_id
                for document in documents
                if (attachment_id := document.converted_attachment_id)
            }
        ),
        indexed_document_ids=[
            document.id
            for document in documents
            if document.index_status != DocumentIndexStatus.NOT_INDEXED
        ],
    )


def retire_external_wiki_live_documents(
    db: Session,
) -> ExternalWikiLiveDocumentRetirementReport:
    """Delete the exact unindexed, attachment-free legacy live Wiki rows."""
    report = inspect_external_wiki_live_documents(db)
    if not report.document_ids:
        return report

    if report.attachment_ids or report.converted_attachment_ids:
        raise RuntimeError(
            "Refusing cleanup because legacy live Wiki rows unexpectedly own "
            "attachments: "
            f"direct={report.attachment_ids}, converted={report.converted_attachment_ids}"
        )
    if report.indexed_document_ids:
        raise RuntimeError(
            "Refusing cleanup because legacy live Wiki rows unexpectedly have index "
            f"state: {report.indexed_document_ids}"
        )

    documents = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id.in_(report.document_ids))
        .all()
    )
    for document in documents:
        db.delete(document)
    db.flush()

    for knowledge_base_id in report.knowledge_base_ids:
        KnowledgeService._update_document_count_cache(db, knowledge_base_id)
    db.commit()
    report.applied = True
    return report
