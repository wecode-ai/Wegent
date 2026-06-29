# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wecode-specific executor_manager API routes for orphan pod cleanup."""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from executor_manager.config.config import EXECUTOR_DISPATCHER_MODE
from executor_manager.executors.dispatcher import ExecutorDispatcher

logger = logging.getLogger(__name__)


class DeleteExecutorByTaskIdRequest(BaseModel):
    task_id: int


async def delete_executor_by_task_id(
    request: DeleteExecutorByTaskIdRequest, http_request: Request
):
    """Delete executor pod(s) by task_id label for orphan pod cleanup.

    Used when no DB subtask records exist for a task but K8s pods remain.
    Searches pods by the aigc.weibo.com/executor-task-id label and deletes them.
    """
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(
            "Received request to delete executor by task_id: %s from %s",
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
        logger.error("Error deleting executor by task_id '%s': %s", request.task_id, e)
        raise HTTPException(status_code=500, detail=str(e))


async def get_old_task_ids(
    older_than_hours: int = 48,
    http_request: Optional[Request] = None,
):
    """List task IDs for executor pods older than the given age threshold.

    Used by the backend orphan pod cleanup job to identify pods that have
    no corresponding DB subtask records.
    """
    try:
        client_ip = (
            http_request.client.host
            if http_request and http_request.client
            else "unknown"
        )
        logger.info(
            "Received request to get old task IDs (older_than_hours=%d) from %s",
            older_than_hours,
            client_ip,
        )
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        if not hasattr(executor, "get_old_task_ids"):
            return {"status": "success", "task_ids": []}
        result = executor.get_old_task_ids(older_than_hours)
        return result
    except Exception as e:
        logger.error("Error getting old task IDs: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


def register(api_router: APIRouter) -> None:
    """Register wecode-specific routes into executor_manager's api_router."""
    api_router.add_api_route(
        "/executor/delete-by-task-id",
        delete_executor_by_task_id,
        methods=["POST"],
    )
    api_router.add_api_route(
        "/executor/old-task-ids",
        get_old_task_ids,
        methods=["GET"],
    )
