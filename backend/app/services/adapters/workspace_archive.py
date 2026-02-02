# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Workspace archive service for code task recovery.

This module provides functionality to archive and restore workspace files
when executor containers are cleaned up. It enables users to continue
working on code tasks even after the executor has been removed.

Archive format: tar.gz containing all Git-tracked files plus session state files.
Storage: S3-compatible object storage (AWS S3, MinIO, etc.)
"""

import io
import logging
import os
import subprocess
import tarfile
import tempfile
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.task import TaskResource
from app.schemas.kind import Task

logger = logging.getLogger(__name__)


# Files to always include in archive (session state)
SESSION_STATE_FILES = [
    ".claude_session_id",
]

# Directories to exclude from archive (large/generated content)
EXCLUDE_DIRS = [
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".env",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "target",
    "vendor",
    ".cache",
    ".npm",
    ".yarn",
]


def is_workspace_archive_enabled() -> bool:
    """
    Check if workspace archive feature is enabled and properly configured.

    Returns:
        True if the feature is enabled and S3 is configured
    """
    if not settings.WORKSPACE_ARCHIVE_ENABLED:
        return False

    # Check if S3 is configured
    return all(
        [
            settings.WORKSPACE_ARCHIVE_S3_ENDPOINT,
            settings.WORKSPACE_ARCHIVE_S3_BUCKET,
            settings.WORKSPACE_ARCHIVE_S3_ACCESS_KEY,
            settings.WORKSPACE_ARCHIVE_S3_SECRET_KEY,
        ]
    )


def get_workspace_s3_client():
    """
    Get S3 client for workspace archives.

    Returns:
        S3Client instance or None if not configured
    """
    from shared.utils.s3_client import S3Client, S3Config

    if not is_workspace_archive_enabled():
        return None

    config = S3Config(
        endpoint=settings.WORKSPACE_ARCHIVE_S3_ENDPOINT,
        bucket=settings.WORKSPACE_ARCHIVE_S3_BUCKET,
        access_key=settings.WORKSPACE_ARCHIVE_S3_ACCESS_KEY,
        secret_key=settings.WORKSPACE_ARCHIVE_S3_SECRET_KEY,
        region=settings.WORKSPACE_ARCHIVE_S3_REGION,
        use_ssl=settings.WORKSPACE_ARCHIVE_S3_USE_SSL,
    )

    return S3Client(config)


def generate_archive_key(task_id: int) -> str:
    """
    Generate S3 key for workspace archive.

    Args:
        task_id: Task ID

    Returns:
        S3 key in format: workspaces/{task_id}/archive.tar.gz
    """
    return f"workspaces/{task_id}/archive.tar.gz"


class WorkspaceArchiveService:
    """
    Service for archiving and restoring workspace files.

    This service handles:
    - Creating tar.gz archives of Git-tracked files
    - Uploading archives to S3
    - Downloading and extracting archives for restoration
    - Managing archive lifecycle
    """

    def __init__(self):
        self._s3_client = None

    @property
    def s3_client(self):
        """Lazy initialization of S3 client."""
        if self._s3_client is None:
            self._s3_client = get_workspace_s3_client()
        return self._s3_client

    def archive_workspace(
        self,
        db: Session,
        task_id: int,
        executor_name: str,
        executor_host: str = "localhost",
        executor_port: int = 8080,
    ) -> Tuple[bool, Optional[str]]:
        """
        Archive workspace for a task before executor cleanup.

        This method:
        1. Calls the executor's archive API to create a tar.gz
        2. Uploads the archive to S3
        3. Updates the task record with archive information

        Args:
            db: Database session
            task_id: Task ID to archive
            executor_name: Name of the executor container
            executor_host: Executor host address
            executor_port: Executor port

        Returns:
            Tuple of (success, error_message)
        """
        if not is_workspace_archive_enabled():
            logger.debug("Workspace archive feature is not enabled")
            return False, "Workspace archive feature is not enabled"

        # Get task and validate it's a code task
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
            return False, f"Task {task_id} not found"

        task_crd = Task.model_validate(task.json)
        task_type = (
            task_crd.metadata.labels and task_crd.metadata.labels.get("taskType")
        ) or "chat"

        if task_type != "code":
            logger.debug(f"Task {task_id} is not a code task, skipping archive")
            return False, "Only code tasks can be archived"

        # Get workspace info from task
        git_url = task_crd.spec.gitUrl if task_crd.spec else None
        if not git_url:
            logger.debug(f"Task {task_id} has no git URL, skipping archive")
            return False, "Task has no git repository"

        try:
            # Call executor's archive API
            archive_data = self._call_executor_archive_api(
                task_id, executor_host, executor_port
            )

            if archive_data is None:
                return False, "Failed to create archive from executor"

            # Check archive size
            archive_size_mb = len(archive_data) / (1024 * 1024)
            if archive_size_mb > settings.WORKSPACE_ARCHIVE_MAX_SIZE_MB:
                logger.warning(
                    f"Archive size ({archive_size_mb:.2f}MB) exceeds limit "
                    f"({settings.WORKSPACE_ARCHIVE_MAX_SIZE_MB}MB), skipping"
                )
                return False, f"Archive too large: {archive_size_mb:.2f}MB"

            # Upload to S3
            archive_key = generate_archive_key(task_id)
            if not self.s3_client.upload_bytes(archive_data, archive_key):
                return False, "Failed to upload archive to S3"

            # Update task record
            task.workspace_archived_at = datetime.now()
            task.workspace_archive_key = archive_key
            db.commit()

            logger.info(
                f"Successfully archived workspace for task {task_id} "
                f"(size: {archive_size_mb:.2f}MB, key: {archive_key})"
            )
            return True, None

        except Exception as e:
            logger.error(f"Failed to archive workspace for task {task_id}: {e}")
            return False, str(e)

    def _call_executor_archive_api(
        self,
        task_id: int,
        host: str,
        port: int,
        timeout: float = 60.0,
    ) -> Optional[bytes]:
        """
        Call executor's archive API to create workspace archive.

        Args:
            task_id: Task ID
            host: Executor host
            port: Executor port
            timeout: Request timeout in seconds

        Returns:
            Archive data as bytes, or None if failed
        """
        url = f"http://{host}:{port}/api/workspace/archive"
        params = {"task_id": task_id}

        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, params=params)
                if response.status_code == 200:
                    return response.content
                else:
                    logger.error(
                        f"Executor archive API returned {response.status_code}: "
                        f"{response.text}"
                    )
                    return None
        except Exception as e:
            logger.error(f"Failed to call executor archive API: {e}")
            return None

    def check_archive_exists(self, task_id: int) -> bool:
        """
        Check if an archive exists for the given task.

        Args:
            task_id: Task ID

        Returns:
            True if archive exists in S3
        """
        if not is_workspace_archive_enabled():
            return False

        archive_key = generate_archive_key(task_id)
        return self.s3_client.exists(archive_key)

    def get_archive_url(self, task_id: int, expires: int = 3600) -> Optional[str]:
        """
        Get presigned URL for downloading archive.

        Args:
            task_id: Task ID
            expires: URL expiration time in seconds

        Returns:
            Presigned URL or None if not available
        """
        if not is_workspace_archive_enabled():
            return None

        archive_key = generate_archive_key(task_id)
        return self.s3_client.get_presigned_url(archive_key, expires)

    def delete_archive(self, db: Session, task_id: int) -> bool:
        """
        Delete workspace archive for a task.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            True if deletion succeeded
        """
        if not is_workspace_archive_enabled():
            return False

        # Get task to find archive key
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
            )
            .first()
        )

        if not task or not task.workspace_archive_key:
            return False

        archive_key = task.workspace_archive_key

        # Delete from S3
        success = self.s3_client.delete(archive_key)

        # Clear archive fields in database
        task.workspace_archived_at = None
        task.workspace_archive_key = None
        db.commit()

        logger.info(f"Deleted workspace archive for task {task_id}: {archive_key}")
        return success

    def mark_for_restore(self, db: Session, task_id: int) -> bool:
        """
        Mark a task for workspace restoration.

        This sets the archive URL in task metadata so the executor
        knows to restore the workspace on startup.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            True if task was marked for restore
        """
        if not is_workspace_archive_enabled():
            return False

        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if not task or not task.workspace_archive_key:
            logger.debug(f"Task {task_id} has no archive to restore")
            return False

        # Generate presigned URL for executor to download
        archive_url = self.get_archive_url(task_id, expires=7200)  # 2 hours
        if not archive_url:
            logger.error(f"Failed to generate archive URL for task {task_id}")
            return False

        # Update task metadata to include restore info
        task_crd = Task.model_validate(task.json)
        if task_crd.metadata.labels is None:
            task_crd.metadata.labels = {}

        task_crd.metadata.labels["workspaceArchiveUrl"] = archive_url
        task_crd.metadata.labels["workspaceRestorePending"] = "true"

        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        db.commit()

        logger.info(f"Marked task {task_id} for workspace restoration")
        return True

    def clear_restore_flag(self, db: Session, task_id: int) -> None:
        """
        Clear the workspace restore flag after restoration.

        Args:
            db: Database session
            task_id: Task ID
        """
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
            return

        task_crd = Task.model_validate(task.json)
        if task_crd.metadata.labels:
            task_crd.metadata.labels.pop("workspaceArchiveUrl", None)
            task_crd.metadata.labels.pop("workspaceRestorePending", None)

            task.json = task_crd.model_dump(mode="json", exclude_none=True)
            db.commit()
            logger.debug(f"Cleared workspace restore flag for task {task_id}")


# Singleton instance
workspace_archive_service = WorkspaceArchiveService()
