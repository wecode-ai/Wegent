# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wiring the projection's side effects to the real services.

The projection takes these as injected callables so its ordering rules can be
asserted on directly. This module is the other half of that arrangement: the adapters
that talk to attachment storage, the vector store and the indexing queue.

Keeping them here rather than inside the projection means the rules and the plumbing
fail separately — a signature that turns out to be wrong shows up as an adapter fault
rather than as an ordering test that no longer proves anything.
"""

import logging

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.services.knowledge.code_wiki.projection import ProjectionSideEffects

logger = logging.getLogger(__name__)


def build_projection_side_effects(
    db: Session,
    *,
    knowledge_base: Kind,
    user: User,
) -> ProjectionSideEffects:
    """Assemble the real side effects for projecting into ``knowledge_base``.

    Args:
        db: Session the projection runs in. Attachment writes join it; the vector
            store and the queue cannot, which is why their failures are retried
            rather than rolled back.
        knowledge_base: The code wiki being projected into.
        user: Identity attachments and indexing run under.
    """
    from app.services.context import context_service

    def write_attachment(*, filename: str, content: str) -> int:
        attachment, _ = context_service.upload_attachment(
            db=db,
            user_id=user.id,
            filename=filename,
            binary_data=content.encode("utf-8"),
            subtask_id=0,
        )
        return attachment.id

    def delete_attachment(attachment_id: int) -> None:
        context_service.delete_context(
            db=db,
            context_id=attachment_id,
            user_id=user.id,
        )

    def delete_rag_document(document_id: int) -> None:
        _delete_document_index(
            db, knowledge_base=knowledge_base, user=user, document_id=document_id
        )

    def enqueue_reindex(document_id: int) -> None:
        _enqueue_reindex(
            db, knowledge_base=knowledge_base, user=user, document_id=document_id
        )

    return ProjectionSideEffects(
        write_attachment=write_attachment,
        delete_attachment=delete_attachment,
        delete_rag_document=delete_rag_document,
        enqueue_reindex=enqueue_reindex,
    )


def _delete_document_index(
    db: Session, *, knowledge_base: Kind, user: User, document_id: int
) -> None:
    """Remove a removed page's chunks from the vector store.

    Raises on failure so the caller can park the reference and retry: chunks left
    behind outlive the page, and retrieval goes on answering from it while citing an
    id that no longer resolves.
    """
    from app.services.knowledge.index_runtime import get_kb_index_info_by_record
    from app.services.rag.gateway_factory import get_delete_gateway
    from app.services.rag.runtime_resolver import RagRuntimeResolver

    spec = (knowledge_base.json or {}).get("spec", {})
    if not spec.get("retrievalConfig"):
        # Nothing was ever indexed, so there is nothing to remove.
        return

    index_info = get_kb_index_info_by_record(
        db=db, knowledge_base=knowledge_base, current_user_id=user.id
    )
    delete_spec = RagRuntimeResolver().build_delete_runtime_spec(
        db=db,
        knowledge_base_id=knowledge_base.id,
        # The index keys documents by their id rendered as a string, which is what
        # KnowledgeService.delete_document also uses.
        document_ref=str(document_id),
        index_owner_user_id=index_info.index_owner_user_id,
    )
    result = _run(get_delete_gateway().delete_document_index(delete_spec, db=db))
    status = (result or {}).get("status")
    if status not in {"success", "deleted"}:
        raise RuntimeError(f"index deletion returned status '{status}'")


def _enqueue_reindex(
    db: Session, *, knowledge_base: Kind, user: User, document_id: int
) -> None:
    """Queue a written page for indexing.

    A page stays invisible until its index succeeds — the state machine turns on
    ``is_active`` and ``status`` together at that point — so this is what actually
    publishes a page to readers.
    """
    from app.services.knowledge.orchestrator import knowledge_orchestrator

    document = db.get(KnowledgeDocument, document_id)
    if document is None:
        return
    knowledge_orchestrator._schedule_indexing_celery(
        db=db,
        knowledge_base=knowledge_base,
        document=document,
        user=user,
        # Summaries are a knowledge base level concern and would be recomputed once
        # per page here; the publish path refreshes them separately.
        trigger_summary=False,
        replace_active=True,
    )


def _run(awaitable):
    """Run an awaitable from synchronous code."""
    from app.services.knowledge.knowledge_service import _run_async_in_new_loop

    return _run_async_in_new_loop(awaitable)
