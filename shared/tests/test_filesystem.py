# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for shared/utils/filesystem.py module."""

import asyncio
import os
import tempfile
from pathlib import Path

import pytest

from shared.utils.filesystem import (
    DEFAULT_COMMAND_TIMEOUT,
    DEFAULT_LIST_DEPTH,
    DEFAULT_MAX_FILE_SIZE,
    DEFAULT_MAX_OUTPUT_SIZE,
    execute_command,
    get_file_info,
    list_files,
    normalize_path,
    read_file,
    write_file,
)


class TestNormalizePath:
    """Tests for normalize_path function."""

    def test_absolute_path(self):
        """Test that absolute paths are returned as-is (after normalization)."""
        result = normalize_path("/tmp/test.txt")
        assert result == "/tmp/test.txt"

    def test_relative_path_with_base_dir(self):
        """Test that relative paths are joined with base_dir."""
        result = normalize_path("test.txt", base_dir="/tmp")
        assert result == "/tmp/test.txt"

    def test_relative_path_without_base_dir(self):
        """Test that relative paths are converted to absolute."""
        result = normalize_path("test.txt")
        assert os.path.isabs(result)

    def test_home_expansion(self):
        """Test that ~ is expanded to user home directory."""
        result = normalize_path("~/test.txt")
        assert not result.startswith("~")
        assert os.path.isabs(result)

    def test_path_normalization(self):
        """Test that paths with .. are normalized."""
        result = normalize_path("/tmp/foo/../bar/test.txt")
        assert result == "/tmp/bar/test.txt"


