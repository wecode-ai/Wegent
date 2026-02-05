# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox file syncer service for synchronizing files to running sandboxes.

This service provides functionality to:
- Check if a sandbox is running and healthy
- Upload files to running sandboxes via the envd /files endpoint

The sync is performed in the background and failures are logged but do not
block the attachment upload flow.
"""

import asyncio
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Configuration
EXECUTOR_MANAGER_URL = os.getenv("EXECUTOR_MANAGER_URL", "http://localhost:8001")
SANDBOX_FILE_SYNC_TIMEOUT = float(os.getenv("SANDBOX_FILE_SYNC_TIMEOUT", "30.0"))
SANDBOX_STATUS_CHECK_TIMEOUT = float(os.getenv("SANDBOX_STATUS_CHECK_TIMEOUT", "5.0"))

# Valid sandbox statuses for file sync
SANDBOX_HEALTHY_STATUSES = {"running"}


def _sanitize_filename(filename: str) -> str:
    """Sanitize filename to prevent path traversal attacks.

    Args:
        filename: Original filename

    Returns:
        Sanitized filename safe for use in file paths
    """
    # Get basename to remove any directory components
    safe_name = os.path.basename(filename or "attachment")
    # Replace path separators that might have been encoded
    safe_name = safe_name.replace("/", "_").replace("\\", "_")
    # Remove control characters
    safe_name = safe_name.replace("\n", "").replace("\r", "")
    return safe_name if safe_name else "attachment"


def build_sandbox_attachment_path(task_id: int, subtask_id: int, filename: str) -> str:
    """Build the sandbox path for an attachment.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        filename: Original filename

    Returns:
        Path where the attachment should be stored in sandbox
    """
    safe_filename = _sanitize_filename(filename)
    return f"/home/user/{task_id}:executor:attachments/{subtask_id}/{safe_filename}"


class SandboxFileSyncer:
    """Service for synchronizing files to running sandboxes.

    This service is used to sync uploaded attachments to running sandboxes
    so that the executor can access them without re-downloading.

    Example:
        syncer = SandboxFileSyncer()
        await syncer.sync_attachment_to_sandbox(
            task_id=123,
            subtask_id=456,
            filename="document.pdf",
            binary_data=file_bytes,
        )
    """

    def __init__(
        self,
        executor_manager_url: Optional[str] = None,
        file_sync_timeout: Optional[float] = None,
        status_check_timeout: Optional[float] = None,
    ):
        """Initialize the sandbox file syncer.

        Args:
            executor_manager_url: URL of executor_manager service
            file_sync_timeout: Timeout for file upload in seconds
            status_check_timeout: Timeout for sandbox status check in seconds
        """
        self.executor_manager_url = (
            executor_manager_url or EXECUTOR_MANAGER_URL
        ).rstrip("/")
        self.file_sync_timeout = file_sync_timeout or SANDBOX_FILE_SYNC_TIMEOUT
        self.status_check_timeout = status_check_timeout or SANDBOX_STATUS_CHECK_TIMEOUT

    async def is_sandbox_healthy(self, task_id: int) -> tuple[bool, Optional[str]]:
        """Check if the sandbox for a task is running and healthy.

        Args:
            task_id: Task ID (sandbox_id is derived from task_id)

        Returns:
            Tuple of (is_healthy, base_url or None)
        """
        sandbox_id = str(task_id)
        url = f"{self.executor_manager_url}/executor-manager/sandboxes/{sandbox_id}"

        try:
            async with httpx.AsyncClient(timeout=self.status_check_timeout) as client:
                response = await client.get(url)

                if response.status_code == 404:
                    logger.debug(f"[SandboxFileSyncer] Sandbox {sandbox_id} not found")
                    return False, None

                if response.status_code != 200:
                    logger.warning(
                        f"[SandboxFileSyncer] Failed to get sandbox status: "
                        f"HTTP {response.status_code}"
                    )
                    return False, None

                data = response.json()
                status = data.get("status", "").lower()
                base_url = data.get("base_url")

                if status in SANDBOX_HEALTHY_STATUSES and base_url:
                    logger.info(
                        f"[SandboxFileSyncer] Sandbox {sandbox_id} is healthy: "
                        f"status={status}, base_url={base_url}"
                    )
                    return True, base_url
                else:
                    logger.warning(
                        f"[SandboxFileSyncer] Sandbox {sandbox_id} not healthy: "
                        f"status={status}, base_url={base_url}"
                    )
                    return False, None

        except httpx.TimeoutException:
            logger.warning(
                f"[SandboxFileSyncer] Timeout checking sandbox {sandbox_id} status"
            )
            return False, None
        except Exception as e:
            logger.error(
                f"[SandboxFileSyncer] Error checking sandbox {sandbox_id} status: {e}"
            )
            return False, None

    async def upload_file_to_sandbox(
        self,
        base_url: str,
        remote_path: str,
        binary_data: bytes,
        filename: str,
    ) -> bool:
        """Upload a file to the sandbox via envd /files endpoint.

        Args:
            base_url: Sandbox base URL (e.g., http://localhost:8080)
            remote_path: Path where the file should be stored in sandbox
            binary_data: File content
            filename: Original filename

        Returns:
            True if upload succeeded, False otherwise
        """
        # envd expects POST /files with path query parameter
        url = f"{base_url}/files"
        params = {"path": remote_path}

        try:
            async with httpx.AsyncClient(timeout=self.file_sync_timeout) as client:
                # Send as multipart form data
                files = {"file": (filename, binary_data)}
                response = await client.post(url, params=params, files=files)

                if response.status_code == 200:
                    logger.info(
                        f"[SandboxFileSyncer] Successfully uploaded file to sandbox: "
                        f"{remote_path}"
                    )
                    return True
                else:
                    logger.warning(
                        f"[SandboxFileSyncer] Failed to upload file to sandbox: "
                        f"HTTP {response.status_code}, response={response.text[:200]}"
                    )
                    return False

        except httpx.TimeoutException:
            logger.warning(
                f"[SandboxFileSyncer] Timeout uploading file to sandbox: {remote_path}"
            )
            return False
        except Exception as e:
            logger.warning(f"[SandboxFileSyncer] Error uploading file to sandbox: {e}")
            return False

    async def sync_attachment_to_sandbox(
        self,
        task_id: int,
        subtask_id: int,
        filename: str,
        binary_data: bytes,
    ) -> bool:
        """Sync an attachment to the sandbox if it's running.

        This method checks if the sandbox is healthy and uploads the file.
        Failures are logged but do not raise exceptions.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            filename: Original filename
            binary_data: File content

        Returns:
            True if sync succeeded, False otherwise (including if sandbox not running)
        """
        # Check if sandbox is healthy
        is_healthy, base_url = await self.is_sandbox_healthy(task_id)
        if not is_healthy or not base_url:
            logger.debug(
                f"[SandboxFileSyncer] Skipping sync for task {task_id}: "
                f"sandbox not healthy"
            )
            return False

        # Build target path
        remote_path = build_sandbox_attachment_path(task_id, subtask_id, filename)

        # Upload file
        success = await self.upload_file_to_sandbox(
            base_url=base_url,
            remote_path=remote_path,
            binary_data=binary_data,
            filename=_sanitize_filename(filename),
        )

        if success:
            logger.info(
                f"[SandboxFileSyncer] Synced attachment to sandbox: "
                f"task_id={task_id}, subtask_id={subtask_id}, filename={filename}"
            )
        else:
            logger.warning(
                f"[SandboxFileSyncer] Failed to sync attachment to sandbox: "
                f"task_id={task_id}, subtask_id={subtask_id}, filename={filename}"
            )

        return success


# Global instance
_sandbox_file_syncer: Optional[SandboxFileSyncer] = None


def get_sandbox_file_syncer() -> SandboxFileSyncer:
    """Get the global SandboxFileSyncer instance.

    Returns:
        The SandboxFileSyncer singleton
    """
    global _sandbox_file_syncer
    if _sandbox_file_syncer is None:
        _sandbox_file_syncer = SandboxFileSyncer()
    return _sandbox_file_syncer


async def sync_attachment_to_sandbox_background(
    task_id: int,
    subtask_id: int,
    filename: str,
    binary_data: bytes,
) -> None:
    """Sync attachment to sandbox in background.

    This function is designed to be called from asyncio.create_task()
    and handles all exceptions internally.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        filename: Original filename
        binary_data: File content
    """
    try:
        syncer = get_sandbox_file_syncer()
        await syncer.sync_attachment_to_sandbox(
            task_id=task_id,
            subtask_id=subtask_id,
            filename=filename,
            binary_data=binary_data,
        )
    except Exception:
        logger.exception("[SandboxFileSyncer] Unexpected error in background sync")
