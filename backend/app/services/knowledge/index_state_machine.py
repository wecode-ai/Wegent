# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
State machine helpers for knowledge document indexing.

This module owns the business-level idempotency rules for document indexing:
- prevent duplicate enqueue while a generation is already queued/running
- version each indexing attempt with index_generation
- reject stale Celery redelivery/retry tasks for old generations
- update terminal state only when the task still matches the active generation
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.knowledge import DocumentIndexStatus, DocumentStatus, KnowledgeDocument
from app.schemas.knowledge import DocumentProcessingError, DocumentProcessingStage
from app.services.knowledge.processing_errors import generic_processing_error
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync


@dataclass(frozen=True)
class IndexEnqueueDecision:
    """Decision returned before sending a Celery indexing task."""

    should_enqueue: bool
    generation: Optional[int]
    reason: str
    previous_status: Optional[DocumentIndexStatus] = None


@dataclass(frozen=True)
class IndexExecutionDecision:
    """Decision returned when a worker starts processing a task."""

    should_execute: bool
    reason: str


@dataclass(frozen=True)
class ExternalImportAttemptDecision:
    """Decision returned when an external import task claims its attempt."""

    should_execute: bool
    reason: str
    generation: Optional[int] = None


ACTIVE_INDEX_STATUSES = {
    DocumentIndexStatus.QUEUED,
    DocumentIndexStatus.PENDING_CONVERSION,
    DocumentIndexStatus.CONVERTING,
    DocumentIndexStatus.INDEXING,
}


