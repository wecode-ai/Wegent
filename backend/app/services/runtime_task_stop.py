# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persist user cancellation before any transport sends a Runtime stop command."""

import logging

from sqlalchemy.orm import Session

from app.services.loop_item_executions.service import loop_item_execution_service

logger = logging.getLogger(__name__)


def record_runtime_task_user_stop(
    db: Session, *, user_id: int, device_id: str, task_id: str
) -> None:
    execution = loop_item_execution_service.execution_for_runtime(
        db,
        runtime_device_id=device_id,
        runtime_task_id=task_id,
        owner_user_id=user_id,
        include_queued=True,
    )
    if execution is not None:
        loop_item_execution_service.cancel(
            db,
            execution_id=execution.id,
            user_initiated=True,
            commit=False,
        )
    db.commit()
    logger.info(
        "[RuntimeUserStop] recorded user=%s device=%s task=%s execution=%s",
        user_id,
        device_id,
        task_id,
        execution.id if execution is not None else None,
    )
