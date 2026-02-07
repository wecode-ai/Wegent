# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Workspace files service for accessing files in executor containers.

This service provides functionality to:
- List files in a task's workspace directory
- Download workspace files as a ZIP archive

The workspace files are stored in the executor container at /workspace/{task_id}/
"""

import logging
import os
from typing import Optional, Tuple

import httpx

from app.schemas.task import WorkspaceFilesResponse
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

# Configuration
EXECUTOR_MANAGER_URL = os.getenv("EXECUTOR_MANAGER_URL", "http://localhost:8001")
WORKSPACE_FILES_TIMEOUT = float(os.getenv("WORKSPACE_FILES_TIMEOUT", "30.0"))
SANDBOX_STATUS_CHECK_TIMEOUT = float(os.getenv("SANDBOX_STATUS_CHECK_TIMEOUT", "5.0"))

# Valid sandbox statuses for file access
SANDBOX_HEALTHY_STATUSES = {"running"}


class WorkspaceFilesService:
    """Service for accessing workspace files in executor containers.

    This service communicates with executor_manager to access files in
    running executor containers via the envd REST API.
    """

    def __init__(
        self,
        executor_manager_url: Optional[str] = None,
        files_timeout: Optional[float] = None,
        status_check_timeout: Optional[float] = None,
    ):
        """Initialize the workspace files service.

        Args:
            executor_manager_url: URL of executor_manager service
            files_timeout: Timeout for file operations in seconds
            status_check_timeout: Timeout for sandbox status check in seconds
        """
        self.executor_manager_url = (
            executor_manager_url or EXECUTOR_MANAGER_URL
        ).rstrip("/")
        self.files_timeout = files_timeout or WORKSPACE_FILES_TIMEOUT
        self.status_check_timeout = status_check_timeout or SANDBOX_STATUS_CHECK_TIMEOUT

    @trace_async()
    async def get_sandbox_status(
        self, task_id: int
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """Check if the sandbox for a task is running and get its base URL.

        Args:
            task_id: Task ID (sandbox_id is derived from task_id)

        Returns:
            Tuple of (is_healthy, base_url, error_message)
        """
        sandbox_id = str(task_id)
        url = f"{self.executor_manager_url}/executor-manager/sandboxes/{sandbox_id}"

        try:
            async with httpx.AsyncClient(timeout=self.status_check_timeout) as client:
                response = await client.get(url)

                if response.status_code == 404:
                    logger.debug(f"[WorkspaceFiles] Sandbox {sandbox_id} not found")
                    return False, None, "container_not_found"

                if response.status_code != 200:
                    logger.warning(
                        f"[WorkspaceFiles] Failed to get sandbox status: "
                        f"HTTP {response.status_code}"
                    )
                    return False, None, "status_check_failed"

                data = response.json()
                status = data.get("status", "").lower()
                base_url = data.get("base_url")

                if status in SANDBOX_HEALTHY_STATUSES and base_url:
                    logger.info(
                        f"[WorkspaceFiles] Sandbox {sandbox_id} is healthy: "
                        f"status={status}, base_url={base_url}"
                    )
                    return True, base_url, None
                else:
                    logger.warning(
                        f"[WorkspaceFiles] Sandbox {sandbox_id} not healthy: "
                        f"status={status}"
                    )
                    return False, None, "container_stopped"

        except httpx.TimeoutException:
            logger.warning(
                f"[WorkspaceFiles] Timeout checking sandbox {sandbox_id} status"
            )
            return False, None, "timeout"
        except Exception as e:
            logger.error(
                f"[WorkspaceFiles] Error checking sandbox {sandbox_id} status: {e}"
            )
            return False, None, "connection_error"

    @trace_async()
    async def list_workspace_files(
        self, task_id: int
    ) -> Tuple[Optional[WorkspaceFilesResponse], Optional[str]]:
        """List files in the task's workspace directory.

        Args:
            task_id: Task ID

        Returns:
            Tuple of (WorkspaceFilesResponse, error_message)
        """
        # Check sandbox status
        is_healthy, base_url, error = await self.get_sandbox_status(task_id)
        if not is_healthy or not base_url:
            return None, error

        # Build workspace path - files are stored in /workspace/{task_id}/
        workspace_path = f"/workspace/{task_id}"

        # Call envd /files/list endpoint
        url = f"{base_url}/files/list"
        params = {"path": workspace_path}

        try:
            async with httpx.AsyncClient(timeout=self.files_timeout) as client:
                response = await client.get(url, params=params)

                if response.status_code == 404:
                    # Directory not found - return empty list
                    return (
                        WorkspaceFilesResponse(
                            files=[], total_count=0, truncated=False
                        ),
                        None,
                    )

                if response.status_code != 200:
                    logger.warning(
                        f"[WorkspaceFiles] Failed to list files: "
                        f"HTTP {response.status_code}, response={response.text[:200]}"
                    )
                    return None, "list_files_failed"

                data = response.json()
                return WorkspaceFilesResponse(**data), None

        except httpx.TimeoutException:
            logger.warning(f"[WorkspaceFiles] Timeout listing files for task {task_id}")
            return None, "timeout"
        except Exception as e:
            logger.error(f"[WorkspaceFiles] Error listing files: {e}")
            return None, "connection_error"

    @trace_async()
    async def download_workspace_zip(
        self, task_id: int
    ) -> Tuple[Optional[bytes], Optional[str], Optional[str]]:
        """Download workspace files as a ZIP archive.

        Args:
            task_id: Task ID

        Returns:
            Tuple of (zip_bytes, filename, error_message)
        """
        # Check sandbox status
        is_healthy, base_url, error = await self.get_sandbox_status(task_id)
        if not is_healthy or not base_url:
            return None, None, error

        # Build workspace path
        workspace_path = f"/workspace/{task_id}"

        # Call envd /files/download-zip endpoint
        url = f"{base_url}/files/download-zip"
        params = {"path": workspace_path}

        try:
            async with httpx.AsyncClient(timeout=self.files_timeout * 2) as client:
                response = await client.get(url, params=params)

                if response.status_code == 404:
                    return None, None, "directory_not_found"

                if response.status_code != 200:
                    logger.warning(
                        f"[WorkspaceFiles] Failed to download zip: "
                        f"HTTP {response.status_code}"
                    )
                    return None, None, "download_failed"

                # Extract filename from Content-Disposition header
                content_disposition = response.headers.get("content-disposition", "")
                filename = f"task_{task_id}_files.zip"
                if "filename=" in content_disposition:
                    try:
                        filename = content_disposition.split("filename=")[1].strip('"')
                    except (IndexError, ValueError):
                        pass

                return response.content, filename, None

        except httpx.TimeoutException:
            logger.warning(
                f"[WorkspaceFiles] Timeout downloading zip for task {task_id}"
            )
            return None, None, "timeout"
        except Exception as e:
            logger.error(f"[WorkspaceFiles] Error downloading zip: {e}")
            return None, None, "connection_error"


# Global instance
_workspace_files_service: Optional[WorkspaceFilesService] = None


def get_workspace_files_service() -> WorkspaceFilesService:
    """Get the global WorkspaceFilesService instance.

    Returns:
        The WorkspaceFilesService singleton
    """
    global _workspace_files_service
    if _workspace_files_service is None:
        _workspace_files_service = WorkspaceFilesService()
    return _workspace_files_service