def _utcnow() -> datetime:
    """Return a timezone-naive UTC timestamp for DB comparisons."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _get_active_index_stale_reason(
    document: KnowledgeDocument,
) -> Optional[str]:
    """Return a stale reason when an active indexing state is expired."""
    return _get_active_index_stale_reason_for(
        document.index_status, document.updated_at
    )


def _get_active_index_stale_reason_for(
    index_status: DocumentIndexStatus,
    updated_at: Optional[datetime],
) -> Optional[str]:
    """Return a stale reason based on raw status and timestamp values.

    Accepts raw values instead of ORM object so callers can use
    lightweight column queries without loading full KnowledgeDocument rows.
    """
    if updated_at is None:
        return None

    age_seconds = (_utcnow() - updated_at).total_seconds()
    if (
        index_status == DocumentIndexStatus.QUEUED
        and age_seconds >= settings.KNOWLEDGE_INDEX_STALE_QUEUED_SECONDS
    ):
        return "stale_queued"

    if (
        index_status == DocumentIndexStatus.PENDING_CONVERSION
        and age_seconds >= settings.KNOWLEDGE_INDEX_STALE_PENDING_CONVERSION_SECONDS
    ):
        return "stale_pending_conversion"

    if (
        index_status == DocumentIndexStatus.INDEXING
        and age_seconds >= settings.KNOWLEDGE_INDEX_STALE_INDEXING_SECONDS
    ):
        return "stale_indexing"

    if (
        index_status == DocumentIndexStatus.CONVERTING
        and age_seconds >= settings.KNOWLEDGE_INDEX_STALE_CONVERTING_SECONDS
    ):
        return "stale_converting"

    return None


def get_document_index_lock_name(document_id: int) -> str:
    """Return the Redis lock name for a document indexing task."""
    return f"knowledge:index_document:{document_id}"


def _record_transition(
    event_name: str,
    *,
    document_id: int,
    generation: Optional[int],
    reason: str,
    previous_status: Optional[DocumentIndexStatus] = None,
) -> None:
    """Attach transition details to the current telemetry span."""
    attributes = {
        "knowledge.document_id": document_id,
        "knowledge.decision_reason": reason,
    }
    if generation is not None:
        attributes["knowledge.index_generation"] = generation
    if previous_status is not None:
        attributes["knowledge.previous_index_status"] = previous_status.value

    for key, value in attributes.items():
        set_span_attribute(key, value)
    add_span_event(event_name, attributes)


@trace_sync(
    span_name="knowledge.prepare_document_index_enqueue",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, allow_if_success=False, replace_active=False, expected_generation=None: {
        "knowledge.document_id": document_id,
        "knowledge.allow_if_success": allow_if_success,
        "knowledge.replace_active": replace_active,
    },
)
def prepare_document_index_enqueue(
    db: Session,
    document_id: int,
    *,
    allow_if_success: bool = False,
    replace_active: bool = False,
    expected_generation: Optional[int] = None,
) -> IndexEnqueueDecision:
    """
    Prepare a document for a new indexing generation.

    This function is called before sending a Celery task. It updates the
    business state in the database so later duplicate requests can be skipped.
    A guarded handoff may only advance the generation it already owns.
    """
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    if document is None:
        db.rollback()
        _record_transition(
            "knowledge.index.enqueue.skipped",
            document_id=document_id,
            generation=None,
            reason="document_not_found",
        )
        return IndexEnqueueDecision(
            should_enqueue=False,
            generation=None,
            reason="document_not_found",
        )

    current_status = document.index_status or DocumentIndexStatus.NOT_INDEXED
    if (
        expected_generation is not None
        and document.index_generation != expected_generation
    ):
        db.rollback()
        _record_transition(
            "knowledge.index.enqueue.skipped",
            document_id=document_id,
            generation=expected_generation,
            reason="stale_generation",
        )
        return IndexEnqueueDecision(
            should_enqueue=False,
            generation=expected_generation,
            reason="stale_generation",
            previous_status=current_status,
        )

    if current_status in ACTIVE_INDEX_STATUSES and not replace_active:
        stale_reason = _get_active_index_stale_reason(document)
        if stale_reason is None:
            db.rollback()
            _record_transition(
                "knowledge.index.enqueue.skipped",
                document_id=document_id,
                generation=document.index_generation,
                reason="already_in_progress",
                previous_status=current_status,
            )
            return IndexEnqueueDecision(
                should_enqueue=False,
                generation=document.index_generation,
                reason="already_in_progress",
                previous_status=current_status,
            )

        next_generation = (document.index_generation or 0) + 1
        document.index_generation = next_generation
        document.index_status = DocumentIndexStatus.QUEUED
        document.clear_processing_error_payload()
        db.commit()
        _record_transition(
            "knowledge.index.enqueue.scheduled",
            document_id=document_id,
            generation=next_generation,
            reason="scheduled_after_stale_recovery",
            previous_status=current_status,
        )

        return IndexEnqueueDecision(
            should_enqueue=True,
            generation=next_generation,
            reason="scheduled_after_stale_recovery",
            previous_status=current_status,
        )

    if current_status == DocumentIndexStatus.SUCCESS and not allow_if_success:
        db.rollback()
        _record_transition(
            "knowledge.index.enqueue.skipped",
            document_id=document_id,
            generation=document.index_generation,
            reason="already_indexed",
            previous_status=current_status,
        )
        return IndexEnqueueDecision(
            should_enqueue=False,
            generation=document.index_generation,
            reason="already_indexed",
            previous_status=current_status,
        )

    next_generation = (document.index_generation or 0) + 1
    document.index_generation = next_generation
    document.index_status = DocumentIndexStatus.QUEUED
    document.clear_processing_error_payload()

    db.commit()
    _record_transition(
        "knowledge.index.enqueue.scheduled",
        document_id=document_id,
        generation=next_generation,
        reason="scheduled",
        previous_status=current_status,
    )

    return IndexEnqueueDecision(
        should_enqueue=True,
        generation=next_generation,
        reason="scheduled",
        previous_status=current_status,
    )


@trace_sync(
    span_name="knowledge.mark_document_index_enqueue_failed",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, generation: {
        "knowledge.document_id": document_id,
        "knowledge.index_generation": generation,
    },
)
def mark_document_index_enqueue_failed(
    db: Session,
    document_id: int,
    generation: int,
    *,
    error: Optional[DocumentProcessingError] = None,
) -> bool:
    """Mark a queued generation as failed when broker dispatch fails."""
    return mark_document_index_failed(
        db=db,
        document_id=document_id,
        generation=generation,
        error=error
        or generic_processing_error(
            generation=generation,
            stage=DocumentProcessingStage.DISPATCH,
        ),
    )


@trace_sync(
    span_name="knowledge.mark_document_index_started",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, generation: {
        "knowledge.document_id": document_id,
        "knowledge.index_generation": generation,
    },
)
def mark_document_index_started(
    db: Session,
    document_id: int,
    generation: int,
) -> IndexExecutionDecision:
    """Transition a queued generation into indexing state."""
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .with_for_update()
        .first()
    )
    if document is None:
        db.rollback()
        _record_transition(
            "knowledge.index.start.skipped",
            document_id=document_id,
            generation=generation,
            reason="document_not_found",
        )
        return IndexExecutionDecision(
            should_execute=False,
            reason="document_not_found",
        )

    if document.index_generation != generation:
        db.rollback()
        _record_transition(
            "knowledge.index.start.skipped",
            document_id=document_id,
            generation=generation,
            reason="stale_generation",
            previous_status=document.index_status,
        )
        return IndexExecutionDecision(
            should_execute=False,
            reason="stale_generation",
        )

    current_status = document.index_status or DocumentIndexStatus.NOT_INDEXED
    if current_status == DocumentIndexStatus.SUCCESS:
        db.rollback()
        _record_transition(
            "knowledge.index.start.skipped",
            document_id=document_id,
            generation=generation,
            reason="already_completed",
            previous_status=current_status,
        )
        return IndexExecutionDecision(
            should_execute=False,
            reason="already_completed",
        )

    if current_status == DocumentIndexStatus.NOT_INDEXED:
        db.rollback()
        _record_transition(
            "knowledge.index.start.skipped",
            document_id=document_id,
            generation=generation,
            reason="not_scheduled",
            previous_status=current_status,
        )
        return IndexExecutionDecision(
            should_execute=False,
            reason="not_scheduled",
        )

    if current_status == DocumentIndexStatus.FAILED:
        db.rollback()
        _record_transition(
            "knowledge.index.start.skipped",
            document_id=document_id,
            generation=generation,
            reason="already_failed",
            previous_status=current_status,
        )
        return IndexExecutionDecision(
            should_execute=False,
            reason="already_failed",
        )

    document.index_status = DocumentIndexStatus.INDEXING
    db.commit()
    _record_transition(
        "knowledge.index.start.accepted",
        document_id=document_id,
        generation=generation,
        reason="started",
        previous_status=current_status,
    )

    return IndexExecutionDecision(
        should_execute=True,
        reason="started",
    )


_INDEX_SUCCEEDED_ALLOWED_STATUSES = {
    DocumentIndexStatus.QUEUED,
    DocumentIndexStatus.INDEXING,
}


def _finalize_external_source_on_success(
    document: KnowledgeDocument,
) -> None:
    """Record import completion without inferring source health from indexing."""
    if not document.has_external_identity:
        return

    document.update_external_source_config(
        last_success_at=datetime.now(timezone.utc).isoformat(),
    )


@trace_sync(
    span_name="knowledge.mark_document_index_succeeded",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, generation, chunks=None, chunk_storage_enabled=False: {
        "knowledge.document_id": document_id,
        "knowledge.index_generation": generation,
        "knowledge.chunk_storage_enabled": chunk_storage_enabled,
    },
)
def mark_document_index_succeeded(
    db: Session,
    document_id: int,
    generation: int,
    *,
    chunks: Optional[dict] = None,
    chunk_storage_enabled: bool = False,
) -> bool:
    """Persist a successful indexing result for the active generation.

    For an external document, success records source accessibility and the
    latest successful import time.
    """
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .with_for_update()
        .first()
    )
    if document is None:
        db.rollback()
        _record_transition(
            "knowledge.index.finalize.success",
            document_id=document_id,
            generation=generation,
            reason="stale_or_already_finalized",
        )
        return False

    current_status = document.index_status or DocumentIndexStatus.NOT_INDEXED
    if (
        document.index_generation != generation
        or current_status not in _INDEX_SUCCEEDED_ALLOWED_STATUSES
    ):
        db.rollback()
        _record_transition(
            "knowledge.index.finalize.success",
            document_id=document_id,
            generation=generation,
            reason="stale_or_already_finalized",
        )
        return False

    document.index_status = DocumentIndexStatus.SUCCESS
    document.is_active = True
    document.status = DocumentStatus.ENABLED
    if chunk_storage_enabled:
        document.chunks = chunks
    document.updated_at = _utcnow()

    _finalize_external_source_on_success(document)

    db.commit()
    _record_transition(
        "knowledge.index.finalize.success",
        document_id=document_id,
        generation=generation,
        reason="finalized",
    )
    return True


@trace_sync(
    span_name="knowledge.mark_document_index_failed",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, generation: {
        "knowledge.document_id": document_id,
        "knowledge.index_generation": generation,
    },
)
def mark_document_index_failed(
    db: Session,
    document_id: int,
    generation: int,
    *,
    error: Optional[DocumentProcessingError] = None,
) -> bool:
    """Persist a failed indexing result for the active generation.

    The document itself is never deleted by a failure, so the user can retry
    the initial import on the same record.
    """
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    if document is None:
        db.rollback()
        return False

    current_status = document.index_status or DocumentIndexStatus.NOT_INDEXED
    if (
        document.index_generation != generation
        or current_status not in ACTIVE_INDEX_STATUSES
    ):
        db.rollback()
        return False

    candidate = error or generic_processing_error(
        generation=generation,
        stage=DocumentProcessingStage.SYSTEM,
    )
    try:
        persisted_error = DocumentProcessingError.model_validate(
            {
                **candidate.model_dump(),
                "generation": generation,
                "occurred_at": datetime.now(timezone.utc),
            }
        )
    except (AttributeError, TypeError, ValidationError):
        persisted_error = generic_processing_error(
            generation=generation,
            stage=DocumentProcessingStage.SYSTEM,
        )

    document.set_processing_error_payload(persisted_error.model_dump(mode="json"))
    document.index_status = DocumentIndexStatus.FAILED
    document.updated_at = _utcnow()
    if (
        document.has_external_identity
        and persisted_error.code == "external_source_unavailable"
    ):
        document.update_external_source_config(
            status="inaccessible", last_error=persisted_error.message
        )

    db.commit()
    _record_transition(
        "knowledge.index.finalize.failed",
        document_id=document_id,
        generation=generation,
        reason="finalized",
    )
    return True


def _skip_import_attempt(
    document_id: int,
    generation: Optional[int],
    reason: str,
    previous_status: Optional[DocumentIndexStatus] = None,
) -> ExternalImportAttemptDecision:
    """Record a skip transition and build the matching decision."""
    _record_transition(
        "knowledge.external_import.attempt.skipped",
        document_id=document_id,
        generation=generation,
        reason=reason,
        previous_status=previous_status,
    )
    return ExternalImportAttemptDecision(should_execute=False, reason=reason)


@trace_sync(
    span_name="knowledge.begin_external_import_attempt",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, expected_generation: {
        "knowledge.document_id": document_id,
        "knowledge.expected_generation": expected_generation,
    },
)
def begin_external_import_attempt(
    db: Session,
    document_id: int,
    expected_generation: int,
) -> ExternalImportAttemptDecision:
    """
    Consume one queued import generation exactly once.

    The row lock makes the generation check and increment atomic. Only the
    first delivery may claim it; redelivered or older messages cannot replace
    an attempt that is already fetching, converting or indexing.
    """
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    if document is None:
        db.rollback()
        return _skip_import_attempt(document_id, None, "document_not_found")

    if not document.has_external_identity:
        db.rollback()
        return _skip_import_attempt(
            document_id, document.index_generation, "no_external_identity"
        )

    current_status = document.index_status or DocumentIndexStatus.NOT_INDEXED
    if current_status == DocumentIndexStatus.SUCCESS:
        db.rollback()
        return _skip_import_attempt(
            document_id,
            document.index_generation,
            "already_imported",
            previous_status=current_status,
        )

    if document.index_generation != expected_generation:
        db.rollback()
        return _skip_import_attempt(
            document_id, expected_generation, "stale_generation"
        )
    if current_status != DocumentIndexStatus.QUEUED:
        db.rollback()
        return _skip_import_attempt(document_id, expected_generation, "not_queued")

    next_generation = expected_generation + 1
    document.index_generation = next_generation
    document.index_status = DocumentIndexStatus.QUEUED
    document.clear_processing_error_payload()
    db.commit()
    _record_transition(
        "knowledge.external_import.attempt.claimed",
        document_id=document_id,
        generation=next_generation,
        reason="claimed",
        previous_status=current_status,
    )
    return ExternalImportAttemptDecision(
        should_execute=True, reason="claimed", generation=next_generation
    )


@trace_sync(
    span_name="knowledge.mark_document_conversion_started",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, generation: {
        "knowledge.document_id": document_id,
        "knowledge.index_generation": generation,
    },
)
def mark_document_conversion_started(
    db: Session,
    document_id: int,
    generation: int,
) -> IndexExecutionDecision:
    """Transition QUEUED -> CONVERTING when conversion worker picks up the task."""
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .with_for_update()
        .first()
    )
    if document is None:
        db.rollback()
        _record_transition(
            "knowledge.conversion.start.skipped",
            document_id=document_id,
            generation=generation,
            reason="document_not_found",
        )
        return IndexExecutionDecision(should_execute=False, reason="document_not_found")

    if document.index_generation != generation:
        db.rollback()
        _record_transition(
            "knowledge.conversion.start.skipped",
            document_id=document_id,
            generation=generation,
            reason="stale_generation",
            previous_status=document.index_status,
        )
        return IndexExecutionDecision(should_execute=False, reason="stale_generation")

    current_status = document.index_status or DocumentIndexStatus.NOT_INDEXED
    if current_status not in (
        DocumentIndexStatus.QUEUED,
        DocumentIndexStatus.PENDING_CONVERSION,
    ):
        db.rollback()
        _record_transition(
            "knowledge.conversion.start.skipped",
            document_id=document_id,
            generation=generation,
            reason=f"unexpected_status_{current_status.value}",
            previous_status=current_status,
        )
        return IndexExecutionDecision(
            should_execute=False,
            reason=f"unexpected_status_{current_status.value}",
        )

    document.index_status = DocumentIndexStatus.CONVERTING
    document.updated_at = _utcnow()
    db.commit()
    _record_transition(
        "knowledge.conversion.start.accepted",
        document_id=document_id,
        generation=generation,
        reason="conversion_started",
        previous_status=current_status,
    )
    return IndexExecutionDecision(should_execute=True, reason="conversion_started")


@trace_sync(
    span_name="knowledge.mark_document_conversion_succeeded",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, generation, converted_extension=None, converted_name=None, converted_file_size=None: {
        "knowledge.document_id": document_id,
        "knowledge.index_generation": generation,
        "knowledge.converted_extension": converted_extension or "",
    },
)
def mark_document_conversion_succeeded(
    db: Session,
    document_id: int,
    generation: int,
    *,
    converted_extension: Optional[str] = None,
    converted_name: Optional[str] = None,
    converted_file_size: Optional[int] = None,
) -> bool:
    """Transition CONVERTING -> QUEUED after successful conversion.

    NOTE: converted_extension, converted_name, converted_file_size parameters
    are kept for backward compatibility but should no longer be passed by callers.
    Document metadata (name, file_extension, file_size) now preserves original
    values to ensure source file downloadability. The converted content is stored
    in a separate attachment referenced by source_config["converted_attachment_id"].
    """
    update_payload = {
        KnowledgeDocument.index_status: DocumentIndexStatus.QUEUED,
        KnowledgeDocument.updated_at: _utcnow(),
    }
    # No longer update file_extension / name / file_size.
    # These fields keep their original file values so users can download the source document.
    # Converted content is referenced via source_config["converted_attachment_id"].

    updated = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == document_id,
            KnowledgeDocument.index_generation == generation,
            KnowledgeDocument.index_status.in_(
                [
                    DocumentIndexStatus.CONVERTING,
                    DocumentIndexStatus.PENDING_CONVERSION,
                ]
            ),
        )
        .update(update_payload, synchronize_session=False)
    )
    db.commit()

    _record_transition(
        "knowledge.conversion.finalize.success",
        document_id=document_id,
        generation=generation,
        reason="converted" if updated > 0 else "stale_or_already_finalized",
    )
    return updated > 0
