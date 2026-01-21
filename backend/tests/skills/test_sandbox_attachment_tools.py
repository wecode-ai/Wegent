# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for sandbox attachment upload/download tools.

This module tests the SandboxUploadAttachmentTool and SandboxDownloadAttachmentTool classes.
"""

import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add the skill directory to path for importing
SKILL_DIR = Path(__file__).parent.parent.parent / "init_data" / "skills" / "sandbox"
sys.path.insert(0, str(SKILL_DIR))


class MockFileInfo:
    """Mock file info for testing."""

    def __init__(self, size: int = 1024):
        self.size = size


class MockCommandResult:
    """Mock command result for testing."""

    def __init__(self, exit_code: int = 0, stdout: str = "", stderr: str = ""):
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr


class MockSandbox:
    """Mock sandbox for testing."""

    def __init__(self, sandbox_id: str = "test-sandbox"):
        self.sandbox_id = sandbox_id
        self.files = MagicMock()
        self.commands = MagicMock()


class MockSandboxManager:
    """Mock sandbox manager for testing."""

    def __init__(self, sandbox: MockSandbox = None, error: str = None):
        self._sandbox = sandbox or MockSandbox()
        self._error = error

    async def get_or_create_sandbox(self, **kwargs):
        return self._sandbox, self._error


class TestSandboxUploadAttachmentTool:
    """Tests for SandboxUploadAttachmentTool."""

    @pytest.fixture
    def mock_ws_emitter(self):
        """Create mock WebSocket emitter."""
        emitter = MagicMock()
        emitter.emit_tool_call = AsyncMock()
        return emitter

    @pytest.fixture
    def mock_sandbox_manager(self):
        """Create mock sandbox manager with success scenario."""
        sandbox = MockSandbox()
        sandbox.files.get_info = AsyncMock(return_value=MockFileInfo(size=1024))
        sandbox.commands.run = AsyncMock(
            return_value=MockCommandResult(
                exit_code=0,
                stdout=json.dumps(
                    {
                        "id": 123,
                        "filename": "test.pdf",
                        "file_size": 1024,
                        "mime_type": "application/pdf",
                    }
                ),
            )
        )
        return MockSandboxManager(sandbox=sandbox)

    @pytest.mark.asyncio
    async def test_upload_success(self, mock_ws_emitter, mock_sandbox_manager):
        """Test successful file upload."""
        # Import the tool with mocked dependencies
        with patch.dict(
            "sys.modules",
            {
                "langchain_core.callbacks": MagicMock(),
                "langchain_core.tools": MagicMock(),
                "pydantic": MagicMock(),
            },
        ):
            from upload_attachment_tool import (
                MAX_UPLOAD_SIZE,
                SandboxUploadAttachmentTool,
            )

            # Create tool with mocked dependencies
            tool = SandboxUploadAttachmentTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                user_name="test_user",
                ws_emitter=mock_ws_emitter,
                bot_config=[],
                default_shell_type="ClaudeCode",
                timeout=7200,
                auth_token="test_token",
                api_base_url="http://test-backend:8000",
            )

            # Mock the sandbox manager
            tool._get_sandbox_manager = MagicMock(return_value=mock_sandbox_manager)

            # Execute
            result = await tool._arun(file_path="/home/user/test.pdf")

            # Parse result
            result_dict = json.loads(result)

            # Verify success
            assert result_dict["success"] is True
            assert result_dict["attachment_id"] == 123
            assert result_dict["filename"] == "test.pdf"
            assert result_dict["download_url"] == "/api/attachments/123/download"

    @pytest.mark.asyncio
    async def test_upload_file_not_found(self, mock_ws_emitter):
        """Test upload when file doesn't exist."""
        # Create sandbox that raises exception for file not found
        sandbox = MockSandbox()
        sandbox.files.get_info = AsyncMock(side_effect=Exception("File not found"))
        sandbox_manager = MockSandboxManager(sandbox=sandbox)

        with patch.dict(
            "sys.modules",
            {
                "langchain_core.callbacks": MagicMock(),
                "langchain_core.tools": MagicMock(),
                "pydantic": MagicMock(),
            },
        ):
            from upload_attachment_tool import SandboxUploadAttachmentTool

            tool = SandboxUploadAttachmentTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                user_name="test_user",
                ws_emitter=mock_ws_emitter,
                bot_config=[],
                default_shell_type="ClaudeCode",
                timeout=7200,
                auth_token="test_token",
                api_base_url="http://test-backend:8000",
            )
            tool._get_sandbox_manager = MagicMock(return_value=sandbox_manager)

            result = await tool._arun(file_path="/home/user/nonexistent.pdf")
            result_dict = json.loads(result)

            assert result_dict["success"] is False
            assert "File not found" in result_dict["error"]

    @pytest.mark.asyncio
    async def test_upload_file_too_large(self, mock_ws_emitter):
        """Test upload when file exceeds size limit."""
        # Create sandbox with large file
        sandbox = MockSandbox()
        sandbox.files.get_info = AsyncMock(
            return_value=MockFileInfo(size=200 * 1024 * 1024)
        )  # 200MB
        sandbox_manager = MockSandboxManager(sandbox=sandbox)

        with patch.dict(
            "sys.modules",
            {
                "langchain_core.callbacks": MagicMock(),
                "langchain_core.tools": MagicMock(),
                "pydantic": MagicMock(),
            },
        ):
            from upload_attachment_tool import SandboxUploadAttachmentTool

            tool = SandboxUploadAttachmentTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                user_name="test_user",
                ws_emitter=mock_ws_emitter,
                bot_config=[],
                default_shell_type="ClaudeCode",
                timeout=7200,
                auth_token="test_token",
                api_base_url="http://test-backend:8000",
            )
            tool._get_sandbox_manager = MagicMock(return_value=sandbox_manager)

            result = await tool._arun(file_path="/home/user/large_file.pdf")
            result_dict = json.loads(result)

            assert result_dict["success"] is False
            assert "too large" in result_dict["error"].lower()

    @pytest.mark.asyncio
    async def test_upload_no_auth_token(self, mock_ws_emitter, mock_sandbox_manager):
        """Test upload when auth token is missing."""
        with patch.dict(
            "sys.modules",
            {
                "langchain_core.callbacks": MagicMock(),
                "langchain_core.tools": MagicMock(),
                "pydantic": MagicMock(),
            },
        ):
            from upload_attachment_tool import SandboxUploadAttachmentTool

            tool = SandboxUploadAttachmentTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                user_name="test_user",
                ws_emitter=mock_ws_emitter,
                bot_config=[],
                default_shell_type="ClaudeCode",
                timeout=7200,
                auth_token="",  # Empty token
                api_base_url="http://test-backend:8000",
            )
            tool._get_sandbox_manager = MagicMock(return_value=mock_sandbox_manager)

            result = await tool._arun(file_path="/home/user/test.pdf")
            result_dict = json.loads(result)

            assert result_dict["success"] is False
            assert "authentication token" in result_dict["error"].lower()


