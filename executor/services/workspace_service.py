# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Workspace archive and restore service for executor.

This module provides functionality to:
1. Create tar.gz archives of workspace files for backup before executor cleanup
2. Restore workspace from S3 archives when executor is rebuilt

The archive includes:
- All Git-tracked files (via git ls-files)
- Session state files (.claude_session_id)
- Excludes: .git, node_modules, __pycache__, etc.
"""

import io
import os
import subprocess
import tarfile
import tempfile
from typing import List, Optional, Tuple

import httpx

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger(__name__)


# Files to always include in archive (session state)
SESSION_STATE_FILES = [
    ".claude_session_id",
]

# Directories to exclude from archive
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


def get_workspace_path(task_id: int) -> Optional[str]:
    """
    Get the workspace path for a task.

    Args:
        task_id: Task ID

    Returns:
        Workspace path if exists, None otherwise
    """
    workspace_root = config.get_workspace_root()
    task_workspace = os.path.join(workspace_root, str(task_id))

    if not os.path.exists(task_workspace):
        return None

    # Find the repository directory (should be the only subdirectory)
    for item in os.listdir(task_workspace):
        item_path = os.path.join(task_workspace, item)
        if os.path.isdir(item_path) and not item.startswith("."):
            return item_path

    return task_workspace


def get_git_tracked_files(workspace_path: str) -> List[str]:
    """
    Get list of Git-tracked files in workspace.

    Args:
        workspace_path: Path to the workspace

    Returns:
        List of relative file paths
    """
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            files = [f.strip() for f in result.stdout.split("\n") if f.strip()]
            return files
        else:
            logger.warning(f"git ls-files failed: {result.stderr}")
            return []
    except Exception as e:
        logger.warning(f"Failed to get git tracked files: {e}")
        return []


def should_exclude(file_path: str) -> bool:
    """
    Check if a file should be excluded from archive.

    Args:
        file_path: Relative file path

    Returns:
        True if file should be excluded
    """
    parts = file_path.split(os.sep)
    for part in parts:
        if part in EXCLUDE_DIRS:
            return True
    return False


def create_workspace_archive(task_id: int) -> Tuple[Optional[bytes], Optional[str]]:
    """
    Create a tar.gz archive of the workspace.

    Args:
        task_id: Task ID

    Returns:
        Tuple of (archive_bytes, error_message)
    """
    workspace_path = get_workspace_path(task_id)
    if not workspace_path:
        return None, f"Workspace not found for task {task_id}"

    logger.info(f"Creating workspace archive for task {task_id} at {workspace_path}")

    try:
        # Get git-tracked files
        tracked_files = get_git_tracked_files(workspace_path)
        logger.info(f"Found {len(tracked_files)} git-tracked files")

        # Filter out excluded files
        files_to_archive = [f for f in tracked_files if not should_exclude(f)]
        logger.info(f"After exclusion filter: {len(files_to_archive)} files")

        # Add session state files from task workspace root
        task_workspace = os.path.dirname(workspace_path)
        session_files = []
        for session_file in SESSION_STATE_FILES:
            session_path = os.path.join(task_workspace, session_file)
            if os.path.exists(session_path):
                session_files.append((session_path, session_file))

        # Create tar.gz in memory
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            # Add git-tracked files
            for file_path in files_to_archive:
                full_path = os.path.join(workspace_path, file_path)
                if os.path.exists(full_path) and os.path.isfile(full_path):
                    tar.add(full_path, arcname=file_path)

            # Add session state files with special prefix
            for full_path, name in session_files:
                tar.add(full_path, arcname=f"__session__/{name}")

        buffer.seek(0)
        archive_data = buffer.read()

        logger.info(
            f"Created workspace archive: {len(files_to_archive)} files, "
            f"{len(session_files)} session files, "
            f"total size: {len(archive_data)} bytes"
        )

        return archive_data, None

    except Exception as e:
        error_msg = f"Failed to create workspace archive: {e}"
        logger.error(error_msg)
        return None, error_msg


def restore_workspace_from_archive(
    task_id: int, archive_url: str
) -> Tuple[bool, Optional[str]]:
    """
    Restore workspace from a presigned S3 URL.

    Args:
        task_id: Task ID
        archive_url: Presigned URL to download the archive

    Returns:
        Tuple of (success, error_message)
    """
    workspace_path = get_workspace_path(task_id)
    if not workspace_path:
        return False, f"Workspace not found for task {task_id}"

    task_workspace = os.path.dirname(workspace_path)
    logger.info(f"Restoring workspace for task {task_id} from archive")

    try:
        # Download archive
        with httpx.Client(timeout=120.0) as client:
            response = client.get(archive_url)
            if response.status_code != 200:
                return False, f"Failed to download archive: HTTP {response.status_code}"
            archive_data = response.content

        logger.info(f"Downloaded archive: {len(archive_data)} bytes")

        # Extract archive
        buffer = io.BytesIO(archive_data)
        with tarfile.open(fileobj=buffer, mode="r:gz") as tar:
            # Check for path traversal attacks
            for member in tar.getmembers():
                if member.name.startswith("/") or ".." in member.name:
                    return False, f"Invalid archive member: {member.name}"

            # Extract files
            for member in tar.getmembers():
                if member.name.startswith("__session__/"):
                    # Session file - extract to task workspace root
                    session_name = member.name[len("__session__/") :]
                    target_path = os.path.join(task_workspace, session_name)
                    # Extract to temp then move
                    tar.extract(member, task_workspace)
                    extracted_path = os.path.join(task_workspace, member.name)
                    if os.path.exists(extracted_path):
                        os.rename(extracted_path, target_path)
                        logger.debug(f"Restored session file: {session_name}")
                else:
                    # Regular file - extract to workspace
                    target_path = os.path.join(workspace_path, member.name)
                    target_dir = os.path.dirname(target_path)
                    if target_dir and not os.path.exists(target_dir):
                        os.makedirs(target_dir, exist_ok=True)
                    tar.extract(member, workspace_path)

        # Clean up __session__ directory if created
        session_dir = os.path.join(task_workspace, "__session__")
        if os.path.exists(session_dir):
            import shutil

            shutil.rmtree(session_dir)

        logger.info(f"Successfully restored workspace for task {task_id}")
        return True, None

    except Exception as e:
        error_msg = f"Failed to restore workspace: {e}"
        logger.error(error_msg)
        return False, error_msg
