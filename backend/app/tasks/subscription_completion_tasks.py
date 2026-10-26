# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Deliver Rust-completed subscription notifications through existing channels."""

import asyncio
import logging

from app.core.celery_app import celery_app
from app.core.events import TaskCompletedEvent
from app.db.session import get_db_session
from app.models.subscription import BackgroundExecution
from app.services.subscription.task_completion_handler import (
    SubscriptionTaskCompletionHandler,
)
from shared.telemetry.decorators import trace_background

logger = logging.getLogger(__name__)


@celery_app.task(
    name="app.tasks.subscription_completion_tasks.notify_execution", ignore_result=True
)
@trace_background("subscription.notify_execution", "subscription.worker")
def notify_execution(execution_id: int) -> None:
    """Read committed results; do not replay completion writes or runtime cleanup."""
    with get_db_session() as db:
        execution = db.get(BackgroundExecution, execution_id)
        if not execution or execution.status not in {"COMPLETED", "FAILED"}:
            logger.info(
                "Skipping subscription notification: execution_id=%s", execution_id
            )
            return
        handler = SubscriptionTaskCompletionHandler()
        if handler._is_code_wiki_scheduled_update(db, execution):
            return
        event = TaskCompletedEvent(
            task_id=execution.task_id,
            subtask_id=0,
            user_id=execution.user_id,
            status=execution.status,
            result=None,
            error=execution.error_message or None,
        )
        asyncio.run(
            handler._dispatch_notifications(
                db, execution, event, execution.result_summary
            )
        )