class TestSandboxDownloadAttachmentTool:
    """Tests for SandboxDownloadAttachmentTool."""

    @pytest.fixture
    def mock_ws_emitter(self):
        """Create mock WebSocket emitter."""
        emitter = MagicMock()
        emitter.emit_tool_call = AsyncMock()
        return emitter

    @pytest.fixture
    def mock_sandbox_manager(self):
        """Create mock sandbox manager with success scenario."""
        sandbox = MockSandbox()
        sandbox.files.make_dir = AsyncMock()
        sandbox.files.get_info = AsyncMock(return_value=MockFileInfo(size=1024))
        sandbox.commands.run = AsyncMock(
            return_value=MockCommandResult(exit_code=0, stdout="", stderr="")
        )
        return MockSandboxManager(sandbox=sandbox)

    @pytest.mark.asyncio
    async def test_download_success(self, mock_ws_emitter, mock_sandbox_manager):
        """Test successful file download."""
        with patch.dict(
            "sys.modules",
            {
                "langchain_core.callbacks": MagicMock(),
                "langchain_core.tools": MagicMock(),
                "pydantic": MagicMock(),
            },
        ):
            from download_attachment_tool import SandboxDownloadAttachmentTool

            tool = SandboxDownloadAttachmentTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                user_name="test_user",
                ws_emitter=mock_ws_emitter,
                bot_config=[],
                default_shell_type="ClaudeCode",
                timeout=7200,
                auth_token="test_token",
                api_base_url="http://test-backend:8000",
            )
            tool._get_sandbox_manager = MagicMock(return_value=mock_sandbox_manager)

            result = await tool._arun(
                attachment_url="/api/attachments/123/download",
                save_path="/home/user/downloads/test.pdf",
            )
            result_dict = json.loads(result)

            assert result_dict["success"] is True
            assert result_dict["file_path"] == "/home/user/downloads/test.pdf"
            assert result_dict["file_size"] == 1024

    @pytest.mark.asyncio
    async def test_download_no_auth_token(self, mock_ws_emitter, mock_sandbox_manager):
        """Test download when auth token is missing."""
        with patch.dict(
            "sys.modules",
            {
                "langchain_core.callbacks": MagicMock(),
                "langchain_core.tools": MagicMock(),
                "pydantic": MagicMock(),
            },
        ):
            from download_attachment_tool import SandboxDownloadAttachmentTool

            tool = SandboxDownloadAttachmentTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                user_name="test_user",
                ws_emitter=mock_ws_emitter,
                bot_config=[],
                default_shell_type="ClaudeCode",
                timeout=7200,
                auth_token="",  # Empty token
                api_base_url="http://test-backend:8000",
            )
            tool._get_sandbox_manager = MagicMock(return_value=mock_sandbox_manager)

            result = await tool._arun(
                attachment_url="/api/attachments/123/download",
                save_path="/home/user/downloads/test.pdf",
            )
            result_dict = json.loads(result)

            assert result_dict["success"] is False
            assert "authentication token" in result_dict["error"].lower()

    @pytest.mark.asyncio
    async def test_download_curl_failure(self, mock_ws_emitter):
        """Test download when curl command fails."""
        sandbox = MockSandbox()
        sandbox.files.make_dir = AsyncMock()
        sandbox.commands.run = AsyncMock(
            return_value=MockCommandResult(
                exit_code=22, stdout="", stderr="curl: (22) HTTP error"
            )
        )
        sandbox_manager = MockSandboxManager(sandbox=sandbox)

        with patch.dict(
            "sys.modules",
            {
                "langchain_core.callbacks": MagicMock(),
                "langchain_core.tools": MagicMock(),
                "pydantic": MagicMock(),
            },
        ):
            from download_attachment_tool import SandboxDownloadAttachmentTool

            tool = SandboxDownloadAttachmentTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                user_name="test_user",
                ws_emitter=mock_ws_emitter,
                bot_config=[],
                default_shell_type="ClaudeCode",
                timeout=7200,
                auth_token="test_token",
                api_base_url="http://test-backend:8000",
            )
            tool._get_sandbox_manager = MagicMock(return_value=sandbox_manager)

            result = await tool._arun(
                attachment_url="/api/attachments/123/download",
                save_path="/home/user/downloads/test.pdf",
            )
            result_dict = json.loads(result)

            assert result_dict["success"] is False
            assert "failed" in result_dict["error"].lower()


