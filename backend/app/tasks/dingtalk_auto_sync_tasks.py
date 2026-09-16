# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dispatch daily DingTalk copy updates through the existing Celery workers."""

import logging

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument, KnowledgeDocumentExternalSource
from app.services.knowledge.index_state_machine import ACTIVE_INDEX_STATUSES
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)
BATCH_SIZE = 100


@celery_app.task(name="app.tasks.dingtalk_auto_sync_tasks.scan_dingtalk_copies")
@trace_sync(tracer_name="knowledge.auto_sync")
def scan_dingtalk_copies(knowledge_base_id: int | None = None) -> int:
    """Page through eligible copies; one bad dispatch must not block other copies."""
    from app.core.distributed_lock import distributed_lock

    with distributed_lock.acquire_context(
        f"scan_dingtalk_copies:{knowledge_base_id or 'all'}", expire_seconds=60 * 60
    ) as acquired:
        if not acquired:
            return 0
        return _dispatch_copies(knowledge_base_id)


def _dispatch_copies(knowledge_base_id: int | None = None) -> int:
    cursor, dispatched = 0, 0
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
                return dispatched
            for document_id, generation in rows:
                try:
                    refresh_dingtalk_copy_task.apply_async(
                        args=[document_id, generation], expires=24 * 60 * 60
                    )
                    dispatched += 1
                except Exception:
                    logger.exception("Failed to dispatch DingTalk copy %s", document_id)
            cursor = rows[-1].id
            # Release the read snapshot between pages and see newly changed settings.
            db.rollback()


@celery_app.task(name="app.tasks.dingtalk_auto_sync_tasks.refresh_dingtalk_copy")
@trace_sync(tracer_name="knowledge.auto_sync")
def refresh_dingtalk_copy_task(document_id: int, expected_generation: int) -> bool:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    with SessionLocal() as db:
        return refresh_dingtalk_copy(db, document_id, expected_generation)
