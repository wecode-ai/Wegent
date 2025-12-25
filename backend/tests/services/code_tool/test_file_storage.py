# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Code Tool file storage service."""

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.code_tool.file_storage import FileStorageService


class TestFileStorageService:
    """Tests for FileStorageService."""

    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def file_storage(self, temp_dir):
        """Create a FileStorageService with temporary directory."""
        with patch.object(FileStorageService, "__init__", lambda self: None):
            service = FileStorageService()
            service.temp_dir = Path(temp_dir)
            service.max_file_size = 100 * 1024 * 1024  # 100MB
            service.link_expire_seconds = 86400
            return service

    @pytest.mark.asyncio
    async def test_store_file_success(self, file_storage):
        """Test storing a file successfully."""
        session_id = "test-session-123"
        filename = "test.txt"
        content = b"Hello, World!"

        result = await file_storage.store_file(
            session_id=session_id,
            filename=filename,
            content=content,
            subdir="input",
        )

        assert result["filename"] == "test.txt"
        assert result["size"] == len(content)
        assert "file_id" in result
        assert "path" in result
        assert os.path.exists(result["path"])

    @pytest.mark.asyncio
    async def test_store_file_sanitizes_filename(self, file_storage):
        """Test that filenames are sanitized."""
        session_id = "test-session-123"
        filename = "../../../etc/passwd"
        content = b"test content"

        result = await file_storage.store_file(
            session_id=session_id,
            filename=filename,
            content=content,
        )

        # Filename should be sanitized
        assert ".." not in result["filename"]
        assert "/" not in result["filename"]

    @pytest.mark.asyncio
    async def test_store_file_rejects_too_large(self, file_storage):
        """Test that files exceeding max size are rejected."""
        file_storage.max_file_size = 10  # 10 bytes
        session_id = "test-session-123"
        filename = "large.txt"
        content = b"This is a file that exceeds the limit"

        with pytest.raises(ValueError, match="File size exceeds"):
            await file_storage.store_file(
                session_id=session_id,
                filename=filename,
                content=content,
            )

    @pytest.mark.asyncio
    async def test_get_file_success(self, file_storage):
        """Test retrieving a stored file."""
        session_id = "test-session-123"
        filename = "test.txt"
        content = b"Test content"

        # Store the file first
        stored = await file_storage.store_file(
            session_id=session_id,
            filename=filename,
            content=content,
        )

        # Retrieve it
        result = await file_storage.get_file(session_id, stored["file_id"])

        assert result is not None
        assert result["file_id"] == stored["file_id"]
        assert result["filename"] == filename

    @pytest.mark.asyncio
    async def test_get_file_not_found(self, file_storage):
        """Test retrieving a non-existent file."""
        result = await file_storage.get_file("nonexistent-session", "nonexistent-id")
        assert result is None

    @pytest.mark.asyncio
    async def test_read_file_success(self, file_storage):
        """Test reading file content."""
        session_id = "test-session-123"
        filename = "test.txt"
        content = b"Test content for reading"

        stored = await file_storage.store_file(
            session_id=session_id,
            filename=filename,
            content=content,
        )

        read_content = await file_storage.read_file(session_id, stored["file_id"])

        assert read_content == content

    @pytest.mark.asyncio
    async def test_cleanup_session(self, file_storage):
        """Test cleaning up a session."""
        session_id = "test-session-cleanup"

        # Store some files
        await file_storage.store_file(
            session_id=session_id,
            filename="file1.txt",
            content=b"content1",
        )
        await file_storage.store_file(
            session_id=session_id,
            filename="file2.txt",
            content=b"content2",
        )

        # Verify directory exists
        session_dir = file_storage.temp_dir / session_id
        assert session_dir.exists()

        # Cleanup
        result = await file_storage.cleanup_session(session_id)

        assert result is True
        assert not session_dir.exists()

    @pytest.mark.asyncio
    async def test_list_output_files(self, file_storage):
        """Test listing output files."""
        session_id = "test-session-output"

        # Store some output files
        await file_storage.store_file(
            session_id=session_id,
            filename="output1.txt",
            content=b"output1",
            subdir="output",
        )
        await file_storage.store_file(
            session_id=session_id,
            filename="output2.txt",
            content=b"output2",
            subdir="output",
        )

        files = await file_storage.list_output_files(session_id)

        assert len(files) == 2
        filenames = [f["filename"] for f in files]
        assert "output1.txt" in filenames
        assert "output2.txt" in filenames