class TestSandboxToolProvider:
    """Tests for SandboxToolProvider with attachment tools."""

    def test_supported_tools_includes_attachment_tools(self):
        """Test that provider supports attachment tools."""
        with patch.dict(
            "sys.modules",
            {
                "chat_shell.skills": MagicMock(),
                "langchain_core.tools": MagicMock(),
            },
        ):
            from provider import SandboxToolProvider

            provider = SandboxToolProvider()

            assert "sandbox_upload_attachment" in provider.supported_tools
            assert "sandbox_download_attachment" in provider.supported_tools

    def test_create_upload_attachment_tool(self):
        """Test creating upload attachment tool."""
        with patch.dict(
            "sys.modules",
            {
                "chat_shell.skills": MagicMock(),
                "langchain_core.tools": MagicMock(),
            },
        ):
            # Create mock context
            mock_context = MagicMock()
            mock_context.task_id = 1
            mock_context.subtask_id = 1
            mock_context.user_id = 1
            mock_context.user_name = "test_user"
            mock_context.ws_emitter = None

            from provider import SandboxToolProvider

            provider = SandboxToolProvider()

            tool = provider.create_tool(
                tool_name="sandbox_upload_attachment",
                context=mock_context,
                tool_config={
                    "auth_token": "test_token",
                    "api_base_url": "http://test:8000",
                },
            )

            assert tool.name == "sandbox_upload_attachment"
            assert tool.auth_token == "test_token"

    def test_create_download_attachment_tool(self):
        """Test creating download attachment tool."""
        with patch.dict(
            "sys.modules",
            {
                "chat_shell.skills": MagicMock(),
                "langchain_core.tools": MagicMock(),
            },
        ):
            mock_context = MagicMock()
            mock_context.task_id = 1
            mock_context.subtask_id = 1
            mock_context.user_id = 1
            mock_context.user_name = "test_user"
            mock_context.ws_emitter = None

            from provider import SandboxToolProvider

            provider = SandboxToolProvider()

            tool = provider.create_tool(
                tool_name="sandbox_download_attachment",
                context=mock_context,
                tool_config={
                    "auth_token": "test_token",
                    "api_base_url": "http://test:8000",
                },
            )

            assert tool.name == "sandbox_download_attachment"
            assert tool.auth_token == "test_token"
