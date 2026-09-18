# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Periodic coordinator for all synchronized external document providers."""

import asyncio
import logging
import time
from dataclasses import asdict

from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.db.session import SessionLocal
from app.services.knowledge.external_document_sync import (
    SyncReport,
    external_document_sync_module,
)
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

_LOCK_NAME = "external-document-sync:daily"


def _log_sync_report(report: SyncReport, elapsed_seconds: float) -> None:
    summaries = sorted(
        report.connection_summaries.values(),
        key=lambda item: (
            item.provider_id,
            item.owner_user_id,
            item.connection_id,
        ),
    )
    for summary in summaries:
        logger.info(
            "[External Sync] connection provider=%s owner_user_id=%s "
            "connection_name=%r connection_id=%r scanned=%s eligible=%s "
            "updates_detected=%s update_tasks_queued=%s refresh_queued=%s "
            "reindex_queued=%s unchanged=%s source_missing=%s skipped=%s failed=%s",
            summary.provider_id,
            summary.owner_user_id,
            summary.connection_name,
            summary.connection_id,
            summary.scanned,
            summary.eligible,
            summary.updates_detected,
            summary.refresh_queued + summary.reindex_queued,
            summary.refresh_queued,
            summary.reindex_queued,
            summary.unchanged,
            summary.source_missing,
            summary.skipped,
            summary.failed,
        )
    logger.info(
        "[External Sync] total scanned=%s eligible=%s updates_detected=%s "
        "update_tasks_queued=%s refresh_queued=%s reindex_queued=%s "
        "unchanged=%s source_missing=%s skipped=%s failed=%s next_cursors=%s "
        "elapsed_seconds=%.3f",
        report.scanned,
        report.eligible,
        report.updates_detected,
        report.refreshed + report.reindexed,
        report.refreshed,
        report.reindexed,
        report.unchanged,
        report.source_missing,
        report.skipped,
        report.failed,
        report.next_cursors,
        elapsed_seconds,
    )


@celery_app.task(name="app.tasks.external_document_sync_tasks.sync_external_documents")
@trace_sync(
    span_name="knowledge.sync_external_documents",
    tracer_name="knowledge.tasks",
)
def sync_external_documents_task() -> dict[str, object]:
    if not settings.EXTERNAL_DOC_SYNC_ENABLED:
        return {"status": "disabled"}
    started_at = time.perf_counter()
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
                    db,
                    scan_limit=settings.EXTERNAL_DOC_SYNC_SCAN_BATCH_SIZE,
                    max_documents=settings.EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS,
                    time_budget_seconds=settings.EXTERNAL_DOC_SYNC_TIME_BUDGET_SECONDS,
                )
            )
    _log_sync_report(report, time.perf_counter() - started_at)
    return {"status": "completed", **asdict(report)}
