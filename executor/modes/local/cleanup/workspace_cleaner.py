# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Workspace cleaner for local executor mode.

Implements workspace directory cleanup and orphan detection.
"""

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Set

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("workspace_cleaner")


@dataclass
class WorkspaceInfo:
    """Information about a workspace directory."""

    task_id: str
    path: str
    size_mb: float
    is_orphan: bool = False


class WorkspaceCleaner:
    """
    Workspace directory cleanup manager.

    Features:
    - Sync workspaces with backend task list
    - Detect and cleanup orphan workspaces
    - Delete specific workspace by task_id
    """

    def __init__(self, workspace_root: str = None):
        """
        Initialize the workspace cleaner.

        Args:
            workspace_root: Workspace root directory. Defaults to config value.
        """
        self.workspace_root = workspace_root or config.LOCAL_WORKSPACE_ROOT

    def get_local_workspaces(self) -> List[WorkspaceInfo]:
        """
        Get all local workspace directories.

        Returns:
            List of WorkspaceInfo objects
        """
        workspaces = []
        root_path = Path(self.workspace_root)

        if not root_path.exists():
            return workspaces

        for item in root_path.iterdir():
            if item.is_dir():
                size_mb = self._get_directory_size_mb(str(item))
                workspaces.append(
                    WorkspaceInfo(
                        task_id=item.name,
                        path=str(item),
                        size_mb=size_mb,
                    )
                )

        return workspaces

    def sync_workspaces(self, valid_task_ids: List[str]) -> int:
        """
        Sync local workspaces with valid task IDs from backend.
        Removes workspaces that are not in the valid list.

        Args:
            valid_task_ids: List of valid task IDs from backend

        Returns:
            Number of workspaces removed
        """
        valid_set = set(str(tid) for tid in valid_task_ids)
        local_workspaces = self.get_local_workspaces()
        removed_count = 0

        for ws in local_workspaces:
            if ws.task_id not in valid_set:
                if self.delete_workspace(ws.task_id):
                    removed_count += 1

        if removed_count > 0:
            logger.info(f"[WORKSPACE_SYNC] Removed {removed_count} orphan workspaces")

        return removed_count

    def delete_workspace(self, task_id: str) -> bool:
        """
        Delete a specific workspace directory.

        Args:
            task_id: Task ID whose workspace should be deleted

        Returns:
            True if deleted successfully
        """
        workspace_path = os.path.join(self.workspace_root, str(task_id))

        if not os.path.exists(workspace_path):
            logger.debug(f"Workspace not found: {workspace_path}")
            return False

        try:
            size_mb = self._get_directory_size_mb(workspace_path)
            shutil.rmtree(workspace_path)
            logger.info(
                f"[WORKSPACE_CLEANUP] Removed workspace: task_id={task_id}, size={size_mb:.2f}MB"
            )
            return True
        except (OSError, IOError) as e:
            logger.error(f"Failed to delete workspace {workspace_path}: {e}")
            return False

    def detect_orphans(self, valid_task_ids: List[str]) -> List[WorkspaceInfo]:
        """
        Detect orphan workspaces (exist locally but not in backend).

        Args:
            valid_task_ids: List of valid task IDs from backend

        Returns:
            List of orphan WorkspaceInfo objects
        """
        valid_set = set(str(tid) for tid in valid_task_ids)
        local_workspaces = self.get_local_workspaces()
        orphans = []

        for ws in local_workspaces:
            if ws.task_id not in valid_set:
                ws.is_orphan = True
                orphans.append(ws)
                logger.warning(
                    f"[ORPHAN] task_id={ws.task_id}, path={ws.path}, size={ws.size_mb:.2f}MB"
                )

        return orphans

    def cleanup_orphans(self, valid_task_ids: List[str]) -> int:
        """
        Detect and automatically cleanup orphan workspaces.

        Args:
            valid_task_ids: List of valid task IDs from backend

        Returns:
            Number of orphan workspaces cleaned up
        """
        orphans = self.detect_orphans(valid_task_ids)
        cleaned = 0

        for ws in orphans:
            if self.delete_workspace(ws.task_id):
                cleaned += 1

        if cleaned > 0:
            logger.info(f"[ORPHAN_CLEANUP] Cleaned {cleaned} orphan workspaces")

        return cleaned

    def get_workspace_stats(self) -> dict:
        """
        Get statistics about current workspaces.

        Returns:
            Dict with workspace_count, total_size_mb
        """
        workspaces = self.get_local_workspaces()
        total_size = sum(ws.size_mb for ws in workspaces)

        return {
            "workspace_count": len(workspaces),
            "total_size_mb": total_size,
        }

    def _get_directory_size_mb(self, path: str) -> float:
        """
        Get total size of a directory in MB.

        Args:
            path: Directory path

        Returns:
            Size in MB
        """
        total_size = 0
        try:
            for dirpath, dirnames, filenames in os.walk(path):
                for filename in filenames:
                    filepath = os.path.join(dirpath, filename)
                    try:
                        total_size += os.path.getsize(filepath)
                    except (OSError, IOError):
                        continue
        except (OSError, IOError):
            pass

        return total_size / (1024 * 1024)
