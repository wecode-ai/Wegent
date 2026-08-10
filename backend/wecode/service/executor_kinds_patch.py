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
    EXECUTOR_SANDBOX_CLEANUP_BY_TASK_URL,
)

logger = logging.getLogger(__name__)

_patch_applied = False


def _validate_delete_response(response_data: Any, context: str) -> Dict[str, Any]:
    """Validate executor deletion response body.

    Args:
        response_data: Parsed JSON body from the executor_manager response.
        context: Short label describing the request, used in error messages.
    """
    if not isinstance(response_data, dict):
        logger.warning(
            "+++ Invalid %s response body: type=%s value=%r",
            context,
            type(response_data).__name__,
            response_data,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Invalid {context} response: {response_data!r}",
        )
    return response_data


try:
    from app.services.adapters.executor_kinds import executor_kinds_service
except Exception:
    executor_kinds_service = None  # type: ignore


async def get_old_pods_async(self, older_than_hours: int = 48) -> List[Dict[str, Any]]:
    """Fetch old executor runtime cleanup targets.

    Returns a list of dicts with keys 'task_id' (str or None), 'pod_name' (str)
    and 'status' (kubectl-style display status, e.g. 'Running', 'OOMKilled').
    For a warm-pool runtime, 'pod_name' may be its owning SandboxClaim name.
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
            return _validate_delete_response(response.json(), "delete-by-task-id")
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
    """Delete a K8s runtime by its Pod or SandboxClaim cleanup target name.

    Called when cleanup_stale_task_executor returns executor_not_found for pods
    that have no DB subtask records. Executor Manager resolves Pod ownership so
    warm-pool runtimes are removed through SandboxClaim cascading deletion.
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
            return _validate_delete_response(response.json(), "delete-pod-by-name")
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error deleting pod by name: {str(e)}",
        )


async def cleanup_sandbox_by_task_id_async(
    self,
    task_id: int,
    archive_before_delete: bool = True,
    delete_on_archive_failure: bool = False,
) -> Dict[str, Any]:
    """Archive and delete a sandbox runtime by task_id for orphan cleanup.

    Routes to executor_manager's sandbox cleanup-by-task endpoint, which
    archives the sandbox workspace (best-effort) before terminating it,
    mirroring the normal stale sandbox cleanup path.

    When delete_on_archive_failure is True the sandbox is deleted even if the
    archive step fails, so a broken archive cannot pin pods forever.
    """
    if not task_id or task_id <= 0:
        raise HTTPException(
            status_code=400, detail="task_id must be a positive integer"
        )
    try:
        payload = {
            "task_id": task_id,
            "archive_before_delete": archive_before_delete,
            "delete_on_archive_failure": delete_on_archive_failure,
        }
        logger.info(
            "+++ sandbox.cleanup_by_task async request url=%s task_id=%d",
            EXECUTOR_SANDBOX_CLEANUP_BY_TASK_URL,
            task_id,
        )
        # connect timeout (10s) fails fast when executor_manager is unreachable
        # instead of blocking the orphan cleanup loop for the full read timeout.
        # read timeout (180s) must exceed the archive callback window
        # (executor_manager allows up to 130s for the archive upload) plus pod
        # deletion.
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=180.0, write=10.0, pool=10.0)
        ) as client:
            response = await client.post(
                EXECUTOR_SANDBOX_CLEANUP_BY_TASK_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            result = _validate_delete_response(
                response.json(), "sandbox-cleanup-by-task"
            )
            logger.info(
                f"+++ sandbox.cleanup_by_task async response task_id={task_id} result={result}"
            )
            return result
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error cleaning up sandbox by task_id: {str(e)}",
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
    executor_kinds_service.cleanup_sandbox_by_task_id_async = (
        cleanup_sandbox_by_task_id_async.__get__(executor_kinds_service)
    )

    _patch_applied = True
    logger.info("+++ [ExecutorKindsPatch] Applied orphan pod cleanup methods")


apply_patch()
