# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException

from app.core.config import settings
from app.models.kind import Kind
from app.services.base import BaseService

logger = logging.getLogger(__name__)


def _get_thinking_details_type(step: Dict[str, Any]) -> Optional[str]:
    """Get the details.type from a thinking step."""
    details = step.get("details")
    if isinstance(details, dict):
        return details.get("type")
    return None


def merge_thinking_steps(thinking_steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Merge adjacent thinking steps that have the same title, next_action, and details.type.

    This reduces the size of thinking data by combining consecutive steps of the same type,
    particularly useful for reasoning content that comes in token-by-token.
    """
    if not thinking_steps:
        return []

    merged: List[Dict[str, Any]] = []

    def copy_step(step: Dict[str, Any]) -> Dict[str, Any]:
        """Create a deep copy of a step to avoid mutating the original."""
        copied = {**step}
        if "details" in copied and isinstance(copied["details"], dict):
            copied["details"] = {**copied["details"]}
        return copied

    for step in thinking_steps:
        if not merged:
            merged.append(copy_step(step))
            continue

        last = merged[-1]
        current_details_type = _get_thinking_details_type(step)
        last_details_type = _get_thinking_details_type(last)

        can_merge = (
            step.get("title") == last.get("title")
            and step.get("next_action") == last.get("next_action")
            and current_details_type == last_details_type
            and current_details_type is not None
        )

        if can_merge:
            last_content = last.get("details", {}).get("content", "")
            new_content = step.get("details", {}).get("content", "")
            if "details" not in last:
                last["details"] = {}
            last["details"]["content"] = last_content + new_content
        else:
            merged.append(copy_step(step))

    return merged


class ExecutorKindsService(BaseService[Kind, None, None]):
    """
    Executor service class using tasks table for Task operations
    """

    def delete_executor_task_sync(
        self, executor_name: str, executor_namespace: str
    ) -> Dict:
        """
        Synchronous version of delete_executor_task to avoid event loop issues

        Args:
            executor_name: The executor task name to delete
            executor_namespace: Executor namespace (required)
        """
        if not executor_name:
            raise HTTPException(status_code=400, detail="executor_name are required")
        try:
            import requests

            payload = {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
            logger.info(
                f"executor.delete sync request url={settings.EXECUTOR_DELETE_TASK_URL} {payload}"
            )

            response = requests.post(
                settings.EXECUTOR_DELETE_TASK_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=30.0,
            )
            response.raise_for_status()
            return self._validate_delete_response(response.json())
        except requests.exceptions.RequestException as e:
            raise HTTPException(
                status_code=500, detail=f"Error deleting executor task: {str(e)}"
            )

    async def get_old_task_ids_async(self, older_than_hours: int = 48) -> List[str]:
        """Fetch task IDs for executor pods older than the given age threshold."""
        try:
            logger.info(
                f"executor.get_old_task_ids async request "
                f"url={settings.EXECUTOR_OLD_TASK_IDS_URL} "
                f"older_than_hours={older_than_hours}"
            )
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    settings.EXECUTOR_OLD_TASK_IDS_URL,
                    params={"older_than_hours": older_than_hours},
                )
                response.raise_for_status()
                return response.json().get("task_ids", [])
        except httpx.HTTPError as e:
            logger.warning("Failed to fetch old task IDs from executor_manager: %s", e)
            return []

    async def delete_executor_by_task_id_async(self, task_id: int) -> Dict:
        """Delete executor pod(s) by task_id label for orphan pod cleanup.

        Called when no DB subtask records exist but K8s pods may still be running.
        """
        if not task_id or task_id <= 0:
            raise HTTPException(
                status_code=400, detail="task_id must be a positive integer"
            )
        try:
            payload = {"task_id": task_id}
            logger.info(
                f"executor.delete_by_task_id async request "
                f"url={settings.EXECUTOR_DELETE_BY_TASK_ID_URL} task_id={task_id}"
            )
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    settings.EXECUTOR_DELETE_BY_TASK_ID_URL,
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

    async def delete_executor_task_async(
        self, executor_name: str, executor_namespace: str
    ) -> Dict:
        """
        Asynchronous version of delete_executor_task

        Args:
            executor_name: The executor task name to delete
            executor_namespace: Executor namespace (required)
        """
        if not executor_name:
            raise HTTPException(status_code=400, detail="executor_name are required")
        try:
            payload = {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
            logger.info(
                f"executor.delete async request url={settings.EXECUTOR_DELETE_TASK_URL} {payload}"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    settings.EXECUTOR_DELETE_TASK_URL,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                return self._validate_delete_response(response.json())
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=500, detail=f"Error deleting executor task: {str(e)}"
            )

    def _validate_delete_response(self, response_data: Any) -> Dict[str, Any]:
        """Validate executor deletion response body."""
        if response_data is True:
            return {"status": "success"}

        if not isinstance(response_data, dict):
            raise HTTPException(
                status_code=500,
                detail=f"Invalid delete executor response: {response_data!r}",
            )

        if response_data.get("status") != "success":
            raise HTTPException(
                status_code=500,
                detail=response_data.get("error_msg", "Executor deletion failed"),
            )

        return response_data


executor_kinds_service = ExecutorKindsService(Kind)