class TestGetFileInfo:
    """Tests for get_file_info function."""

    def test_file_info(self, tmp_path: Path):
        """Test getting info for a regular file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("hello world")

        info = get_file_info(str(test_file))

        assert info["name"] == "test.txt"
        assert info["type"] == "file"
        assert info["size"] == 11
        assert "permissions" in info
        assert "modified_time" in info
        assert info["is_symlink"] is False

    def test_directory_info(self, tmp_path: Path):
        """Test getting info for a directory."""
        test_dir = tmp_path / "subdir"
        test_dir.mkdir()

        info = get_file_info(str(test_dir))

        assert info["name"] == "subdir"
        assert info["type"] == "directory"
        assert info["is_symlink"] is False

    def test_symlink_info(self, tmp_path: Path):
        """Test getting info for a symbolic link."""
        target = tmp_path / "target.txt"
        target.write_text("content")
        link = tmp_path / "link.txt"
        link.symlink_to(target)

        info = get_file_info(str(link))

        assert info["name"] == "link.txt"
        assert info["type"] == "symlink"
        assert info["is_symlink"] is True
        assert info["symlink_target"] == str(target)

    def test_nonexistent_file(self, tmp_path: Path):
        """Test that FileNotFoundError is raised for nonexistent files."""
        with pytest.raises(FileNotFoundError):
            get_file_info(str(tmp_path / "nonexistent.txt"))


class TestReadFile:
    """Tests for read_file function."""

    @pytest.mark.asyncio
    async def test_read_text_file(self, tmp_path: Path):
        """Test reading a text file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("hello world")

        result = await read_file(str(test_file))

        assert result["success"] is True
        assert result["content"] == "hello world"
        assert result["size"] == 11
        assert result["format"] == "text"
        assert "modified_time" in result

    @pytest.mark.asyncio
    async def test_read_binary_file(self, tmp_path: Path):
        """Test reading a binary file as base64."""
        test_file = tmp_path / "test.bin"
        test_file.write_bytes(b"\x00\x01\x02\x03")

        result = await read_file(str(test_file), format="bytes")

        assert result["success"] is True
        assert result["format"] == "bytes"
        # Base64 of b"\x00\x01\x02\x03"
        import base64

        expected = base64.b64encode(b"\x00\x01\x02\x03").decode("ascii")
        assert result["content"] == expected

    @pytest.mark.asyncio
    async def test_read_nonexistent_file(self, tmp_path: Path):
        """Test reading a nonexistent file."""
        result = await read_file(str(tmp_path / "nonexistent.txt"))

        assert result["success"] is False
        assert "not found" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_read_directory(self, tmp_path: Path):
        """Test reading a directory returns error."""
        result = await read_file(str(tmp_path))

        assert result["success"] is False
        assert "directory" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_read_file_too_large(self, tmp_path: Path):
        """Test reading a file that exceeds max_size."""
        test_file = tmp_path / "large.txt"
        test_file.write_text("x" * 1000)

        result = await read_file(str(test_file), max_size=100)

        assert result["success"] is False
        assert "too large" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_read_with_base_dir(self, tmp_path: Path):
        """Test reading with relative path and base_dir."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("content")

        result = await read_file("test.txt", base_dir=str(tmp_path))

        assert result["success"] is True
        assert result["content"] == "content"


class TestWriteFile:
    """Tests for write_file function."""

    @pytest.mark.asyncio
    async def test_write_text_file(self, tmp_path: Path):
        """Test writing a text file."""
        test_file = tmp_path / "output.txt"

        result = await write_file(str(test_file), "hello world")

        assert result["success"] is True
        assert result["size"] == 11
        assert result["format"] == "text"
        assert test_file.read_text() == "hello world"

    @pytest.mark.asyncio
    async def test_write_binary_file(self, tmp_path: Path):
        """Test writing a binary file from base64."""
        test_file = tmp_path / "output.bin"
        import base64

        content = base64.b64encode(b"\x00\x01\x02\x03").decode("ascii")

        result = await write_file(str(test_file), content, format="bytes")

        assert result["success"] is True
        assert result["format"] == "bytes"
        assert test_file.read_bytes() == b"\x00\x01\x02\x03"

    @pytest.mark.asyncio
    async def test_write_creates_directories(self, tmp_path: Path):
        """Test that write_file creates parent directories."""
        test_file = tmp_path / "subdir" / "nested" / "file.txt"

        result = await write_file(str(test_file), "content", create_dirs=True)

        assert result["success"] is True
        assert test_file.exists()
        assert test_file.read_text() == "content"

    @pytest.mark.asyncio
    async def test_write_none_content(self, tmp_path: Path):
        """Test writing None content returns error."""
        test_file = tmp_path / "output.txt"

        result = await write_file(str(test_file), None)

        assert result["success"] is False
        assert "cannot be None" in result["error"]

    @pytest.mark.asyncio
    async def test_write_invalid_base64(self, tmp_path: Path):
        """Test writing invalid base64 content returns error."""
        test_file = tmp_path / "output.bin"

        result = await write_file(str(test_file), "not-valid-base64!!!", format="bytes")

        assert result["success"] is False
        assert "base64" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_write_overwrites_existing(self, tmp_path: Path):
        """Test that write_file overwrites existing files."""
        test_file = tmp_path / "output.txt"
        test_file.write_text("old content")

        result = await write_file(str(test_file), "new content")

        assert result["success"] is True
        assert test_file.read_text() == "new content"


class TestListFiles:
    """Tests for list_files function."""

    @pytest.mark.asyncio
    async def test_list_empty_directory(self, tmp_path: Path):
        """Test listing an empty directory."""
        result = await list_files(str(tmp_path))

        assert result["success"] is True
        assert result["entries"] == []
        assert result["total"] == 0

    @pytest.mark.asyncio
    async def test_list_directory_with_files(self, tmp_path: Path):
        """Test listing a directory with files."""
        (tmp_path / "file1.txt").write_text("content1")
        (tmp_path / "file2.txt").write_text("content2")

        result = await list_files(str(tmp_path))

        assert result["success"] is True
        assert result["total"] == 2
        names = [e["name"] for e in result["entries"]]
        assert "file1.txt" in names
        assert "file2.txt" in names

    @pytest.mark.asyncio
    async def test_list_with_subdirectories(self, tmp_path: Path):
        """Test listing a directory with subdirectories."""
        (tmp_path / "subdir").mkdir()
        (tmp_path / "file.txt").write_text("content")

        result = await list_files(str(tmp_path))

        assert result["success"] is True
        assert result["total"] == 2
        types = {e["name"]: e["type"] for e in result["entries"]}
        assert types["subdir"] == "directory"
        assert types["file.txt"] == "file"

    @pytest.mark.asyncio
    async def test_list_recursive(self, tmp_path: Path):
        """Test listing with depth > 1."""
        subdir = tmp_path / "subdir"
        subdir.mkdir()
        (subdir / "nested.txt").write_text("content")
        (tmp_path / "root.txt").write_text("content")

        result = await list_files(str(tmp_path), depth=2)

        assert result["success"] is True
        names = [e["name"] for e in result["entries"]]
        assert "subdir" in names
        assert "root.txt" in names
        assert "nested.txt" in names

    @pytest.mark.asyncio
    async def test_list_nonexistent_directory(self, tmp_path: Path):
        """Test listing a nonexistent directory."""
        result = await list_files(str(tmp_path / "nonexistent"))

        assert result["success"] is False
        assert "not found" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_list_file_not_directory(self, tmp_path: Path):
        """Test listing a file (not a directory) returns error."""
        test_file = tmp_path / "file.txt"
        test_file.write_text("content")

        result = await list_files(str(test_file))

        assert result["success"] is False
        assert "not a directory" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_list_with_pattern(self, tmp_path: Path):
        """Test listing with pattern filter."""
        (tmp_path / "file1.txt").write_text("content")
        (tmp_path / "file2.py").write_text("content")
        (tmp_path / "file3.txt").write_text("content")

        result = await list_files(str(tmp_path), pattern="*.txt")

        assert result["success"] is True
        assert result["total"] == 2
        names = [e["name"] for e in result["entries"]]
        assert "file1.txt" in names
        assert "file3.txt" in names
        assert "file2.py" not in names


class TestExecuteCommand:
    """Tests for execute_command function."""

    @pytest.mark.asyncio
    async def test_execute_simple_command(self):
        """Test executing a simple command."""
        result = await execute_command("echo hello")

        assert result["success"] is True
        assert "hello" in result["stdout"]
        assert result["exit_code"] == 0
        assert "execution_time" in result

    @pytest.mark.asyncio
    async def test_execute_command_with_error(self):
        """Test executing a command that fails."""
        result = await execute_command("exit 1")

        assert result["success"] is False
        assert result["exit_code"] == 1

    @pytest.mark.asyncio
    async def test_execute_command_with_stderr(self):
        """Test executing a command that writes to stderr."""
        result = await execute_command("echo error >&2")

        assert "error" in result["stderr"]

    @pytest.mark.asyncio
    async def test_execute_command_with_cwd(self, tmp_path: Path):
        """Test executing a command with working directory."""
        result = await execute_command("pwd", cwd=str(tmp_path))

        assert result["success"] is True
        assert str(tmp_path) in result["stdout"]

    @pytest.mark.asyncio
    async def test_execute_command_timeout(self):
        """Test that command times out."""
        result = await execute_command("sleep 10", timeout=1)

        assert result["success"] is False
        assert result.get("timed_out") is True
        assert "timeout" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_execute_command_with_shell_operators(self):
        """Test executing commands with shell operators."""
        result = await execute_command("echo hello && echo world")

        assert result["success"] is True
        assert "hello" in result["stdout"]
        assert "world" in result["stdout"]

    @pytest.mark.asyncio
    async def test_execute_command_with_pipe(self):
        """Test executing commands with pipe."""
        result = await execute_command("echo 'hello world' | grep hello")

        assert result["success"] is True
        assert "hello" in result["stdout"]

    @pytest.mark.asyncio
    async def test_execute_command_output_truncation(self):
        """Test that large output is truncated."""
        # Generate output larger than default max
        result = await execute_command(
            "python3 -c \"print('x' * 100000)\"", max_output_size=1000
        )

        assert result["success"] is True
        assert len(result["stdout"]) <= 1000
        assert result.get("truncated") is True

    @pytest.mark.asyncio
    async def test_execute_nonexistent_command(self):
        """Test executing a nonexistent command."""
        result = await execute_command("nonexistent_command_12345")

        assert result["success"] is False
        assert result["exit_code"] != 0


class TestConstants:
    """Tests for module constants."""

    def test_default_constants(self):
        """Test that default constants have reasonable values."""
        assert DEFAULT_MAX_FILE_SIZE == 102400  # 100KB
        assert DEFAULT_MAX_OUTPUT_SIZE == 65536  # 64KB
        assert DEFAULT_COMMAND_TIMEOUT == 300  # 5 minutes
        assert DEFAULT_LIST_DEPTH == 1
