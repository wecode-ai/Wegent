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

from app.core.bounded_executor import BoundedExecutor
from app.core.config import settings
from app.core.payload_codec import (
    decode_sync_response_json,
    decode_sync_response_text,
    encode_http_json,
)
from app.models.task import TaskResource
from app.schemas.kind import ArchiveInfo, Task
from app.utils.workspace_archive_time import (
    normalize_workspace_archive_datetime,
    workspace_archive_now,
)

from .storage import archive_storage_service

logger = logging.getLogger(__name__)

_ARCHIVE_STORAGE_EXECUTOR = BoundedExecutor(
    max_workers=4,
    max_in_flight=8,
    thread_name_prefix="wegent-archive-storage",
)


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
        task_id: int,
        executor_name: str,
        executor_namespace: str,
        runtime_type: str = "executor",
    ) -> Optional[ArchiveInfo]:
        """Archive workspace files before Pod deletion.

        Args:
            task_id: Task resource identity
            executor_name: Executor name
            executor_namespace: Executor namespace

        Returns:
            ArchiveInfo if successful, None if skipped or failed
        """
        if not settings.WORKSPACE_ARCHIVE_ENABLED:
            logger.info("Workspace archiving is disabled")
            return None

        logger.info(
            f"[ArchiveService] Starting archive for task {task_id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        try:
            upload_url, storage_key = await _ARCHIVE_STORAGE_EXECUTOR.run(
                archive_storage_service.generate_upload_url,
                task_id,
            )

            # Call executor to archive workspace
            archive_result = await self._call_executor_archive(
                task_id=task_id,
                upload_url=upload_url,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
                runtime_type=runtime_type,
            )

            if not archive_result:
                # Executor may have uploaded the file before the response failed.
                # Check MinIO directly so we don't discard a successful upload.
                archive_result = await _ARCHIVE_STORAGE_EXECUTOR.run(
                    self._try_recover_archive,
                    task_id,
                    storage_key,
                )
                if not archive_result:
                    logger.warning(
                        f"[ArchiveService] Archive failed for task {task_id}, "
                        "file not found in storage either"
                    )
                    return None

            # Create archive info
            expires_at = await _ARCHIVE_STORAGE_EXECUTOR.run(
                archive_storage_service.calculate_expiration_time
            )
            archive_info = ArchiveInfo(
                storageKey=storage_key,
                archivedAt=workspace_archive_now(),
                expiresAt=expires_at,
                sizeBytes=archive_result.get("size_bytes"),
                sessionFileIncluded=archive_result.get("session_file_included", False),
                gitIncluded=archive_result.get("git_included", False),
            )

            from app.services.chat.storage.db import run_sync_in_executor

            await run_sync_in_executor(
                self._persist_task_archive_info_sync,
                task_id,
                archive_info,
            )

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

    async def restore_workspace_snapshot(
        self,
        *,
        task_id: int,
        task_json: Dict[str, Any],
        executor_name: str,
        executor_namespace: str,
        runtime_type: str = "executor",
    ) -> Optional[Dict[str, Any]]:
        """Restore a detached task snapshot without blocking the event loop."""
        logger.info(
            f"[ArchiveService] Starting restore for task {task_id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        try:
            download_url = await _ARCHIVE_STORAGE_EXECUTOR.run(
                self._prepare_restore_download_sync,
                task_id,
                task_json,
            )
            if download_url is None:
                return None

            restore_result = await self._call_executor_restore(
                task_id=task_id,
                download_url=download_url,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
                runtime_type=runtime_type,
            )

            if not restore_result or not restore_result.get("success", False):
                logger.warning(f"[ArchiveService] Restore failed for task {task_id}")
                return None

            logger.info(
                f"[ArchiveService] Successfully restored task {task_id}, "
                f"session_restored={restore_result.get('session_restored', False)}, "
                f"git_restored={restore_result.get('git_restored', False)}"
            )

            return restore_result

        except Exception as e:
            logger.error(
                f"[ArchiveService] Error restoring workspace for task {task_id}: {e}",
                exc_info=True,
            )
            return None

    def _prepare_restore_download_sync(
        self,
        task_id: int,
        task_json: Dict[str, Any],
    ) -> Optional[str]:
        """Validate an archive and prepare its URL outside the event loop."""
        task_crd = Task.model_validate(task_json)
        archive_info = task_crd.status.archive if task_crd.status else None
        if not archive_info or not archive_info.storageKey:
            logger.info(
                f"[ArchiveService] No archive found for task {task_id}, "
                "will use git clone instead"
            )
            return None
        if (
            archive_info.expiresAt
            and normalize_workspace_archive_datetime(archive_info.expiresAt)
            < workspace_archive_now()
        ):
            logger.info(
                f"[ArchiveService] Archive expired for task {task_id}, "
                f"expired at {archive_info.expiresAt}"
            )
            return None
        if not archive_storage_service.archive_exists(archive_info.storageKey):
            logger.warning(
                f"[ArchiveService] Archive file not found for task {task_id}, "
                f"key={archive_info.storageKey}"
            )
            return None
        return archive_storage_service.generate_download_url(archive_info.storageKey)

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
        runtime_type: str = "executor",
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
            "runtime_type": runtime_type,
        }

        logger.info(
            f"[ArchiveService] Calling executor archive: task_id={task_id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                request_body = await encode_http_json(payload)
                response = await client.post(
                    url,
                    content=request_body,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                return await decode_sync_response_json(response)
        except httpx.HTTPStatusError as e:
            response_text = await decode_sync_response_text(e.response)
            logger.error(
                f"[ArchiveService] HTTP error calling archive: "
                f"task_id={task_id} status={e.response.status_code} "
                f"body={response_text[:500]}"
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
        runtime_type: str = "executor",
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
            "runtime_type": runtime_type,
        }

        logger.info(
            f"[ArchiveService] Calling executor restore: task_id={task_id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                request_body = await encode_http_json(payload)
                response = await client.post(
                    url,
                    content=request_body,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                return await decode_sync_response_json(response)
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

    def _persist_task_archive_info_sync(
        self,
        task_id: int,
        archive_info: ArchiveInfo,
    ) -> None:
        """Persist archive metadata with a worker-owned session."""
        from app.db.session import get_db_session
        from app.stores.tasks import task_store

        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=task_id)
            if not task:
                raise ValueError(f"Task {task_id} no longer exists")
            self._update_task_archive_info(db, task, archive_info)
            db.commit()

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
