# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Preview service for managing Workbench live preview functionality.
"""

import logging
import os
from typing import Optional, Tuple

import httpx
import yaml
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.schemas.preview import (
    PreviewConfig,
    PreviewConfigResponse,
    PreviewConfigSpec,
    PreviewStartResponse,
    PreviewStatus,
    PreviewStopResponse,
)

logger = logging.getLogger(__name__)

# Executor Manager base URL
EXECUTOR_MANAGER_URL = os.getenv("EXECUTOR_MANAGER_URL", "http://localhost:8001")


class PreviewService:
    """Service for managing preview functionality"""

    def _get_task_container_name(self, task_id: int) -> str:
        """Generate container name for a task"""
        return f"executor-task-{task_id}"

    def _get_executor_manager_url(self) -> str:
        """Get executor manager base URL"""
        return EXECUTOR_MANAGER_URL

    async def get_preview_config(
        self, db: Session, task_id: int, user_id: int
    ) -> PreviewConfigResponse:
        """
        Get preview configuration for a task.

        This fetches the .wegent.yaml from the task's workspace
        and checks the current preview service status.
        """
        # Get task to verify ownership and get workspace info
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.user_id == user_id,
                TaskResource.is_active == True,
            )
            .first()
        )

        if not task:
            return PreviewConfigResponse(
                enabled=False,
                status=PreviewStatus.DISABLED,
                error="Task not found",
            )

        # Try to get preview config from executor manager
        try:
            config, error = await self._fetch_preview_config_from_container(task_id)
            if error:
                return PreviewConfigResponse(
                    enabled=False,
                    status=PreviewStatus.DISABLED,
                    error=error,
                )

            if not config:
                return PreviewConfigResponse(
                    enabled=False,
                    status=PreviewStatus.DISABLED,
                    error="No preview configuration found",
                )

            preview_spec = config.get_preview_spec()
            if not preview_spec or not preview_spec.enabled:
                return PreviewConfigResponse(
                    enabled=False,
                    status=PreviewStatus.DISABLED,
                )

            # Check current preview status
            status, url, error = await self._get_preview_status(task_id, preview_spec.port)

            return PreviewConfigResponse(
                enabled=True,
                port=preview_spec.port,
                status=status,
                url=url,
                start_command=preview_spec.start_command,
                ready_pattern=preview_spec.ready_pattern,
                error=error,
            )

        except Exception as e:
            logger.error(f"Error getting preview config for task {task_id}: {e}")
            return PreviewConfigResponse(
                enabled=False,
                status=PreviewStatus.ERROR,
                error=str(e),
            )

    async def _fetch_preview_config_from_container(
        self, task_id: int
    ) -> Tuple[Optional[PreviewConfig], Optional[str]]:
        """
        Fetch .wegent.yaml from the task's container.

        Returns: (config, error_message)
        """
        try:
            executor_url = self._get_executor_manager_url()
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{executor_url}/executor-manager/preview/{task_id}/config"
                )

                if response.status_code == 404:
                    return None, "Container not running or config file not found"

                if response.status_code != 200:
                    return None, f"Failed to fetch config: {response.status_code}"

                data = response.json()
                if data.get("status") == "error":
                    return None, data.get("error", "Unknown error")

                config_content = data.get("config")
                if not config_content:
                    return None, "No config content returned"

                # Parse YAML content
                parsed = yaml.safe_load(config_content)
                config = PreviewConfig(**parsed)
                return config, None

        except httpx.TimeoutException:
            return None, "Timeout fetching preview config"
        except yaml.YAMLError as e:
            return None, f"Invalid YAML config: {e}"
        except Exception as e:
            logger.error(f"Error fetching preview config: {e}")
            return None, str(e)

    async def _get_preview_status(
        self, task_id: int, port: int
    ) -> Tuple[PreviewStatus, Optional[str], Optional[str]]:
        """
        Check the current preview service status.

        Returns: (status, url, error)
        """
        try:
            executor_url = self._get_executor_manager_url()
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    f"{executor_url}/executor-manager/preview/{task_id}/status"
                )

                if response.status_code == 404:
                    return PreviewStatus.STOPPED, None, None

                if response.status_code != 200:
                    return PreviewStatus.ERROR, None, f"Status check failed: {response.status_code}"

                data = response.json()
                status_str = data.get("status", "stopped")
                url = data.get("url")
                error = data.get("error")

                status = PreviewStatus(status_str) if status_str in PreviewStatus.__members__.values() else PreviewStatus.STOPPED

                return status, url, error

        except Exception as e:
            logger.error(f"Error checking preview status: {e}")
            return PreviewStatus.ERROR, None, str(e)

    async def start_preview(
        self, db: Session, task_id: int, user_id: int, force: bool = False
    ) -> PreviewStartResponse:
        """
        Start the preview service for a task.

        This triggers the executor manager to start the dev server
        inside the task's container.
        """
        # Verify task ownership
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.user_id == user_id,
                TaskResource.is_active == True,
            )
            .first()
        )

        if not task:
            return PreviewStartResponse(
                success=False,
                message="Task not found",
                status=PreviewStatus.ERROR,
            )

        try:
            executor_url = self._get_executor_manager_url()
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{executor_url}/executor-manager/preview/{task_id}/start",
                    json={"force": force},
                )

                if response.status_code == 404:
                    return PreviewStartResponse(
                        success=False,
                        message="Container not running or preview not configured",
                        status=PreviewStatus.ERROR,
                    )

                data = response.json()
                success = data.get("success", False)
                message = data.get("message", "Unknown status")
                status_str = data.get("status", "error")
                url = data.get("url")

                status = PreviewStatus(status_str) if status_str in PreviewStatus.__members__.values() else PreviewStatus.ERROR

                return PreviewStartResponse(
                    success=success,
                    message=message,
                    status=status,
                    url=url,
                )

        except httpx.TimeoutException:
            return PreviewStartResponse(
                success=False,
                message="Timeout starting preview service",
                status=PreviewStatus.ERROR,
            )
        except Exception as e:
            logger.error(f"Error starting preview for task {task_id}: {e}")
            return PreviewStartResponse(
                success=False,
                message=str(e),
                status=PreviewStatus.ERROR,
            )

    async def stop_preview(
        self, db: Session, task_id: int, user_id: int
    ) -> PreviewStopResponse:
        """
        Stop the preview service for a task.
        """
        # Verify task ownership
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.user_id == user_id,
                TaskResource.is_active == True,
            )
            .first()
        )

        if not task:
            return PreviewStopResponse(
                success=False,
                message="Task not found",
            )

        try:
            executor_url = self._get_executor_manager_url()
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{executor_url}/executor-manager/preview/{task_id}/stop"
                )

                if response.status_code == 404:
                    return PreviewStopResponse(
                        success=True,
                        message="Preview service was not running",
                    )

                data = response.json()
                return PreviewStopResponse(
                    success=data.get("success", True),
                    message=data.get("message", "Preview service stopped"),
                )

        except Exception as e:
            logger.error(f"Error stopping preview for task {task_id}: {e}")
            return PreviewStopResponse(
                success=False,
                message=str(e),
            )


# Singleton instance
preview_service = PreviewService()
