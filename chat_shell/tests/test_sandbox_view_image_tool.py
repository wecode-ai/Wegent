# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for SandboxViewImageTool (sandbox skill)."""

import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Setup: skill modules are not on the default PYTHONPATH and use a relative
# import for their _base module.  We register the chat_shell _base module
# under the name the skill expects, then load the skill module via
# importlib so its relative-import fallback resolves correctly.
# ---------------------------------------------------------------------------
from chat_shell.tools.sandbox._base import BaseSandboxTool

sys.modules["backend.init_data.skills.sandbox._base"] = sys.modules[
    "chat_shell.tools.sandbox._base"
]

import importlib.util

_skill_dir = Path(__file__).parents[2] / "backend" / "init_data" / "skills" / "sandbox"
_view_image_spec = importlib.util.spec_from_file_location(
    "backend.init_data.skills.sandbox.view_image_tool",
    str(_skill_dir / "view_image_tool.py"),
)
_view_image_module = importlib.util.module_from_spec(_view_image_spec)
sys.modules[_view_image_spec.name] = _view_image_module
_view_image_spec.loader.exec_module(_view_image_module)

SandboxViewImageTool = _view_image_module.SandboxViewImageTool


class TestSandboxViewImageTool:
    @pytest.fixture
    def tool(self):
        return SandboxViewImageTool(
            task_id=42,
            user_id=1,
            user_name="test_user",
            ws_emitter=None,
        )

    def _mock_sandbox(
        self, file_exists=True, file_type="file", content=b"\x89PNG fake"
    ):
        """Return mocked sandbox manager and sandbox instances."""
        mock_manager = MagicMock()
        mock_sandbox = MagicMock()

        mock_file_info = SimpleNamespace(
            type=SimpleNamespace(value=file_type) if file_type else None,
            size=len(content),
        )
        mock_sandbox.files.get_info = AsyncMock(return_value=mock_file_info)
        mock_sandbox.files.read = AsyncMock(return_value=content)
        mock_sandbox.sandbox_id = "sandbox-123"

        mock_manager.get_or_create_sandbox = AsyncMock(
            return_value=(mock_sandbox, None)
        )

        return mock_manager, mock_sandbox

    @pytest.mark.asyncio
    async def test_returns_image_list_for_png(self, tool):
        mock_manager, _ = self._mock_sandbox(content=b"\x89PNG fake data")

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            result = await tool._arun(path="/home/user/test.png")

        assert isinstance(result, list)
        assert result[0]["type"] == "image_url"
        expected_b64 = base64.b64encode(b"\x89PNG fake data").decode()
        assert f"data:image/png;base64,{expected_b64}" == result[0]["image_url"]["url"]

    @pytest.mark.asyncio
    async def test_returns_image_list_for_jpg(self, tool):
        mock_manager, _ = self._mock_sandbox(content=b"fake jpeg")

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            result = await tool._arun(path="/home/user/photo.jpg")

        assert isinstance(result, list)
        assert result[0]["type"] == "image_url"
        assert "image/jpeg" in result[0]["image_url"]["url"]

    @pytest.mark.asyncio
    async def test_returns_error_for_text_file(self, tool):
        mock_manager, _ = self._mock_sandbox(content=b"hello world")

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            result = await tool._arun(path="/home/user/readme.txt")

        parsed = json.loads(result)
        assert "error" in parsed
        assert "not an image" in parsed["error"].lower()

    @pytest.mark.asyncio
    async def test_returns_error_for_binary_non_image(self, tool):
        mock_manager, _ = self._mock_sandbox(content=b"%PDF binary content")

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            result = await tool._arun(path="/home/user/doc.pdf")

        parsed = json.loads(result)
        assert "error" in parsed
        assert "not an image" in parsed["error"].lower()

    @pytest.mark.asyncio
    async def test_returns_error_when_file_not_found(self, tool):
        mock_manager = MagicMock()
        mock_sandbox = MagicMock()
        mock_sandbox.files.get_info = AsyncMock(side_effect=Exception("not found"))
        mock_manager.get_or_create_sandbox = AsyncMock(
            return_value=(mock_sandbox, None)
        )

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            result = await tool._arun(path="/home/user/missing.png")

        parsed = json.loads(result)
        assert "error" in parsed
        assert "not found" in parsed["error"].lower()

    @pytest.mark.asyncio
    async def test_returns_error_when_path_is_directory(self, tool):
        mock_manager, _ = self._mock_sandbox(file_type="directory")

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            result = await tool._arun(path="/home/user/mydir")

        parsed = json.loads(result)
        assert "error" in parsed
        assert "directory" in parsed["error"].lower()

    @pytest.mark.asyncio
    async def test_normalizes_relative_path(self, tool):
        mock_manager, mock_sandbox = self._mock_sandbox(content=b"\x89PNG fake")

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            result = await tool._arun(path="chart.png")

        assert isinstance(result, list)
        mock_sandbox.files.get_info.assert_awaited_once_with("/home/user/chart.png")
        mock_sandbox.files.read.assert_awaited_once_with(
            "/home/user/chart.png", format="bytes"
        )

    @pytest.mark.asyncio
    async def test_emits_tool_status_on_success(self, tool):
        mock_emitter = AsyncMock()
        tool.ws_emitter = mock_emitter
        mock_manager, _ = self._mock_sandbox(content=b"\x89PNG fake")

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            await tool._arun(path="/home/user/test.png")

        assert mock_emitter.emit_tool_call.await_count >= 2
        # First call is "running", last is "completed"
        first_call = mock_emitter.emit_tool_call.await_args_list[0]
        assert first_call.kwargs["status"] == "running"
        last_call = mock_emitter.emit_tool_call.await_args_list[-1]
        assert last_call.kwargs["status"] == "completed"

    @pytest.mark.asyncio
    async def test_emits_tool_status_on_failure(self, tool):
        mock_emitter = AsyncMock()
        tool.ws_emitter = mock_emitter
        mock_manager, _ = self._mock_sandbox(content=b"hello world")

        with patch.object(tool, "_get_sandbox_manager", return_value=mock_manager):
            await tool._arun(path="/home/user/readme.txt")

        # Should emit running and then failed
        statuses = [
            call.kwargs["status"]
            for call in mock_emitter.emit_tool_call.await_args_list
        ]
        assert "running" in statuses
        assert "failed" in statuses

    def test_tool_metadata(self, tool):
        assert tool.name == "view_sandbox_image_file"
        assert tool.task_id == 42
        assert tool.user_id == 1
        assert tool.user_name == "test_user"
