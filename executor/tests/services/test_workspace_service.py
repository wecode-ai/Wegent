# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for workspace service.
"""

import io
import os
import subprocess
import tarfile
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from executor.services.workspace_service import (
    EXCLUDE_DIRS,
    SESSION_STATE_FILES,
    create_workspace_archive,
    get_git_tracked_files,
    get_workspace_path,
    restore_workspace_from_archive,
    should_exclude,
)


class TestShouldExclude:
    """Test should_exclude function."""

    def test_exclude_node_modules(self):
        """Test excluding node_modules directory."""
        assert should_exclude("node_modules/package/file.js") is True
        assert should_exclude("src/node_modules/file.js") is True

    def test_exclude_pycache(self):
        """Test excluding __pycache__ directory."""
        assert should_exclude("__pycache__/module.pyc") is True
        assert should_exclude("app/__pycache__/file.pyc") is True

    def test_exclude_git(self):
        """Test excluding .git directory."""
        assert should_exclude(".git/objects/file") is True

    def test_include_normal_files(self):
        """Test including normal files."""
        assert should_exclude("src/main.py") is False
        assert should_exclude("package.json") is False
        assert should_exclude("README.md") is False


class TestGetGitTrackedFiles:
    """Test get_git_tracked_files function."""

    def test_get_files_success(self, tmp_path):
        """Test getting git-tracked files from a git repo."""
        # Create a git repo with some files
        subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)

        # Create some files
        (tmp_path / "file1.py").write_text("content1")
        (tmp_path / "file2.js").write_text("content2")

        # Add files to git
        subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True)

        files = get_git_tracked_files(str(tmp_path))

        assert "file1.py" in files
        assert "file2.js" in files

    def test_get_files_non_git_directory(self, tmp_path):
        """Test getting files from non-git directory."""
        files = get_git_tracked_files(str(tmp_path))
        assert files == []


class TestCreateWorkspaceArchive:
    """Test create_workspace_archive function."""

    @patch("executor.services.workspace_service.get_workspace_path")
    @patch("executor.services.workspace_service.get_git_tracked_files")
    def test_create_archive_success(
        self, mock_git_files, mock_workspace_path, tmp_path
    ):
        """Test creating workspace archive successfully."""
        # Setup
        workspace_dir = tmp_path / "repo"
        workspace_dir.mkdir()
        (workspace_dir / "file1.py").write_text("content1")
        (workspace_dir / "file2.js").write_text("content2")

        # Session file
        (tmp_path / ".claude_session_id").write_text("session123")

        mock_workspace_path.return_value = str(workspace_dir)
        mock_git_files.return_value = ["file1.py", "file2.js"]

        # Execute
        archive_data, error = create_workspace_archive(123)

        # Verify
        assert error is None
        assert archive_data is not None
        assert len(archive_data) > 0

        # Verify archive contents
        buffer = io.BytesIO(archive_data)
        with tarfile.open(fileobj=buffer, mode="r:gz") as tar:
            names = tar.getnames()
            assert "file1.py" in names
            assert "file2.js" in names

    @patch("executor.services.workspace_service.get_workspace_path")
    def test_create_archive_workspace_not_found(self, mock_workspace_path):
        """Test creating archive when workspace doesn't exist."""
        mock_workspace_path.return_value = None

        archive_data, error = create_workspace_archive(123)

        assert archive_data is None
        assert "not found" in error.lower()


class TestRestoreWorkspaceFromArchive:
    """Test restore_workspace_from_archive function."""

    @patch("executor.services.workspace_service.get_workspace_path")
    @patch("executor.services.workspace_service.httpx")
    def test_restore_success(self, mock_httpx, mock_workspace_path, tmp_path):
        """Test restoring workspace from archive successfully."""
        # Setup workspace directory
        workspace_dir = tmp_path / "repo"
        workspace_dir.mkdir()
        mock_workspace_path.return_value = str(workspace_dir)

        # Create test archive
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            # Add a test file
            file_data = b"restored content"
            info = tarfile.TarInfo(name="restored_file.py")
            info.size = len(file_data)
            tar.addfile(info, io.BytesIO(file_data))
        buffer.seek(0)
        archive_data = buffer.read()

        # Mock HTTP client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = archive_data
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_httpx.Client.return_value = mock_client

        # Execute
        success, error = restore_workspace_from_archive(123, "http://test.url/archive")

        # Verify
        assert success is True
        assert error is None
        assert (workspace_dir / "restored_file.py").exists()
        assert (workspace_dir / "restored_file.py").read_text() == "restored content"

    @patch("executor.services.workspace_service.get_workspace_path")
    def test_restore_workspace_not_found(self, mock_workspace_path):
        """Test restoring when workspace doesn't exist."""
        mock_workspace_path.return_value = None

        success, error = restore_workspace_from_archive(123, "http://test.url/archive")

        assert success is False
        assert "not found" in error.lower()

    @patch("executor.services.workspace_service.get_workspace_path")
    @patch("executor.services.workspace_service.httpx")
    def test_restore_download_failure(self, mock_httpx, mock_workspace_path, tmp_path):
        """Test restoring when download fails."""
        workspace_dir = tmp_path / "repo"
        workspace_dir.mkdir()
        mock_workspace_path.return_value = str(workspace_dir)

        # Mock failed HTTP response
        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_httpx.Client.return_value = mock_client

        # Execute
        success, error = restore_workspace_from_archive(123, "http://test.url/archive")

        # Verify
        assert success is False
        assert "404" in error

    @patch("executor.services.workspace_service.get_workspace_path")
    @patch("executor.services.workspace_service.httpx")
    def test_restore_rejects_path_traversal(
        self, mock_httpx, mock_workspace_path, tmp_path
    ):
        """Test that restore rejects archives with path traversal."""
        workspace_dir = tmp_path / "repo"
        workspace_dir.mkdir()
        mock_workspace_path.return_value = str(workspace_dir)

        # Create malicious archive with path traversal
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            info = tarfile.TarInfo(name="../../../etc/passwd")
            info.size = 0
            tar.addfile(info, io.BytesIO(b""))
        buffer.seek(0)
        archive_data = buffer.read()

        # Mock HTTP client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = archive_data
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_httpx.Client.return_value = mock_client

        # Execute
        success, error = restore_workspace_from_archive(123, "http://test.url/archive")

        # Verify - should fail due to path traversal
        assert success is False
        assert "invalid" in error.lower()
