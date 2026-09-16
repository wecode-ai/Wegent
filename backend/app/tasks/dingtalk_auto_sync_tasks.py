# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dispatch daily DingTalk copy updates through the existing Celery workers."""

import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument, KnowledgeDocumentExternalSource
from app.services.knowledge.dingtalk_auto_sync import (
    SCAN_EXPIRES_SECONDS,
    refresh_dingtalk_copy,
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


def _task_id(source: object, fallback: str) -> str:
    """Read a Celery task id so this run can be found in the worker logs."""
    return str(getattr(source, "id", None) or fallback)


@celery_app.task(
    bind=True, name="app.tasks.dingtalk_auto_sync_tasks.scan_dingtalk_copies"
)
@trace_sync(tracer_name="knowledge.auto_sync")
def scan_dingtalk_copies(self, knowledge_base_id: int | None = None) -> int:
    """Page through eligible copies and queue one refresh task for each.

    One bad dispatch must not block the other copies. The scan always says what
    it did, because the manual endpoint answers 202 before any of it has run.
    """
    from app.core.distributed_lock import distributed_lock

    task_id = _task_id(self.request, "direct")
    with distributed_lock.acquire_context(
        f"scan_dingtalk_copies:{knowledge_base_id or 'all'}", expire_seconds=60 * 60
    ) as acquired:
        if not acquired:
            logger.info(
                "[DingTalk Sync] scan skipped kb_id=%s task_id=%s "
                "reason=lock_not_acquired",
                knowledge_base_id,
                task_id,
            )
            return 0
        result = _dispatch_copies(knowledge_base_id, task_id)
    logger.info(
        "[DingTalk Sync] scan done kb_id=%s task_id=%s copies_examined=%s "
        "copies_dispatched=%s",
        knowledge_base_id,
        task_id,
        result.examined,
        result.dispatched,
    )
    return result.dispatched


def _eligible_copies_query(db: Session, knowledge_base_id: int | None, cursor: int):
    """Page over settled DingTalk copies in knowledge bases that opted in."""
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
    return query.order_by(KnowledgeDocument.id).limit(BATCH_SIZE)


def _dispatch_copies(
    knowledge_base_id: int | None = None, task_id: str = "direct"
) -> _ScanResult:
    """Walk every page of eligible copies, queueing a refresh for each."""
    cursor, examined, dispatched = 0, 0, 0
    with SessionLocal() as db:
        while True:
            rows = _eligible_copies_query(db, knowledge_base_id, cursor).all()
            if not rows:
                return _ScanResult(examined=examined, dispatched=dispatched)
            examined += len(rows)
            for document_id, generation in rows:
                try:
                    queued = refresh_dingtalk_copy_task.apply_async(
                        args=[document_id, generation], expires=SCAN_EXPIRES_SECONDS
                    )
                except Exception:
                    logger.exception(
                        "[DingTalk Sync] dispatch failed document_id=%s generation=%s",
                        document_id,
                        generation,
                    )
                    continue
                dispatched += 1
                logger.info(
                    "[DingTalk Sync] dispatched document_id=%s kb_id=%s "
                    "generation=%s task_id=%s refresh_task_id=%s",
                    document_id,
                    knowledge_base_id,
                    generation,
                    task_id,
                    _task_id(queued, "unavailable"),
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
    """Refresh one copy by probing it first; see ``refresh_dingtalk_copy``."""
    with SessionLocal() as db:
        try:
            return refresh_dingtalk_copy(db, document_id, expected_generation)
        except Exception:
            # Expected outcomes log themselves; this keeps an unexpected
            # failure attributable to one copy as well.
            logger.exception(
                "[DingTalk Sync] refresh failed document_id=%s generation=%s "
                "task_id=%s",
                document_id,
                expected_generation,
                _task_id(self.request, "unavailable"),
            )
            raise
