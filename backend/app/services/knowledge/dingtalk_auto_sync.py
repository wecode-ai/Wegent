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

SCAN_EXPIRES_SECONDS = 24 * 60 * 60


def is_copy_sync_enabled(knowledge_base: Kind) -> bool:
    """Whether a knowledge base has opted into daily copy refreshes."""
    spec = knowledge_base.json.get("spec", {})
    return bool(spec.get("dingtalkAutoSyncEnabled", False))


def queue_dingtalk_scan(knowledge_base_id: int | None = None) -> str:
    """Queue the daily scan for one knowledge base, or for every enabled one."""
    from app.tasks.dingtalk_auto_sync_tasks import scan_dingtalk_copies

    task = scan_dingtalk_copies.apply_async(
        args=[knowledge_base_id], expires=SCAN_EXPIRES_SECONDS
    )
    return task.id


@dataclass(frozen=True)
class _CopyContext:
    """Resolved inputs of one copy attempt, or why the attempt cannot run."""

    document: KnowledgeDocument | None = None
    user: User | None = None
    reason: str = ""

    @property
    def eligible(self) -> bool:
        return self.document is not None and self.user is not None


def _resolve_copy_context(
    db: Session, document_id: int, expected_generation: int
) -> _CopyContext:
    """Resolve current settings and the original importer permission.

    Rejections carry a reason instead of returning ``None`` so a scheduled
    copy that is skipped can be explained in one log line.
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


def _log_skipped_copy(
    context: _CopyContext, document_id: int, expected_generation: int, stage: str
) -> None:
    """Explain a copy that was filtered out before any provider call."""
    logger.info(
        "[DingTalk Sync] skip stage=%s document_id=%s generation=%s reason=%s",
        stage,
        document_id,
        expected_generation,
        context.reason,
    )


def _is_unchanged(
    document: KnowledgeDocument, baseline: int | None, update_time: int | None
) -> bool:
    """Whether the probe gives no evidence that an available copy changed.

    A probe that reports no usable time is not evidence of change: an available
    copy that already has a baseline keeps it, while a copy without one still
    refreshes because only a refresh can establish that baseline.
    """
    no_evidence_of_change = (
        baseline is not None if update_time is None else baseline == update_time
    )
    return bool(
        no_evidence_of_change
        and document.index_status == DocumentIndexStatus.SUCCESS
        and document.is_active
        and document.attachment_id
    )


def _queue_refresh(
    db: Session, document: KnowledgeDocument, expected_generation: int
) -> bool:
    """Queue the refresh a manual reimport performs and report the outcome."""
    result = external_document_import_service.refresh_existing_document(
        db, document, expected_generation=expected_generation
    )
    logger.info(
        "[DingTalk Sync] refresh document_id=%s generation=%s started=%s outcome=%s",
        document.id,
        expected_generation,
        result.started,
        result.reason or "queued",
    )
    return result.started


@trace_sync(tracer_name="knowledge.auto_sync")
def refresh_dingtalk_copy(
    db: Session, document_id: int, expected_generation: int
) -> bool:
    """Probe before invalidating a copy, then queue the regular refresh.

    The queued refresh is the same path a manual reimport takes, so the body
    fetch stays the single owner of the imported content and its baseline.
    """
    context = _resolve_copy_context(db, document_id, expected_generation)
    if not context.eligible:
        _log_skipped_copy(context, document_id, expected_generation, "precheck")
        return False
    document, user = context.document, context.user
    provider = get_external_document_provider("dingtalk")
    try:
        update_time = asyncio.run(
            provider.get_update_time(user, document.external_resource_id)
        )
    except ExternalDocumentFetchError as exc:
        logger.warning(
            "[DingTalk Sync] probe failed document_id=%s generation=%s error=%s",
            document_id,
            expected_generation,
            exc,
        )
        return False
    # End the snapshot held across provider I/O before checking a concurrent update.
    db.rollback()
    context = _resolve_copy_context(db, document_id, expected_generation)
    if not context.eligible:
        _log_skipped_copy(context, document_id, expected_generation, "recheck")
        return False
    document = context.document
    baseline = document.external_source_config.get("source_update_time")
    if _is_unchanged(document, baseline, update_time):
        logger.info(
            "[DingTalk Sync] unchanged document_id=%s generation=%s "
            "baseline_update_time=%s live_update_time=%s",
            document.id,
            expected_generation,
            baseline,
            update_time,
        )
        return False
    return _queue_refresh(db, document, expected_generation)
