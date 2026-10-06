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
from app.db.timezone import database_datetime_now
from app.models.knowledge import DocumentIndexStatus, DocumentStatus, KnowledgeDocument
from app.schemas.knowledge import DocumentProcessingError, DocumentProcessingStage
from app.services.knowledge.external_refresh_snapshot import (
    advance_external_refresh_snapshot,
    capture_external_refresh_snapshot,
    finalize_external_refresh_snapshot,
    restore_external_refresh_snapshot,
)
from app.services.knowledge.processing_errors import generic_processing_error
from shared.knowledge_module import (
    CONVERSION_COMPLETE_STATUSES,
    IndexStateSnapshot,
    active_index_stale_reason,
    decide_conversion_started,
    decide_index_transition,
)
from shared.knowledge_module.index_state import (
    ACTIVE_INDEX_STATUSES as ACTIVE_INDEX_STATUS_VALUES,
)
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync


def conversion_complete_statuses() -> list[DocumentIndexStatus]:
    """The statuses a completed conversion callback may still replace.

    The module owns the rule; the callback endpoint and the state transition
    both read it here so their pre-check and their update can never disagree.
    """
    return [
        DocumentIndexStatus(value) for value in sorted(CONVERSION_COMPLETE_STATUSES)
    ]


def _status_value(status: DocumentIndexStatus | str | None) -> str | None:
    """Return the stored status string for the module's pure decision rules."""
    return getattr(status, "value", status)


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
    DocumentIndexStatus(value) for value in ACTIVE_INDEX_STATUS_VALUES
}


def _index_snapshot(document: KnowledgeDocument | None) -> IndexStateSnapshot | None:
    """Supply primitive state to the module while the caller holds the row lock."""
    if document is None:
        return None
    return IndexStateSnapshot(
        status=_status_value(document.index_status) or "not_indexed",
        generation=document.index_generation or 0,
    )


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
    return active_index_stale_reason(
        _status_value(index_status),
        age_seconds=(
            (database_datetime_now() - updated_at).total_seconds()
            if updated_at is not None
            else None
        ),
        thresholds={
            "queued": settings.KNOWLEDGE_INDEX_STALE_QUEUED_SECONDS,
            "pending_conversion": settings.KNOWLEDGE_INDEX_STALE_PENDING_CONVERSION_SECONDS,
            "indexing": settings.KNOWLEDGE_INDEX_STALE_INDEXING_SECONDS,
            "converting": settings.KNOWLEDGE_INDEX_STALE_CONVERTING_SECONDS,
        },
    )


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
    extract_attributes=lambda db, document_id, allow_if_success=False, replace_active=False, expected_generation=None, capture_refresh_snapshot=False: {
        "knowledge.document_id": document_id,
        "knowledge.allow_if_success": allow_if_success,
        "knowledge.replace_active": replace_active,
    },
)
def _prepare_document_index_enqueue(
    db: Session,
    document_id: int,
    *,
    allow_if_success: bool = False,
    replace_active: bool = False,
    expected_generation: Optional[int] = None,
    capture_refresh_snapshot: bool = False,
) -> IndexEnqueueDecision:
    """
    Implement the atomic transition into a new indexing generation.

    Public callers use one of the preparation functions below so the external
    refresh snapshot policy stays out of the generic enqueue interface.
    """
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    current_status = (
        (document.index_status or DocumentIndexStatus.NOT_INDEXED) if document else None
    )
    decision = decide_index_transition(
        _index_snapshot(document),
        event="enqueue",
        expected_generation=expected_generation,
        allow_if_success=allow_if_success,
        replace_active=replace_active,
        stale=bool(document and _get_active_index_stale_reason(document)),
    )
    if not decision.accepted:
        db.rollback()
        _record_transition(
            "knowledge.index.enqueue.skipped",
            document_id=document_id,
            generation=decision.generation,
            reason=decision.reason,
            previous_status=current_status,
        )
        return IndexEnqueueDecision(
            False, decision.generation, decision.reason, current_status
        )

    superseded_attachment_ids = None
    previous_snapshot_status = current_status
    if decision.reason == "scheduled_after_stale_recovery" and capture_refresh_snapshot:
        superseded_attachment_ids = restore_external_refresh_snapshot(
            document, generation=document.index_generation
        )
        previous_snapshot_status = (
            document.index_status
            if superseded_attachment_ids is not None
            else DocumentIndexStatus.FAILED
        )
    if capture_refresh_snapshot:
        capture_external_refresh_snapshot(
            document,
            generation=decision.generation,
            previous_index_status=previous_snapshot_status,
        )
    document.index_generation = decision.generation
    document.index_status = DocumentIndexStatus(decision.next_status)
    document.clear_processing_error_payload()
    db.commit()
    if superseded_attachment_ids:
        _cleanup_external_refresh_attachments(
            db, owner_user_id=document.user_id, attachment_ids=superseded_attachment_ids
        )
    _record_transition(
        "knowledge.index.enqueue.scheduled",
        document_id=document_id,
        generation=decision.generation,
        reason=decision.reason,
        previous_status=current_status,
    )
    return IndexEnqueueDecision(
        True, decision.generation, decision.reason, current_status
    )


