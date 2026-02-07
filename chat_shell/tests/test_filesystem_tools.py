# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for filesystem builtin tools.

This module tests:
- ReadFileTool in local and remote modes
- WriteFileTool in local and remote modes
- ListFilesTool in local and remote modes
- ExecuteCommandTool in local and remote modes
- get_filesystem_tools factory function
"""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.tools.builtin.filesystem_tools import (
    BaseFilesystemTool,
    ExecuteCommandTool,
    ListFilesTool,
    ReadFileTool,
    WriteFileTool,
    get_filesystem_tools,
)


class TestGetFilesystemTools:
    """Tests for get_filesystem_tools factory function."""

    def test_returns_all_tools(self):
        """Test that factory returns all filesystem tools."""
        tools = get_filesystem_tools()

        assert len(tools) == 4
        tool_names = {t.name for t in tools}
        assert tool_names == {"read_file", "write_file", "list_files", "exec"}

    def test_configures_sandbox_mode(self):
        """Test that sandbox_mode is configured on all tools."""
        tools = get_filesystem_tools(sandbox_mode="local")

        for tool in tools:
            assert tool.sandbox_mode == "local"

    def test_configures_workspace_root(self):
        """Test that workspace_root is configured on all tools."""
        tools = get_filesystem_tools(workspace_root="/custom/path")

        for tool in tools:
            assert tool.workspace_root == "/custom/path"

    def test_configures_task_context(self):
        """Test that task context is configured on all tools."""
        tools = get_filesystem_tools(
            task_id=123,
            subtask_id=456,
            user_id=789,
            user_name="test_user",
        )

        for tool in tools:
            assert tool.task_id == 123
            assert tool.subtask_id == 456
            assert tool.user_id == 789
            assert tool.user_name == "test_user"


class TestReadFileTool:
    """Tests for ReadFileTool."""

    @pytest.fixture
    def local_tool(self):
        """Create a ReadFileTool in local mode."""
        return ReadFileTool(
            sandbox_mode="local",
            workspace_root="/tmp",
            task_id=1,
            user_id=1,
            user_name="test",
        )

    @pytest.mark.asyncio
    async def test_read_local_file(self, local_tool, tmp_path: Path):
        """Test reading a file in local mode."""
        # Arrange
        test_file = tmp_path / "test.txt"
        test_file.write_text("hello world")
        local_tool.workspace_root = str(tmp_path)

        # Act
        result = await local_tool._arun(file_path=str(test_file))

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["content"] == "hello world"
        assert result_data["size"] == 11

    @pytest.mark.asyncio
    async def test_read_local_file_not_found(self, local_tool, tmp_path: Path):
        """Test reading a nonexistent file in local mode."""
        # Arrange
        local_tool.workspace_root = str(tmp_path)

        # Act
        result = await local_tool._arun(file_path=str(tmp_path / "nonexistent.txt"))

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is False
        assert "not found" in result_data["error"].lower()

    @pytest.mark.asyncio
    async def test_read_local_binary_file(self, local_tool, tmp_path: Path):
        """Test reading a binary file in local mode."""
        # Arrange
        test_file = tmp_path / "test.bin"
        test_file.write_bytes(b"\x00\x01\x02")
        local_tool.workspace_root = str(tmp_path)

        # Act
        result = await local_tool._arun(file_path=str(test_file), format="bytes")

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["format"] == "bytes"
        # Should be base64 encoded
        import base64

        assert result_data["content"] == base64.b64encode(b"\x00\x01\x02").decode(
            "ascii"
        )

    @pytest.mark.asyncio
    async def test_read_remote_mode_calls_sandbox(self):
        """Test that remote mode calls sandbox manager."""
        # Arrange
        tool = ReadFileTool(
            sandbox_mode="remote",
            task_id=1,
            user_id=1,
            user_name="test",
        )

        # Mock sandbox manager and sandbox
        mock_sandbox = MagicMock()
        mock_sandbox.sandbox_id = "test-sandbox-id"
        mock_file_info = MagicMock()
        mock_file_info.size = 100
        mock_file_info.type = MagicMock()
        mock_file_info.type.value = "file"
        mock_file_info.modified_time = MagicMock()
        mock_file_info.modified_time.isoformat.return_value = "2025-01-01T00:00:00"
        mock_sandbox.files.get_info = AsyncMock(return_value=mock_file_info)
        mock_sandbox.files.read = AsyncMock(return_value="content")

        mock_manager = MagicMock()
        mock_manager.get_or_create_sandbox = AsyncMock(
            return_value=(mock_sandbox, None)
        )

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            # Act
            result = await tool._arun(file_path="/home/user/test.txt")

            # Assert
            result_data = json.loads(result)
            assert result_data["success"] is True
            assert result_data["sandbox_id"] == "test-sandbox-id"
            mock_manager.get_or_create_sandbox.assert_called_once()


class TestWriteFileTool:
    """Tests for WriteFileTool."""

    @pytest.fixture
    def local_tool(self):
        """Create a WriteFileTool in local mode."""
        return WriteFileTool(
            sandbox_mode="local",
            workspace_root="/tmp",
            task_id=1,
            user_id=1,
            user_name="test",
        )

    @pytest.mark.asyncio
    async def test_write_local_file(self, local_tool, tmp_path: Path):
        """Test writing a file in local mode."""
        # Arrange
        test_file = tmp_path / "output.txt"
        local_tool.workspace_root = str(tmp_path)

        # Act
        result = await local_tool._arun(file_path=str(test_file), content="hello world")

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert test_file.read_text() == "hello world"

    @pytest.mark.asyncio
    async def test_write_creates_directories(self, local_tool, tmp_path: Path):
        """Test that writing creates parent directories."""
        # Arrange
        test_file = tmp_path / "subdir" / "nested" / "file.txt"
        local_tool.workspace_root = str(tmp_path)

        # Act
        result = await local_tool._arun(
            file_path=str(test_file), content="content", create_dirs=True
        )

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert test_file.exists()

    @pytest.mark.asyncio
    async def test_write_empty_content_error(self, local_tool, tmp_path: Path):
        """Test that empty content returns error."""
        # Act
        result = await local_tool._arun(
            file_path=str(tmp_path / "file.txt"), content=""
        )

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is False
        assert "content" in result_data["error"].lower()


class TestListFilesTool:
    """Tests for ListFilesTool."""

    @pytest.fixture
    def local_tool(self):
        """Create a ListFilesTool in local mode."""
        return ListFilesTool(
            sandbox_mode="local",
            workspace_root="/tmp",
            task_id=1,
            user_id=1,
            user_name="test",
        )

    @pytest.mark.asyncio
    async def test_list_local_directory(self, local_tool, tmp_path: Path):
        """Test listing a directory in local mode."""
        # Arrange
        (tmp_path / "file1.txt").write_text("content1")
        (tmp_path / "file2.txt").write_text("content2")
        local_tool.workspace_root = str(tmp_path)

        # Act
        result = await local_tool._arun(path=str(tmp_path))

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["total"] == 2
        names = [e["name"] for e in result_data["entries"]]
        assert "file1.txt" in names
        assert "file2.txt" in names

    @pytest.mark.asyncio
    async def test_list_empty_directory(self, local_tool, tmp_path: Path):
        """Test listing an empty directory."""
        # Arrange
        local_tool.workspace_root = str(tmp_path)

        # Act
        result = await local_tool._arun(path=str(tmp_path))

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["total"] == 0

    @pytest.mark.asyncio
    async def test_list_nonexistent_directory(self, local_tool, tmp_path: Path):
        """Test listing a nonexistent directory."""
        # Act
        result = await local_tool._arun(path=str(tmp_path / "nonexistent"))

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is False
        assert "not found" in result_data["error"].lower()


class TestExecuteCommandTool:
    """Tests for ExecuteCommandTool."""

    @pytest.fixture
    def local_tool(self):
        """Create an ExecuteCommandTool in local mode."""
        return ExecuteCommandTool(
            sandbox_mode="local",
            workspace_root="/tmp",
            command_timeout=30,
            task_id=1,
            user_id=1,
            user_name="test",
        )

    @pytest.mark.asyncio
    async def test_execute_simple_command(self, local_tool):
        """Test executing a simple command in local mode."""
        # Act
        result = await local_tool._arun(command="echo hello")

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert "hello" in result_data["stdout"]
        assert result_data["exit_code"] == 0

    @pytest.mark.asyncio
    async def test_execute_command_failure(self, local_tool):
        """Test executing a failing command."""
        # Act
        result = await local_tool._arun(command="exit 1")

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is False
        assert result_data["exit_code"] == 1

    @pytest.mark.asyncio
    async def test_execute_with_working_dir(self, local_tool, tmp_path: Path):
        """Test executing with working directory."""
        # Act
        result = await local_tool._arun(command="pwd", working_dir=str(tmp_path))

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert str(tmp_path) in result_data["stdout"]

    @pytest.mark.asyncio
    async def test_execute_shell_operators(self, local_tool):
        """Test executing commands with shell operators."""
        # Act
        result = await local_tool._arun(command="echo hello && echo world")

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is True
        assert "hello" in result_data["stdout"]
        assert "world" in result_data["stdout"]

    @pytest.mark.asyncio
    async def test_execute_timeout(self, local_tool):
        """Test command timeout."""
        # Arrange
        local_tool.command_timeout = 1

        # Act
        result = await local_tool._arun(command="sleep 10", timeout_seconds=1)

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is False
        assert result_data.get("timed_out") is True or "timeout" in result_data.get(
            "error", ""
        ).lower()


class TestBaseFilesystemTool:
    """Tests for BaseFilesystemTool base class."""

    def test_format_error(self):
        """Test error formatting."""
        # Arrange
        tool = ReadFileTool(sandbox_mode="local", task_id=1, user_id=1, user_name="test")

        # Act
        result = tool._format_error("Test error", extra_field="extra_value")

        # Assert
        result_data = json.loads(result)
        assert result_data["success"] is False
        assert result_data["error"] == "Test error"
        assert result_data["extra_field"] == "extra_value"

    def test_sync_run_not_implemented(self):
        """Test that sync _run raises NotImplementedError."""
        # Arrange
        tool = ReadFileTool(sandbox_mode="local", task_id=1, user_id=1, user_name="test")

        # Act & Assert
        with pytest.raises(NotImplementedError):
            tool._run(file_path="/test.txt")
