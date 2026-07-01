# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add orphan pod cleanup methods to executor_kinds_service (K8s-specific)."""

import logging
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException

from wecode.config.orphan_pod_config import (
    EXECUTOR_DELETE_BY_TASK_ID_URL,
    EXECUTOR_DELETE_POD_BY_NAME_URL,
    EXECUTOR_OLD_TASK_IDS_URL,
)

logger = logging.getLogger(__name__)

_patch_applied = False

try:
    from app.services.adapters.executor_kinds import executor_kinds_service
except Exception:
    executor_kinds_service = None  # type: ignore


async def get_old_pods_async(self, older_than_hours: int = 48) -> List[Dict[str, Any]]:
    """Fetch old executor pods with task_id and pod_name for orphan cleanup.

    Returns a list of dicts with keys 'task_id' (str or None) and 'pod_name' (str).
    """
    try:
        logger.info(
            "+++ executor.get_old_pods async request url=%s older_than_hours=%d",
            EXECUTOR_OLD_TASK_IDS_URL,
            older_than_hours,
        )
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                EXECUTOR_OLD_TASK_IDS_URL,
                params={"older_than_hours": older_than_hours},
            )
            response.raise_for_status()
            return response.json().get("pods", [])
    except httpx.HTTPError as e:
        logger.warning("+++ Failed to fetch old pods from executor_manager: %s", e)
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
            "+++ executor.delete_by_task_id async request url=%s task_id=%d",
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


async def delete_pod_by_name_async(
    self,
    pod_name: str,
    executor_namespace: Optional[str] = None,
) -> Dict[str, Any]:
    """Delete a K8s pod directly by its name (kubectl fallback for orphan pods).

    Called when cleanup_stale_task_executor returns executor_not_found for pods
    that have no DB subtask records at all.
    """
    if not pod_name:
        raise HTTPException(status_code=400, detail="pod_name is required")
    try:
        payload: Dict[str, Any] = {"pod_name": pod_name}
        if executor_namespace:
            payload["executor_namespace"] = executor_namespace
        logger.info(
            "+++ executor.delete_pod_by_name async request url=%s pod_name=%s",
            EXECUTOR_DELETE_POD_BY_NAME_URL,
            pod_name,
        )
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                EXECUTOR_DELETE_POD_BY_NAME_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise HTTPException(
                    status_code=500,
                    detail=f"Invalid delete-pod-by-name response: {data!r}",
                )
            return data
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error deleting pod by name: {str(e)}",
        )


def apply_patch():
    """Attach orphan pod cleanup methods to executor_kinds_service."""
    global _patch_applied

    if _patch_applied:
        return

    if executor_kinds_service is None:
        logger.warning(
            "+++ [ExecutorKindsPatch] executor_kinds_service unavailable, skipping"
        )
        return

    executor_kinds_service.get_old_pods_async = get_old_pods_async.__get__(
        executor_kinds_service
    )
    executor_kinds_service.delete_executor_by_task_id_async = (
        delete_executor_by_task_id_async.__get__(executor_kinds_service)
    )
    executor_kinds_service.delete_pod_by_name_async = delete_pod_by_name_async.__get__(
        executor_kinds_service
    )

    _patch_applied = True
    logger.info("+++ [ExecutorKindsPatch] Applied orphan pod cleanup methods")


apply_patch()
