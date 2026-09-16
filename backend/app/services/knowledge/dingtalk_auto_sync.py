# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Daily refresh of explicitly enabled knowledge-base copies."""

import asyncio
import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.services.knowledge.external_document_import import (
    external_document_import_service,
)
from app.services.knowledge.external_document_providers import (
    ExternalDocumentFetchError,
    get_external_document_provider,
)
from app.services.knowledge.index_state_machine import ACTIVE_INDEX_STATUSES
from app.services.knowledge.knowledge_service import KnowledgeService
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

SYNC_LOG_PREFIX = "[DingTalk Sync]"


def is_copy_sync_enabled(knowledge_base: Kind) -> bool:
    """Whether a knowledge base has opted into daily copy refreshes."""
    spec = knowledge_base.json.get("spec", {})
    return bool(spec.get("dingtalkAutoSyncEnabled", False))


def queue_dingtalk_scan(knowledge_base_id: int | None = None) -> str:
    """Queue the daily scan for one knowledge base, or for every enabled one."""
    from app.tasks.dingtalk_auto_sync_tasks import scan_dingtalk_copies

    task = scan_dingtalk_copies.apply_async(
        args=[knowledge_base_id], expires=24 * 60 * 60
    )
    return task.id


def log_sync_decision(
    decision: str, *, level: int = logging.INFO, **fields: object
) -> None:
    """Write one grep-able decision line for a single copy attempt.

    Every attempt leaves exactly one of these lines, so a sync run can be
    reconstructed from logs alone: which copy, which baseline, which live
    timestamp and what was decided about it. Empty fields are omitted to keep
    the line readable.
    """
    details = " ".join(
        f"{name}={value}" for name, value in fields.items() if value not in (None, "")
    )
    logger.log(level, "%s decision=%s %s", SYNC_LOG_PREFIX, decision, details)


@dataclass(frozen=True)
class _CopyContext:
    """Resolved inputs of one copy attempt, or why the attempt cannot run."""

    document: KnowledgeDocument | None = None
    user: User | None = None
    reason: str = ""

    @property
    def eligible(self) -> bool:
        return self.document is not None and self.user is not None


def _status_name(status: object) -> str:
    """Render an index status for logs without leaking the enum repr."""
    return str(getattr(status, "value", status) or "")


def _resolve_copy_context(
    db: Session, document_id: int, expected_generation: int
) -> _CopyContext:
    """Resolve current settings and the original importer permission.

    Rejections carry a reason instead of returning ``None`` so a scheduled
    copy that is skipped can still be explained from logs.
    """
    document = db.get(KnowledgeDocument, document_id, populate_existing=True)
    if document is None:
        return _CopyContext(reason="document_not_found")
    if document.external_provider != "dingtalk":
        return _CopyContext(document=document, reason="not_a_dingtalk_copy")
    if document.index_generation != expected_generation:
        return _CopyContext(document=document, reason="stale_generation")
    if document.index_status in ACTIVE_INDEX_STATUSES:
        return _CopyContext(document=document, reason="index_in_progress")
    user = db.get(User, document.user_id)
    if user is None:
        return _CopyContext(document=document, reason="importer_missing")
    if not user.is_active:
        return _CopyContext(document=document, reason="importer_inactive")
    kb, has_access = KnowledgeService.get_knowledge_base(db, document.kind_id, user.id)
    if not kb or not has_access:
        return _CopyContext(document=document, reason="knowledge_base_access_lost")
    if not is_copy_sync_enabled(kb):
        return _CopyContext(document=document, reason="auto_sync_disabled")
    if not KnowledgeService.can_manage_knowledge_base_documents(
        db, document.kind_id, user.id
    ):
        return _CopyContext(document=document, reason="manage_permission_required")

    return _CopyContext(document=document, user=user)


def _log_rejected_copy(
    context: _CopyContext, document_id: int, expected_generation: int, stage: str
) -> None:
    """Explain a copy that was filtered out before any provider call."""
    document = context.document
    log_sync_decision(
        "not_eligible",
        stage=stage,
        document_id=document_id,
        kb_id=document.kind_id if document else None,
        generation=expected_generation,
        reason=context.reason,
        index_status=_status_name(document.index_status) if document else None,
        index_generation=document.index_generation if document else None,
        provider=document.external_provider if document else None,
    )


@trace_sync(tracer_name="knowledge.auto_sync")
def refresh_dingtalk_copy(
    db: Session, document_id: int, expected_generation: int
) -> bool:
    """Probe before invalidating a copy, then queue the regular refresh.

    The queued refresh is the same path a manual reimport takes, so the body
    fetch stays the single owner of the imported content and its baseline.
    Each attempt logs one ``[DingTalk Sync]`` decision line holding the
    compared baseline, the live timestamp and the resulting action.
    """
    context = _resolve_copy_context(db, document_id, expected_generation)
    if not context.eligible:
        _log_rejected_copy(context, document_id, expected_generation, "precheck")
        return False
    document, user = context.document, context.user
    baseline_before_probe = document.external_source_config.get("source_update_time")
    provider = get_external_document_provider("dingtalk")
    try:
        update_time = asyncio.run(
            provider.get_update_time(user, document.external_resource_id)
        )
    except ExternalDocumentFetchError as exc:
        log_sync_decision(
            "probe_failed",
            level=logging.WARNING,
            document_id=document_id,
            kb_id=document.kind_id,
            generation=expected_generation,
            baseline_update_time=baseline_before_probe,
            error=str(exc),
        )
        return False
    # End the snapshot held across provider I/O before checking a concurrent update.
    db.rollback()
    context = _resolve_copy_context(db, document_id, expected_generation)
    if not context.eligible:
        _log_rejected_copy(context, document_id, expected_generation, "recheck")
        return False
    document, user = context.document, context.user
    baseline = document.external_source_config.get("source_update_time")
    status_before = _status_name(document.index_status)
    if (
        update_time is not None
        and document.index_status == DocumentIndexStatus.SUCCESS
        and document.is_active
        and document.attachment_id
        and baseline == update_time
    ):
        log_sync_decision(
            "unchanged",
            document_id=document.id,
            kb_id=document.kind_id,
            generation=expected_generation,
            baseline_update_time=baseline,
            live_update_time=update_time,
            attachment_id=document.attachment_id,
        )
        return False
    metadata = {
        "provider": "dingtalk",
        "resource_id": document.external_resource_id,
        "title": document.external_source_config.get("title") or document.name,
        "url": document.external_source_config.get("url", ""),
    }
    result = external_document_import_service.refresh_existing_document(
        db, document, metadata, expected_generation=expected_generation
    )
    log_sync_decision(
        "refresh" if result.started else "refresh_not_started",
        document_id=document.id,
        kb_id=document.kind_id,
        generation=expected_generation,
        baseline_update_time=baseline,
        # A missing live timestamp is itself the reason to refresh, not a gap.
        live_update_time=update_time if update_time is not None else "unavailable",
        index_status_before=status_before,
        previous_attachment_id=document.attachment_id,
        next_generation=result.document.index_generation if result.started else None,
        reason=result.reason,
    )
    return result.started
