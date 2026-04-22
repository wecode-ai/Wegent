# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Core archive service for workspace archiving and restoration.

Provides functionality to:
1. Archive workspace before Pod deletion
2. Restore workspace when user resumes conversation
3. Update Task metadata with archive information
"""

import logging
from copy import deepcopy
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

import httpx
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.kind import ArchiveInfo, Task
from app.utils.workspace_archive_time import (
    normalize_workspace_archive_datetime,
    workspace_archive_now,
)

from .storage import archive_storage_service

logger = logging.getLogger(__name__)


class ArchiveService:
    """Core service for workspace archiving and restoration.

    This service coordinates between:
    - Backend: Generates presigned URLs and stores metadata
    - Executor Manager: Routes requests to executor pods
    - Executor: Packages/extracts workspace files
    - MinIO: Stores archive files

    Archive flow:
    1. Generate presigned upload URL
    2. Call executor_manager -> executor /api/archive
    3. Executor packages workspace and uploads directly to MinIO
    4. Store archive metadata in Task.status.archive

    Restore flow:
    1. Check if archive exists and is not expired
    2. Generate presigned download URL
    3. Call executor /api/restore after Pod is created
    4. Executor downloads and extracts archive
    """

    async def archive_workspace(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        executor_name: str,
        executor_namespace: str,
    ) -> Optional[ArchiveInfo]:
        """Archive workspace files before Pod deletion.

        Args:
            db: Database session
            subtask: Subtask with executor info
            task: Task resource
            executor_name: Executor name
            executor_namespace: Executor namespace

        Returns:
            ArchiveInfo if successful, None if skipped or failed
        """
        if not settings.WORKSPACE_ARCHIVE_ENABLED:
            logger.info("Workspace archiving is disabled")
            return None

        task_id = task.id
        logger.info(
            f"[ArchiveService] Starting archive for task {task_id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        try:
            # Generate presigned upload URL
            upload_url, storage_key = archive_storage_service.generate_upload_url(
                task_id
            )

            # Call executor to archive workspace
            archive_result = await self._call_executor_archive(
                task_id=task_id,
                upload_url=upload_url,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )

            if not archive_result:
                # Executor may have uploaded the file before the response failed.
                # Check MinIO directly so we don't discard a successful upload.
                archive_result = self._try_recover_archive(task_id, storage_key)
                if not archive_result:
                    logger.warning(
                        f"[ArchiveService] Archive failed for task {task_id}, "
                        "file not found in storage either"
                    )
                    return None

            # Create archive info
            archive_info = ArchiveInfo(
                storageKey=storage_key,
                archivedAt=workspace_archive_now(),
                expiresAt=archive_storage_service.calculate_expiration_time(),
                sizeBytes=archive_result.get("size_bytes"),
                sessionFileIncluded=archive_result.get("session_file_included", False),
                gitIncluded=archive_result.get("git_included", False),
            )

            # Update task status with archive info
            self._update_task_archive_info(db, task, archive_info)

            logger.info(
                f"[ArchiveService] Successfully archived task {task_id}, "
                f"size={archive_info.sizeBytes} bytes, "
                f"session_included={archive_info.sessionFileIncluded}, "
                f"git_included={archive_info.gitIncluded}"
            )

            return archive_info

        except Exception as e:
            logger.error(
                f"[ArchiveService] Error archiving workspace for task {task_id}: {e}",
                exc_info=True,
            )
            return None

    async def restore_workspace(
        self,
        db: Session,
        task: TaskResource,
        executor_name: str,
        executor_namespace: str,
    ) -> bool:
        """Restore workspace files after Pod recreation.

        Args:
            db: Database session
            task: Task resource with archive info
            executor_name: New executor name
            executor_namespace: New executor namespace

        Returns:
            True if restoration successful, False otherwise
        """
        task_id = task.id
        logger.info(
            f"[ArchiveService] Starting restore for task {task_id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        try:
            # Get archive info from task
            task_crd = Task.model_validate(task.json)
            archive_info = task_crd.status.archive if task_crd.status else None

            if not archive_info or not archive_info.storageKey:
                logger.info(
                    f"[ArchiveService] No archive found for task {task_id}, "
                    "will use git clone instead"
                )
                return False

            # Check if archive is expired
            if (
                archive_info.expiresAt
                and normalize_workspace_archive_datetime(archive_info.expiresAt)
                < workspace_archive_now()
            ):
                logger.info(
                    f"[ArchiveService] Archive expired for task {task_id}, "
                    f"expired at {archive_info.expiresAt}"
                )
                return False

            # Check if archive file exists
            if not archive_storage_service.archive_exists(archive_info.storageKey):
                logger.warning(
                    f"[ArchiveService] Archive file not found for task {task_id}, "
                    f"key={archive_info.storageKey}"
                )
                return False

            # Generate presigned download URL
            download_url = archive_storage_service.generate_download_url(
                archive_info.storageKey
            )

            # Call executor to restore workspace
            restore_result = await self._call_executor_restore(
                task_id=task_id,
                download_url=download_url,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )

            if not restore_result:
                logger.warning(f"[ArchiveService] Restore failed for task {task_id}")
                return False

            logger.info(
                f"[ArchiveService] Successfully restored task {task_id}, "
                f"session_restored={restore_result.get('session_restored', False)}, "
                f"git_restored={restore_result.get('git_restored', False)}"
            )

            return True

        except Exception as e:
            logger.error(
                f"[ArchiveService] Error restoring workspace for task {task_id}: {e}",
                exc_info=True,
            )
            return False

    def check_archive_available(
        self, task: TaskResource
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """Check if archive is available for restoration.

        Args:
            task: Task resource

        Returns:
            Tuple of (available, storage_key or None, reason or None).
            Reason is "expired" when archive exists but has expired,
            None when no archive exists or archive is available.
        """
        try:
            task_crd = Task.model_validate(task.json)
            archive_info = task_crd.status.archive if task_crd.status else None

            if not archive_info or not archive_info.storageKey:
                return False, None, None

            # Check expiration
            if (
                archive_info.expiresAt
                and normalize_workspace_archive_datetime(archive_info.expiresAt)
                < workspace_archive_now()
            ):
                return False, None, "expired"

            return True, archive_info.storageKey, None

        except Exception as e:
            logger.error(f"[ArchiveService] Error checking archive: {e}")
            return False, None, None

    async def _call_executor_archive(
        self,
        task_id: int,
        upload_url: str,
        executor_name: str,
        executor_namespace: str,
    ) -> Optional[Dict[str, Any]]:
        """Call executor to archive workspace.

        Args:
            task_id: Task ID
            upload_url: Presigned upload URL for MinIO
            executor_name: Executor name
            executor_namespace: Executor namespace

        Returns:
            Archive result dict if successful, None otherwise
        """
        # Build URL to executor_manager archive endpoint
        base_url = settings.EXECUTOR_MANAGER_URL.rstrip("/")
        url = f"{base_url}/executor-manager/executor/archive"

        payload = {
            "task_id": task_id,
            "upload_url": upload_url,
            "executor_name": executor_name,
            "executor_namespace": executor_namespace,
            "max_size_mb": settings.WORKSPACE_ARCHIVE_MAX_SIZE_MB,
        }

        logger.info(
            f"[ArchiveService] Calling executor archive: task_id={task_id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as e:
            logger.error(
                f"[ArchiveService] HTTP error calling archive: "
                f"task_id={task_id} status={e.response.status_code} "
                f"body={e.response.text[:500]}"
            )
            return None
        except httpx.HTTPError as e:
            logger.error(
                f"[ArchiveService] HTTP error calling archive: "
                f"task_id={task_id} error={e}"
            )
            return None
        except Exception as e:
            logger.error(
                f"[ArchiveService] Error calling archive: task_id={task_id} error={e}"
            )
            return None

    async def _call_executor_restore(
        self,
        task_id: int,
        download_url: str,
        executor_name: str,
        executor_namespace: str,
    ) -> Optional[Dict[str, Any]]:
        """Call executor to restore workspace.

        Args:
            task_id: Task ID
            download_url: Presigned download URL for MinIO
            executor_name: Executor name
            executor_namespace: Executor namespace

        Returns:
            Restore result dict if successful, None otherwise
        """
        # Build URL to executor_manager restore endpoint
        base_url = settings.EXECUTOR_MANAGER_URL.rstrip("/")
        url = f"{base_url}/executor-manager/executor/restore"

        payload = {
            "task_id": task_id,
            "download_url": download_url,
            "executor_name": executor_name,
            "executor_namespace": executor_namespace,
        }

        logger.info(
            f"[ArchiveService] Calling executor restore: task_id={task_id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPError as e:
            logger.error(f"[ArchiveService] HTTP error calling restore: {e}")
            return None
        except Exception as e:
            logger.error(f"[ArchiveService] Error calling restore: {e}")
            return None

    def _try_recover_archive(
        self, task_id: int, storage_key: str
    ) -> Optional[Dict[str, Any]]:
        """Check if the archive file exists in storage despite a failed API call.

        The executor may have successfully uploaded the file to MinIO before
        the HTTP response failed. In that case we can still record the archive.
        """
        try:
            if not archive_storage_service.archive_exists(storage_key):
                return None

            stat = archive_storage_service.client.stat_object(
                archive_storage_service._bucket, storage_key
            )
            logger.info(
                f"[ArchiveService] Recovered archive from storage: "
                f"task_id={task_id} size={stat.size} bytes"
            )
            return {"size_bytes": stat.size}
        except Exception as e:
            logger.warning(
                f"[ArchiveService] Failed to recover archive from storage: "
                f"task_id={task_id} error={e}"
            )
            return None

    def _update_task_archive_info(
        self, db: Session, task: TaskResource, archive_info: ArchiveInfo
    ) -> None:
        """Update task status with archive information.

        Args:
            db: Database session
            task: Task resource to update
            archive_info: Archive information to store
        """
        try:
            task_json = deepcopy(task.json)
            if "status" not in task_json:
                task_json["status"] = {}

            # Convert ArchiveInfo to dict for JSON storage
            task_json["status"]["archive"] = archive_info.model_dump(mode="json")

            task.json = task_json
            flag_modified(task, "json")
            # Use merge() instead of add() because the task object may be
            # bound to a different session (the caller creates a short-lived
            # sync session while the task was loaded by the main async session).
            db.merge(task)
            # Note: commit is done by caller

            logger.info(f"[ArchiveService] Updated archive info for task {task.id}")

        except Exception as e:
            logger.error(f"[ArchiveService] Error updating archive info: {e}")
            raise


# Global service instance
archive_service = ArchiveService()
