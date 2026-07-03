# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared API side effects for knowledge document operations."""

import asyncio
import logging
from collections.abc import Iterable
from typing import Optional

from fastapi import BackgroundTasks

from app.db.session import SessionLocal
from shared.telemetry.decorators import capture_trace_context, trace_background

logger = logging.getLogger(__name__)


@trace_background("kb_summary_after_deletion_background", "knowledge.worker")
def update_kb_summary_after_deletion(
    kb_id: int,
    user_id: int,
    user_name: str,
    trace_context: Optional[dict] = None,
):
    """
    Background task to update KB summary after document deletion.

    - If no active documents remain, clear the summary
    - If active documents remain, regenerate the summary
    - Errors are logged but don't affect the deletion operation
    - Respects debounce pattern (skip if summary is currently generating)
    """
    from app.services.knowledge import get_summary_service

    logger.info(
        f"[KnowledgeAPI] Starting KB summary update after deletion: kb_id={kb_id}"
    )

    db = SessionLocal()
    try:
        summary_service = get_summary_service(db)

        asyncio.run(
            summary_service.trigger_kb_summary(
                kb_id, user_id, user_name, force=False, clear_if_empty=True
            )
        )

    except Exception as e:
        logger.error(
            f"[KnowledgeAPI] Failed to update KB summary after deletion: "
            f"kb_id={kb_id}, error={e!s}",
            exc_info=True,
        )
    finally:
        db.close()
        logger.info(f"[KnowledgeAPI] KB summary update task completed: kb_id={kb_id}")


def schedule_kb_summary_updates_after_deletion(
    background_tasks: BackgroundTasks,
    *,
    kb_ids: Iterable[int],
    user_id: int,
    user_name: str,
) -> None:
    """Schedule one KB summary refresh task per affected knowledge base."""
    unique_kb_ids = list(dict.fromkeys(kb_id for kb_id in kb_ids if kb_id is not None))
    if not unique_kb_ids:
        return

    trace_ctx = capture_trace_context()
    for kb_id in unique_kb_ids:
        background_tasks.add_task(
            update_kb_summary_after_deletion,
            kb_id=kb_id,
            user_id=user_id,
            user_name=user_name,
            trace_context=trace_ctx,
        )
