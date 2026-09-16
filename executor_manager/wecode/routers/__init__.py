# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wecode-specific executor_manager API routes for orphan pod cleanup."""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, IPvAnyAddress

from executor_manager.config.config import EXECUTOR_DISPATCHER_MODE
from executor_manager.executors.dispatcher import ExecutorDispatcher
from shared.logger import setup_logger

logger = setup_logger(__name__)


class DeleteExecutorByTaskIdRequest(BaseModel):
    task_id: int


class DeletePodByNameRequest(BaseModel):
    pod_name: str
    executor_namespace: Optional[str] = None


class CleanupStaleWarmPoolsRequest(BaseModel):
    grace_period_days: int = 7
    dry_run: bool = False
    label_selector: Optional[str] = None


async def cleanup_stale_warmpools(
    request: CleanupStaleWarmPoolsRequest, http_request: Request
):
    """Delete SandboxWarmPool CRs whose template no longer matches the current one.

    A warm pool CR is stale when its sandboxTemplateRef differs from the
    currently configured WARMPOOL_TEMPLATE_NAME and it is older than the grace
    period. Deleting the CR releases its unbound standby pods; pods bound to
    tasks keep their task-id labels and stay under the regular orphan cleanup.
    """
    if request.grace_period_days < 1:
        raise HTTPException(
            status_code=400,
            detail=f"grace_period_days must be at least 1, got {request.grace_period_days}",
        )
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(
            "+++ Received request to cleanup stale warmpools "
            "(grace_period_days=%d, dry_run=%s) from %s",
            request.grace_period_days,
            request.dry_run,
            client_ip,
        )
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        if not hasattr(executor, "cleanup_stale_warmpools"):
            raise HTTPException(
                status_code=501,
                detail="cleanup_stale_warmpools is not supported by this executor",
            )
        return executor.cleanup_stale_warmpools(
            grace_period_days=request.grace_period_days,
            dry_run=request.dry_run,
            label_selector=request.label_selector,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("+++ Error cleaning up stale warmpools: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


async def delete_executor_by_task_id(
    request: DeleteExecutorByTaskIdRequest, http_request: Request
):
    """Delete executor pod(s) by task_id label for orphan pod cleanup."""
    # Safety guard migrated from pod_delete scripts (awk '$1+0 > 1000'),
    # prevents accidental deletion of early system tasks with low IDs.
    if request.task_id <= 1000:
        raise HTTPException(
            status_code=400,
            detail=f"task_id must be greater than 1000, got {request.task_id}",
        )
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(
            "+++ Received request to delete executor by task_id: %s from %s",
            request.task_id,
            client_ip,
        )
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        if not hasattr(executor, "delete_executor_by_task_id"):
            raise HTTPException(
                status_code=501,
                detail="delete_executor_by_task_id is not supported by this executor",
            )
        result = executor.delete_executor_by_task_id(str(request.task_id))
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "+++ Error deleting executor by task_id '%s': %s", request.task_id, e
        )
        raise HTTPException(status_code=500, detail=str(e))


async def delete_pod_by_name(request: DeletePodByNameRequest, http_request: Request):
    """Delete an executor runtime by Pod or SandboxClaim name.

    Used as fallback when cleanup_stale_task_executor returns executor_not_found
    for orphan runtimes that have no corresponding DB subtask records. K8s
    executors resolve a warm-pool Pod owner and delete its SandboxClaim first.
    """
    if not request.pod_name or not request.pod_name.strip():
        raise HTTPException(status_code=400, detail="pod_name must not be empty")
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(
            "+++ Received request to delete pod by name: %s namespace: %s from %s",
            request.pod_name,
            request.executor_namespace,
            client_ip,
        )
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        if not hasattr(executor, "delete_executor"):
            raise HTTPException(
                status_code=501,
                detail="delete_executor is not supported by this executor",
            )
        result = executor.delete_executor(
            request.pod_name, executor_namespace=request.executor_namespace
        )
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("+++ Error deleting pod by name '%s': %s", request.pod_name, e)
        raise HTTPException(status_code=500, detail=str(e))


async def get_old_task_ids(
    older_than_hours: int = 48,
    http_request: Request = None,
):
    """List old executor runtime cleanup targets.

    Includes direct Pods and Executor warm-pool claims older than the threshold.
    The ``pod_name`` response field remains for compatibility but may contain a
    SandboxClaim name when that is the correct owner-level cleanup target.
    """
    # Safety guard: minimum 48h aligns with pod_delete scripts (date -v-2d)
    if older_than_hours < 48:
        raise HTTPException(
            status_code=400,
            detail=f"older_than_hours must be at least 48, got {older_than_hours}",
        )
    try:
        client_ip = (
            http_request.client.host
            if http_request and http_request.client
            else "unknown"
        )
        logger.info(
            "+++ Received request to get old task IDs (older_than_hours=%d) from %s",
            older_than_hours,
            client_ip,
        )
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        if not hasattr(executor, "get_old_task_ids"):
            return {"status": "success", "pods": []}
        result = executor.get_old_task_ids(older_than_hours)
        return result
    except Exception as e:
        logger.error("+++ Error getting old task IDs: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


async def get_pod_owners_by_ip(
    http_request: Request,
    ip_address: IPvAnyAddress = Query(..., description="Pod IP address"),
):
    """Find Wegent executor Pod owners by an exact Pod IP."""
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        "+++ Received request to resolve Pod IP %s from %s",
        ip_address,
        client_ip,
    )
    executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
    if not hasattr(executor, "get_pod_owners_by_ip"):
        raise HTTPException(
            status_code=501,
            detail="Pod IP lookup is not supported by this executor",
        )
    return executor.get_pod_owners_by_ip(str(ip_address))


def register(api_router: APIRouter) -> None:
    """Register wecode-specific routes into executor_manager's api_router."""
    api_router.add_api_route(
        "/executor/delete-by-task-id",
        delete_executor_by_task_id,
        methods=["POST"],
    )
    api_router.add_api_route(
        "/executor/delete-pod-by-name",
        delete_pod_by_name,
        methods=["POST"],
    )
    api_router.add_api_route(
        "/executor/old-task-ids",
        get_old_task_ids,
        methods=["GET"],
    )
    api_router.add_api_route(
        "/executor/cleanup-stale-warmpools",
        cleanup_stale_warmpools,
        methods=["POST"],
    )
    api_router.add_api_route(
        "/executor/pod-owners",
        get_pod_owners_by_ip,
        methods=["GET"],
    )