def prepare_document_index_enqueue(
    db: Session,
    document_id: int,
    *,
    allow_if_success: bool = False,
    replace_active: bool = False,
    expected_generation: Optional[int] = None,
) -> IndexEnqueueDecision:
    """Prepare an ordinary document for a new indexing generation."""
    return _prepare_document_index_enqueue(
        db,
        document_id,
        allow_if_success=allow_if_success,
        replace_active=replace_active,
        expected_generation=expected_generation,
        capture_refresh_snapshot=False,
    )


def prepare_external_refresh_enqueue(
    db: Session,
    document_id: int,
    *,
    expected_generation: Optional[int] = None,
) -> IndexEnqueueDecision:
    """Atomically preserve the live body and queue a synchronized refresh.

    Snapshot capture and stale-attempt recovery run while the document row is
    locked by the same transaction that advances ``index_generation``. This
    keeps callers from having to coordinate snapshot ordering themselves.
    """
    return _prepare_document_index_enqueue(
        db,
        document_id,
        allow_if_success=True,
        expected_generation=expected_generation,
        capture_refresh_snapshot=True,
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
    preserve_active_sync_index: bool = False,
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
        preserve_active_sync_index=preserve_active_sync_index,
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
    current_status = (
        (document.index_status or DocumentIndexStatus.NOT_INDEXED) if document else None
    )
    decision = decide_index_transition(
        _index_snapshot(document), event="start", generation=generation
    )
    if not decision.accepted:
        db.rollback()
        _record_transition(
            "knowledge.index.start.skipped",
            document_id=document_id,
            generation=generation,
            reason=decision.reason,
            previous_status=current_status,
        )
        return IndexExecutionDecision(False, decision.reason)

    document.index_status = DocumentIndexStatus(decision.next_status)
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


def _finalize_external_source_on_success(
    document: KnowledgeDocument,
) -> None:
    """Record when the copy last imported and which body that success served.

    Source health is never inferred from indexing here.
    """
    if not document.has_external_identity:
        return

    external = document.external_source_config
    sync = external.get("sync")
    updates: dict[str, object] = {
        "last_success_at": datetime.now(timezone.utc).isoformat(),
        "last_success_attachment_id": document.attachment_id,
    }
    if isinstance(sync, dict) and sync.get("enabled"):
        sync = dict(sync)
        sync["indexed_version"] = sync.get("content_version")
        sync["last_synced_at"] = datetime.now(timezone.utc).isoformat()
        sync.pop("last_error_code", None)
        sync.pop("last_error_retryable", None)
        sync.pop("failed_version", None)
        updates["sync"] = sync
    document.update_external_source_config(**updates)


def _cleanup_external_refresh_attachments(
    db: Session,
    *,
    owner_user_id: int,
    attachment_ids: set[int],
) -> None:
    """Best-effort cleanup after a refresh snapshot reaches a terminal state."""
    from app.services.knowledge.attachment_cleanup import (
        delete_attachment_best_effort,
    )

    for attachment_id in attachment_ids:
        delete_attachment_best_effort(
            db,
            owner_user_id,
            attachment_id,
            retry_orphan_cleanup=True,
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
    decision = decide_index_transition(
        _index_snapshot(document), event="success", generation=generation
    )
    if not decision.accepted:
        db.rollback()
        _record_transition(
            "knowledge.index.finalize.success",
            document_id=document_id,
            generation=generation,
            reason="stale_or_already_finalized",
        )
        return False

    cleanup_attachment_ids = finalize_external_refresh_snapshot(
        document,
        generation=generation,
    )
    document.index_status = DocumentIndexStatus(decision.next_status)
    document.is_active = True
    document.status = DocumentStatus.ENABLED
    if chunk_storage_enabled:
        document.chunks = chunks
    else:
        document.chunks = (
            {
                field: chunks[field]
                for field in ("splitter_subtype", "qa_pair_count")
                if field in chunks
            }
            if chunks
            else None
        )
    _finalize_external_source_on_success(document)

    db.commit()
    if cleanup_attachment_ids:
        _cleanup_external_refresh_attachments(
            db,
            owner_user_id=document.user_id,
            attachment_ids=cleanup_attachment_ids,
        )
    _record_transition(
        "knowledge.index.finalize.success",
        document_id=document_id,
        generation=generation,
        reason="finalized",
    )
    return True


def _load_active_index_attempt(
    db: Session, document_id: int, generation: int
) -> Optional[KnowledgeDocument]:
    """Lock the document when this attempt still owns the active generation.

    Returns ``None`` after rolling back when the attempt lost its write right
    (the document is gone, or a newer generation took over), so no caller ever
    finalizes a state it no longer owns.
    """
    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    decision = decide_index_transition(
        _index_snapshot(document), event="failure", generation=generation
    )
    if not decision.accepted:
        db.rollback()
        return None
    return document


def _persist_attempt_failure(
    document: KnowledgeDocument,
    generation: int,
    candidate: DocumentProcessingError,
) -> DocumentProcessingError:
    """Store the attempt's failure for the user and return what was stored."""
    persisted_error = _normalize_processing_error(candidate, generation)
    document.set_processing_error_payload(persisted_error.model_dump(mode="json"))
    return persisted_error


def _normalize_processing_error(
    candidate: DocumentProcessingError,
    generation: int,
) -> DocumentProcessingError:
    """Stamp a failure with this attempt's identity, falling back when unusable."""
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
    return persisted_error


def _serves_previously_indexed_body(document: KnowledgeDocument) -> bool:
    """Whether the copy still holds the body its last successful import indexed.

    A refresh only replaces the attached body once the new one lands, so an
    attempt that failed before that leaves the attachment the last successful
    import indexed in place, and only that body's index is still in service.
    Legacy copies record their served attachment before a refresh begins, so
    a timestamp alone never makes an unindexed replacement look successful.
    """
    external = document.external_source_config
    if not document.attachment_id or not external:
        return False
    indexed_attachment_id = external.get("last_success_attachment_id")
    return (
        indexed_attachment_id is not None
        and indexed_attachment_id == document.attachment_id
    )


@trace_sync(
    span_name="knowledge.mark_document_index_failed",
    tracer_name="knowledge.state_machine",
    extract_attributes=lambda db, document_id, generation, **_: {
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
    preserve_active_sync_index: bool = False,
) -> bool:
    """Persist a failed processing result for the active generation.

    The document itself is never deleted by a failure, so the user can retry
    the initial import on the same record. A copy that still serves a body
    keeps serving it: a synchronized refresh restores the body it replaced,
    and a copy whose last successful body is still attached keeps that body's
    index while only the source's own health moves.
    """
    document = _load_active_index_attempt(db, document_id, generation)
    if document is None:
        return False

    candidate = error or generic_processing_error(
        generation=generation,
        stage=DocumentProcessingStage.SYSTEM,
    )
    cleanup_attachment_ids = restore_external_refresh_snapshot(
        document,
        generation=generation,
    )
    snapshot_restored = cleanup_attachment_ids is not None
    external = document.external_source_config
    sync = external.get("sync")
    has_active_sync_index = bool(
        not snapshot_restored
        and preserve_active_sync_index
        and document.is_active
        and document.attachment_id
        and isinstance(sync, dict)
        and sync.get("enabled")
        and sync.get("indexed_version")
    )
    # A copy imported before a synchronized version was recorded still serves
    # the body its last successful import indexed, so an attempt that fetched
    # no replacement leaves that body and its index in service and reports the
    # failure on the source instead.
    keeps_served_body = bool(
        not snapshot_restored
        and preserve_active_sync_index
        and not has_active_sync_index
        and _serves_previously_indexed_body(document)
    )
    if snapshot_restored:
        # The restored snapshot already carries the previous body's outcome;
        # this attempt only reports what it learned about the source.
        persisted_error = _normalize_processing_error(candidate, generation)
    else:
        persisted_error = _persist_attempt_failure(document, generation, candidate)
        if has_active_sync_index:
            document.clear_processing_error_payload()
            document.index_status = DocumentIndexStatus.SUCCESS
        elif keeps_served_body:
            document.index_status = DocumentIndexStatus.SUCCESS
            document.is_active = True
        else:
            document.index_status = DocumentIndexStatus.FAILED
    if document.has_external_identity and (
        snapshot_restored
        or has_active_sync_index
        or keeps_served_body
        or persisted_error.code
        in {"external_source_unavailable", "external_source_missing"}
    ):
        updates: dict[str, object] = {
            "status": (
                "inaccessible"
                if persisted_error.code
                in {"external_source_unavailable", "external_source_missing"}
                else "sync_error"
            ),
            "last_error": persisted_error.message,
        }
        if isinstance(sync, dict) and sync.get("enabled"):
            sync = dict(sync)
            sync["last_error_code"] = persisted_error.code
            updates["sync"] = sync
        document.update_external_source_config(**updates)

    db.commit()
    if cleanup_attachment_ids:
        _cleanup_external_refresh_attachments(
            db,
            owner_user_id=document.user_id,
            attachment_ids=cleanup_attachment_ids,
        )
    if snapshot_restored:
        reason = "external_refresh_snapshot_restored"
    elif keeps_served_body:
        reason = "served_body_kept"
    elif has_active_sync_index:
        reason = "source_unavailable_active_index_preserved"
    else:
        reason = "finalized"
    _record_transition(
        "knowledge.index.finalize.failed",
        document_id=document_id,
        generation=generation,
        reason=reason,
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
    advance_external_refresh_snapshot(
        document,
        expected_generation=expected_generation,
        next_generation=next_generation,
    )
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

    current_status = document.index_status or DocumentIndexStatus.NOT_INDEXED
    decision = decide_conversion_started(
        generation=generation,
        current_generation=document.index_generation,
        status=_status_value(current_status),
    )
    if not decision.should_execute:
        db.rollback()
        _record_transition(
            "knowledge.conversion.start.skipped",
            document_id=document_id,
            generation=generation,
            reason=decision.reason,
            previous_status=current_status,
        )
        return IndexExecutionDecision(
            should_execute=False,
            reason=decision.reason,
        )

    document.index_status = DocumentIndexStatus.CONVERTING
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
    }
    # No longer update file_extension / name / file_size.
    # These fields keep their original file values so users can download the source document.
    # Converted content is referenced via source_config["converted_attachment_id"].

    updated = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == document_id,
            KnowledgeDocument.index_generation == generation,
            KnowledgeDocument.index_status.in_(conversion_complete_statuses()),
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
