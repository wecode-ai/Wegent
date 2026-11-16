# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Independent document deletion transactions with explicit per-item outcomes."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.schemas.knowledge import BatchDeletionResult, BatchDocumentDeletionOutcome
from app.services.knowledge.deletion_cleanup import IndexCleanupConfirmationRequired
from app.services.rag.remote_gateway import RemoteRagGatewayError
from shared.knowledge_cleanup import ContentDeletionOutcome

if TYPE_CHECKING:
    from app.services.knowledge.knowledge_service import BatchDeleteResult

logger = logging.getLogger(__name__)


def failed_deletion(error: Exception | None) -> ContentDeletionOutcome:
    """Continuation eligibility comes exclusively from the single-delete policy."""
    code = "internal_error"
    if error is None:
        code = "document_not_found"
    elif isinstance(error, IndexCleanupConfirmationRequired):
        return error.outcome
    elif isinstance(error, RemoteRagGatewayError):
        code = (
            "cleanup_service_authentication_failed"
            if error.status_code == 401
            else "index_cleanup_failed"
        )
    elif isinstance(error, HTTPException):
        code = {403: "permission_denied", 404: "document_not_found"}.get(
            error.status_code, "internal_error"
        )
    elif isinstance(error, ValueError):
        code = "deletion_rejected"
    return ContentDeletionOutcome(index_cleanup="unconfirmed", error_code=code)


def _delete_one(
    db: Session,
    doc_id: int,
    user_id: int,
    continuing: bool,
) -> tuple[BatchDocumentDeletionOutcome, int | None]:
    from app.services.knowledge.knowledge_service import KnowledgeService

    kb_id = None
    try:
        db.expire_all()
        if continuing:
            result = KnowledgeService.delete_document(
                db, doc_id, user_id, continue_on_external_engine_failure=True
            )
        else:
            result = KnowledgeService.delete_document(db, doc_id, user_id)
        if result.success:
            outcome = result.cleanup
            if not outcome.content_deleted:
                raise RuntimeError("A committed deletion outcome is required")
            kb_id = result.kb_id
        else:
            db.rollback()
            outcome = failed_deletion(None)
    except Exception as error:
        db.rollback()
        outcome = failed_deletion(error)
        if outcome.error_code == "internal_error":
            logger.exception("Unexpected error deleting document %s", doc_id)
    return (
        BatchDocumentDeletionOutcome(document_id=doc_id, **outcome.model_dump()),
        kb_id,
    )


def _summarize(items: list[BatchDocumentDeletionOutcome]) -> BatchDeletionResult:
    failed_ids = [item.document_id for item in items if not item.content_deleted]
    success_count = len(items) - len(failed_ids)
    unconfirmed_count = sum(
        item.content_deleted and item.index_cleanup == "unconfirmed" for item in items
    )
    message = (
        f"Successfully deleted {success_count} documents, {len(failed_ids)} failed"
    )
    if unconfirmed_count:
        message = f"Deleted {success_count} documents; external cleanup unconfirmed for {unconfirmed_count}; {len(failed_ids)} failed"
    if failed_ids and not success_count:
        codes = {item.error_code for item in items}
        if codes == {"document_not_found"}:
            message = "Document not found"
        elif codes <= {"permission_denied", "deletion_rejected"}:
            message = "Document deletion is not allowed"
    return BatchDeletionResult(
        items=items,
        success_count=success_count,
        failed_count=len(failed_ids),
        failed_ids=failed_ids,
        message=message,
        unconfirmed_count=unconfirmed_count,
    )


def delete_documents(
    db: Session,
    document_ids: list[int],
    user_id: int,
    *,
    continue_on_external_engine_failure: bool = False,
) -> BatchDeleteResult:
    from app.services.knowledge.knowledge_service import BatchDeleteResult

    items: list[BatchDocumentDeletionOutcome] = []
    kb_ids: set[int] = set()
    for doc_id in dict.fromkeys(document_ids):
        item, kb_id = _delete_one(
            db, doc_id, user_id, continue_on_external_engine_failure
        )
        items.append(item)
        if kb_id is not None:
            kb_ids.add(kb_id)
    return BatchDeleteResult(result=_summarize(items), kb_ids=sorted(kb_ids))
