# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Periodic trigger for Xiaoxin's fixed HR knowledge publication."""

from __future__ import annotations

import logging

from app.core.celery_app import celery_app
from app.core.distributed_lock import distributed_lock
from app.db.session import SessionLocal
from app.services.knowledge.xiaoxin import XIAOXIN_HR_RESOURCE_ID
from app.services.knowledge.xiaoxin_sync import (
    get_xiaoxin_daily_sync_skip_reason,
    submit_xiaoxin_hr_sync,
)
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

XIAOXIN_DAILY_SYNC_LOCK_NAME = "sync_xiaoxin_hr_knowledge"
XIAOXIN_DAILY_SYNC_LOCK_TIMEOUT_SECONDS = 120


@celery_app.task(
    name="app.tasks.xiaoxin_knowledge_tasks.sync_xiaoxin_hr_knowledge",
)
@trace_sync(
    span_name="knowledge.xiaoxin_hr_sync",
    tracer_name="knowledge.tasks",
    attributes={
        "knowledge.trigger_source": "daily",
        "knowledge.domain": XIAOXIN_HR_RESOURCE_ID,
    },
)
def sync_xiaoxin_hr_knowledge() -> dict[str, int | str]:
    """Submit one daily refresh through the shared fixed-target service."""
    skip_reason = get_xiaoxin_daily_sync_skip_reason()
    if skip_reason is not None:
        logger.warning(
            "Xiaoxin daily HR knowledge sync skipped",
            extra={
                "trigger_source": "daily",
                "domain": XIAOXIN_HR_RESOURCE_ID,
                "failure_stage": "configuration",
                "error_code": skip_reason.split(":", 1)[0],
                "reason": skip_reason,
            },
        )
        return {"status": "skipped", "reason": skip_reason}

    with distributed_lock.acquire_context(
        XIAOXIN_DAILY_SYNC_LOCK_NAME,
        expire_seconds=XIAOXIN_DAILY_SYNC_LOCK_TIMEOUT_SECONDS,
    ) as acquired:
        if not acquired:
            return {
                "status": "skipped",
                "reason": "lock_held_by_another_instance",
            }

        with SessionLocal() as db:
            submission = submit_xiaoxin_hr_sync(db, trigger_source="daily")

    return {
        "status": "submitted",
        "knowledge_base_id": submission.knowledge_base_id,
        "document_id": submission.document.id,
    }
