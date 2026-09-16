# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dispatch daily DingTalk copy updates through the existing Celery workers."""

import logging
from dataclasses import dataclass

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument, KnowledgeDocumentExternalSource
from app.services.knowledge.dingtalk_auto_sync import (
    SYNC_LOG_PREFIX,
    log_sync_decision,
)
from app.services.knowledge.index_state_machine import ACTIVE_INDEX_STATUSES
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)
BATCH_SIZE = 100


@dataclass(frozen=True)
class _ScanResult:
    """How many copies the scan looked at and how many it queued."""

    examined: int = 0
    dispatched: int = 0


def _celery_task_id(task: object) -> str:
    """Identify the running task so its log lines can be correlated."""
    request = getattr(task, "request", None)
    return str(getattr(request, "id", None) or "direct")


def _queued_task_id(result: object) -> str:
    """Identify a queued task so the worker log that runs it can be found."""
    return str(getattr(result, "id", None) or "unavailable")


@celery_app.task(
    bind=True, name="app.tasks.dingtalk_auto_sync_tasks.scan_dingtalk_copies"
)
@trace_sync(tracer_name="knowledge.auto_sync")
def scan_dingtalk_copies(self, knowledge_base_id: int | None = None) -> int:
    """Page through eligible copies; one bad dispatch must not block other copies.

    The scan never returns a bare zero: skipped runs, dispatched copies and the
    final count each leave a ``[DingTalk Sync]`` line, because the manual
    endpoint answers 202 before any of that work has happened.
    """
    from app.core.distributed_lock import distributed_lock

    task_id = _celery_task_id(self)
    with distributed_lock.acquire_context(
        f"scan_dingtalk_copies:{knowledge_base_id or 'all'}", expire_seconds=60 * 60
    ) as acquired:
        if not acquired:
            log_sync_decision(
                "scan_skipped",
                task_id=task_id,
                kb_id=knowledge_base_id,
                reason="lock_not_acquired",
            )
            return 0
        result = _dispatch_copies(knowledge_base_id, task_id)
    log_sync_decision(
        "scan_done",
        task_id=task_id,
        kb_id=knowledge_base_id,
        copies_examined=result.examined,
        copies_dispatched=result.dispatched,
    )
    return result.dispatched


def _dispatch_copies(
    knowledge_base_id: int | None = None, task_id: str = "direct"
) -> _ScanResult:
    cursor, examined, dispatched = 0, 0, 0
    with SessionLocal() as db:
        while True:
            query = (
                db.query(KnowledgeDocument.id, KnowledgeDocument.index_generation)
                .join(KnowledgeDocument.external_source)
                .join(Kind, Kind.id == KnowledgeDocument.kind_id)
                .filter(
                    KnowledgeDocument.id > cursor,
                    KnowledgeDocumentExternalSource.external_provider == "dingtalk",
                    KnowledgeDocument.index_status.notin_(ACTIVE_INDEX_STATUSES),
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active.is_(True),
                    Kind.json["spec"]["dingtalkAutoSyncEnabled"].as_boolean().is_(True),
                )
            )
            if knowledge_base_id is not None:
                query = query.filter(KnowledgeDocument.kind_id == knowledge_base_id)
            rows = query.order_by(KnowledgeDocument.id).limit(BATCH_SIZE).all()
            if not rows:
                return _ScanResult(examined=examined, dispatched=dispatched)
            examined += len(rows)
            for document_id, generation in rows:
                try:
                    queued = refresh_dingtalk_copy_task.apply_async(
                        args=[document_id, generation], expires=24 * 60 * 60
                    )
                except Exception:
                    logger.exception(
                        "%s decision=dispatch_failed document_id=%s generation=%s",
                        SYNC_LOG_PREFIX,
                        document_id,
                        generation,
                    )
                    continue
                dispatched += 1
                log_sync_decision(
                    "scan_dispatched",
                    task_id=task_id,
                    kb_id=knowledge_base_id,
                    document_id=document_id,
                    generation=generation,
                    refresh_task_id=_queued_task_id(queued),
                )
            cursor = rows[-1].id
            # Release the read snapshot between pages and see newly changed settings.
            db.rollback()


@celery_app.task(
    bind=True, name="app.tasks.dingtalk_auto_sync_tasks.refresh_dingtalk_copy"
)
@trace_sync(tracer_name="knowledge.auto_sync")
def refresh_dingtalk_copy_task(
    self, document_id: int, expected_generation: int
) -> bool:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    with SessionLocal() as db:
        try:
            return refresh_dingtalk_copy(db, document_id, expected_generation)
        except Exception:
            # The decision line covers every expected outcome; this keeps
            # unexpected failures attributable to one copy as well.
            logger.exception(
                "%s decision=refresh_failed document_id=%s generation=%s task_id=%s",
                SYNC_LOG_PREFIX,
                document_id,
                expected_generation,
                _celery_task_id(self),
            )
            raise
