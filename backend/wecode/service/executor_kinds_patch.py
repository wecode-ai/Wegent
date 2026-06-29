# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add orphan pod cleanup methods to executor_kinds_service (K8s-specific)."""

import logging
from typing import Dict, List

import httpx
from fastapi import HTTPException

from wecode.config.orphan_pod_config import (
    EXECUTOR_DELETE_BY_TASK_ID_URL,
    EXECUTOR_OLD_TASK_IDS_URL,
)

logger = logging.getLogger(__name__)

_patch_applied = False

try:
    from app.services.adapters.executor_kinds import executor_kinds_service
except Exception:
    executor_kinds_service = None  # type: ignore


async def get_old_task_ids_async(self, older_than_hours: int = 48) -> List[str]:
    """Fetch task IDs for executor pods older than the given age threshold."""
    try:
        logger.info(
            "executor.get_old_task_ids async request url=%s older_than_hours=%d",
            EXECUTOR_OLD_TASK_IDS_URL,
            older_than_hours,
        )
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                EXECUTOR_OLD_TASK_IDS_URL,
                params={"older_than_hours": older_than_hours},
            )
            response.raise_for_status()
            return response.json().get("task_ids", [])
    except httpx.HTTPError as e:
        logger.warning("Failed to fetch old task IDs from executor_manager: %s", e)
        return []


async def delete_executor_by_task_id_async(self, task_id: int) -> Dict:
    """Delete executor pod(s) by task_id label for orphan pod cleanup."""
    if not task_id or task_id <= 0:
        raise HTTPException(
            status_code=400, detail="task_id must be a positive integer"
        )
    try:
        payload = {"task_id": task_id}
        logger.info(
            "executor.delete_by_task_id async request url=%s task_id=%d",
            EXECUTOR_DELETE_BY_TASK_ID_URL,
            task_id,
        )
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                EXECUTOR_DELETE_BY_TASK_ID_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise HTTPException(
                    status_code=500,
                    detail=f"Invalid delete-by-task-id response: {data!r}",
                )
            return data
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error deleting executor by task_id: {str(e)}",
        )


def apply_patch():
    """Attach orphan pod cleanup methods to executor_kinds_service."""
    global _patch_applied

    if _patch_applied:
        return

    if executor_kinds_service is None:
        logger.warning(
            "[ExecutorKindsPatch] executor_kinds_service unavailable, skipping"
        )
        return

    executor_kinds_service.get_old_task_ids_async = get_old_task_ids_async.__get__(
        executor_kinds_service
    )
    executor_kinds_service.delete_executor_by_task_id_async = (
        delete_executor_by_task_id_async.__get__(executor_kinds_service)
    )

    _patch_applied = True
    logger.info("[ExecutorKindsPatch] Applied orphan pod cleanup methods")


apply_patch()
