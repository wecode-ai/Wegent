# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executor service for Chat.

This module provides utilities for interacting with the executor_manager,
including task cancellation and status management.
"""

import logging

from app.core.config import settings

logger = logging.getLogger(__name__)


async def call_executor_cancel(task_id: int) -> bool:
    """
    Call executor_manager to cancel a task.

    Args:
        task_id: Task ID to cancel

    Returns:
        bool: True if successful, False otherwise
    """
    import httpx

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                settings.EXECUTOR_CANCEL_TASK_URL,
                json={"task_id": task_id},
                timeout=5.0,
            )
            response.raise_for_status()
            logger.info(
                f"executor_manager responded successfully for task_id={task_id}"
            )
            return True
    except Exception as e:
        logger.error(
            f"executor_manager call failed for task_id={task_id}: {e}",
            exc_info=True,
        )
        return False
