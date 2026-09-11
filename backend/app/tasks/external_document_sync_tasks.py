# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Periodic coordinator for all synchronized external document providers."""

import asyncio
import logging

from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.db.session import SessionLocal
from app.services.knowledge.external_document_sync import (
    external_document_sync_module,
)
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

_LOCK_NAME = "external-document-sync:daily"


@celery_app.task(name="app.tasks.external_document_sync_tasks.sync_external_documents")
@trace_sync(
    span_name="knowledge.sync_external_documents",
    tracer_name="knowledge.tasks",
)
def sync_external_documents_task() -> dict[str, int | str]:
    if not settings.EXTERNAL_DOC_SYNC_ENABLED:
        return {"status": "disabled"}
    with distributed_lock.acquire_watchdog_context(
        _LOCK_NAME,
        expire_seconds=settings.EXTERNAL_DOC_SYNC_LOCK_TTL_SECONDS,
        extend_interval_seconds=max(
            10, settings.EXTERNAL_DOC_SYNC_LOCK_TTL_SECONDS // 3
        ),
    ) as acquired:
        if not acquired:
            return {"status": "locked"}
        with SessionLocal() as db:
            report = asyncio.run(
                external_document_sync_module.run_daily_sync(
                    db, scan_limit=settings.EXTERNAL_DOC_SYNC_SCAN_LIMIT
                )
            )
    logger.info(
        "[External Sync] scanned=%s eligible=%s unchanged=%s refreshed=%s "
        "reindexed=%s skipped=%s failed=%s next_cursor=%s",
        report.scanned,
        report.eligible,
        report.unchanged,
        report.refreshed,
        report.reindexed,
        report.skipped,
        report.failed,
        report.next_cursor,
    )
    return {"status": "completed", **report.__dict__}
