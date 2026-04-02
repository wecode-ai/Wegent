# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Workspace archive service for Pod recovery after deletion.

This module provides functionality to:
1. Archive workspace files to MinIO before Pod deletion
2. Restore workspace files when user sends a message after Pod deletion

Archive flow (Pod deletion):
1. Celery Beat triggers cleanup_stale_executors every 10 minutes
2. For each Pod to be deleted, generate presigned upload URL
3. Call executor /api/archive to package and upload workspace
4. Store archive metadata in Task.status.archive
5. Delete Pod and mark executor_deleted_at = True

Recovery flow (user sends message):
1. ExecutionDispatcher.dispatch() checks executor_deleted_at
2. If True, trigger ExecutorRecoveryService.recover()
3. Recreate Pod with skip_git_clone=true (avoid git clone conflict)
4. Generate presigned download URL and call executor /api/restore
5. Reset executor_deleted_at = False
6. Continue normal execution

Key components:
- ArchiveService: Core archive/restore logic
- ArchiveStorageService: MinIO presigned URL generation
"""

from app.services.workspace_archive.archive_service import (
    ArchiveService,
    archive_service,
)
from app.services.workspace_archive.storage import (
    ArchiveStorageService,
    archive_storage_service,
)

__all__ = [
    "ArchiveService",
    "archive_service",
    "ArchiveStorageService",
    "archive_storage_service",
]
