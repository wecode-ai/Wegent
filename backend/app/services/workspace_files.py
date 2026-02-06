# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Workspace files service for accessing files in executor containers.

This service provides access to files in the executor container's workspace
directory for tasks without an associated git repository.
"""

import logging
from typing import Any, Optional

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask import Subtask, SubtaskRole
from app.models.task import TaskResource
from app.services.task_member_service import task_member_service

logger = logging.getLogger(__name__)

# Timeout for API calls to executor manager (seconds)
EXECUTOR_API_TIMEOUT = 60.0


class WorkspaceFilesService:
    """Service for accessing workspace files in executor containers."""

    def __init__(self):
        self.executor_manager_base_url = settings.EXECUTOR_MANAGER_BASE_URL

    def _get_task_executor_info(
        self, db: Session, task_id: int, user_id: int
    ) -> tuple[Optional[str], Optional[str]]:
        """
        Get executor info for a task.

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID for access validation

        Returns:
            Tuple of (executor_name, error_message)
        """
        # Check user access
        if not task_member_service.is_member(db, task_id, user_id):
            return None, "Task not found or access denied"

        # Get task
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if not task:
            return None, "Task not found"

        # Get the latest assistant subtask with executor_name
        subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.executor_name.isnot(None),
                Subtask.executor_name != "",
            )
            .order_by(Subtask.created_at.desc())
            .first()
        )

        if not subtask or not subtask.executor_name:
            return None, "No executor found for this task"

        # Skip device-based executors (they run on user's device, not in container)
        if subtask.executor_name.startswith("device-"):
            return None, "This task runs on a local device, workspace files are not available"

        return subtask.executor_name, None

    async def get_workspace_files(
        self, db: Session, task_id: int, user_id: int
    ) -> dict[str, Any]:
        """
        Get list of files in the task's workspace directory.

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID for access validation

        Returns:
            Dict with files list and metadata
        """
        executor_name, error = self._get_task_executor_info(db, task_id, user_id)
        if error:
            raise HTTPException(status_code=404, detail=error)

        # Call executor manager to get container address
        try:
            container_info = await self._get_container_address(executor_name)
            if not container_info.get("status") == "success":
                error_msg = container_info.get(
                    "error_msg", "Container not available"
                )
                raise HTTPException(
                    status_code=503,
                    detail=f"Executor container not available: {error_msg}",
                )

            base_url = container_info.get("address")
            if not base_url:
                raise HTTPException(
                    status_code=503,
                    detail="Could not determine container address",
                )

            # Call envd files/list endpoint
            # The workspace path is /workspace/{task_id}/
            workspace_path = f"/workspace/{task_id}"
            files_response = await self._call_envd_api(
                base_url, "files/list", {"path": workspace_path}
            )

            return {
                "files": files_response.get("files", []),
                "total_count": files_response.get("total_count", 0),
                "filtered_count": files_response.get("filtered_count", 0),
                "workspace_path": workspace_path,
            }

        except HTTPException:
            raise
        except httpx.ConnectError as e:
            logger.error(f"Connection error to executor container: {e}")
            raise HTTPException(
                status_code=503,
                detail="Executor container is not running or unreachable",
            )
        except httpx.TimeoutException as e:
            logger.error(f"Timeout connecting to executor container: {e}")
            raise HTTPException(
                status_code=504,
                detail="Request to executor container timed out",
            )
        except Exception as e:
            logger.error(f"Error getting workspace files: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to get workspace files: {str(e)}",
            )

    async def download_workspace_zip(
        self, db: Session, task_id: int, user_id: int
    ) -> tuple[bytes, str]:
        """
        Download workspace files as a ZIP archive.

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID for access validation

        Returns:
            Tuple of (zip_content_bytes, filename)
        """
        executor_name, error = self._get_task_executor_info(db, task_id, user_id)
        if error:
            raise HTTPException(status_code=404, detail=error)

        try:
            container_info = await self._get_container_address(executor_name)
            if not container_info.get("status") == "success":
                error_msg = container_info.get(
                    "error_msg", "Container not available"
                )
                raise HTTPException(
                    status_code=503,
                    detail=f"Executor container not available: {error_msg}",
                )

            base_url = container_info.get("address")
            if not base_url:
                raise HTTPException(
                    status_code=503,
                    detail="Could not determine container address",
                )

            # Call envd files/download-zip endpoint
            workspace_path = f"/workspace/{task_id}"
            zip_content = await self._download_envd_zip(
                base_url, workspace_path
            )

            filename = f"task_{task_id}_files.zip"
            return zip_content, filename

        except HTTPException:
            raise
        except httpx.ConnectError as e:
            logger.error(f"Connection error to executor container: {e}")
            raise HTTPException(
                status_code=503,
                detail="Executor container is not running or unreachable",
            )
        except httpx.TimeoutException as e:
            logger.error(f"Timeout connecting to executor container: {e}")
            raise HTTPException(
                status_code=504,
                detail="Request to executor container timed out",
            )
        except Exception as e:
            logger.error(f"Error downloading workspace ZIP: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to download workspace files: {str(e)}",
            )

    async def _get_container_address(self, executor_name: str) -> dict[str, Any]:
        """
        Get container address from executor manager.

        Args:
            executor_name: Name of the executor container

        Returns:
            Dict with container address info
        """
        url = f"{self.executor_manager_base_url}/executor-manager/executor/address"
        async with httpx.AsyncClient(timeout=EXECUTOR_API_TIMEOUT) as client:
            response = await client.get(url, params={"executor_name": executor_name})

            if response.status_code == 200:
                return response.json()
            elif response.status_code == 404:
                return {"status": "error", "error_msg": "Container not found"}
            else:
                return {
                    "status": "error",
                    "error_msg": f"HTTP {response.status_code}: {response.text}",
                }

    async def _call_envd_api(
        self, base_url: str, endpoint: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Call envd REST API endpoint.

        Args:
            base_url: Container base URL (e.g., http://localhost:49983)
            endpoint: API endpoint path
            params: Query parameters

        Returns:
            API response as dict
        """
        url = f"{base_url}/{endpoint}"
        async with httpx.AsyncClient(timeout=EXECUTOR_API_TIMEOUT) as client:
            response = await client.get(url, params=params)

            if response.status_code == 200:
                return response.json()
            elif response.status_code == 404:
                # Directory not found - return empty result
                return {"files": [], "total_count": 0, "filtered_count": 0}
            else:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Envd API error: {response.text}",
                )

    async def _download_envd_zip(
        self, base_url: str, workspace_path: str
    ) -> bytes:
        """
        Download ZIP file from envd.

        Args:
            base_url: Container base URL
            workspace_path: Path to workspace directory

        Returns:
            ZIP file content as bytes
        """
        url = f"{base_url}/files/download-zip"
        async with httpx.AsyncClient(timeout=EXECUTOR_API_TIMEOUT * 2) as client:
            response = await client.get(url, params={"path": workspace_path})

            if response.status_code == 200:
                return response.content
            elif response.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail="Workspace directory not found or empty",
                )
            else:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Failed to download ZIP: {response.text}",
                )


# Singleton instance
workspace_files_service = WorkspaceFilesService()
