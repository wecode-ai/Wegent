# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ExposeServiceTool."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from chat_shell.tools.builtin.expose_service import ExposeServiceTool


class TestExposeServiceTool:
    """Test cases for ExposeServiceTool."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = ExposeServiceTool(task_id=123)

    def test_tool_attributes(self):
        """Test tool has correct attributes."""
        assert self.tool.name == "expose_service"
        assert self.tool.task_id == 123
        assert "expose_service" in self.tool.name
        assert self.tool.display_name == "发布服务信息"

    def test_sync_run_raises_not_implemented(self):
        """Test that sync _run raises NotImplementedError."""
        with pytest.raises(NotImplementedError):
            self.tool._run()

    @pytest.mark.asyncio
    async def test_arun_without_task_id(self):
        """Test _arun returns error when task_id is not configured."""
        tool = ExposeServiceTool(task_id=0)
        result = await tool._arun(name="Test App")

        result_data = json.loads(result)
        assert "error" in result_data
        assert "Task ID not configured" in result_data["error"]

    @pytest.mark.asyncio
    async def test_arun_without_any_fields(self):
        """Test _arun returns error when no fields are provided."""
        result = await self.tool._arun()

        result_data = json.loads(result)
        assert "error" in result_data
        assert "At least one service field" in result_data["error"]

    @pytest.mark.asyncio
    async def test_arun_success(self):
        """Test _arun successfully updates service."""
        mock_response = {"success": True, "app": {"name": "Test App"}}

        with patch.object(
            self.tool, "_update_service_via_backend", new_callable=AsyncMock
        ) as mock_update:
            mock_update.return_value = mock_response

            result = await self.tool._arun(name="Test App")

            result_data = json.loads(result)
            assert result_data["success"] is True
            assert "Test App" in result_data["message"]
            mock_update.assert_called_once_with(
                name="Test App",
                host=None,
                previewUrl=None,
                mysql=None,
            )

    @pytest.mark.asyncio
    async def test_arun_with_all_fields(self):
        """Test _arun with all fields provided."""
        mock_response = {
            "success": True,
            "app": {
                "name": "My App",
                "host": "localhost",
                "previewUrl": "https://example.com",
                "mysql": "mysql://user:pass@localhost/db",
            },
        }

        with patch.object(
            self.tool, "_update_service_via_backend", new_callable=AsyncMock
        ) as mock_update:
            mock_update.return_value = mock_response

            result = await self.tool._arun(
                name="My App",
                host="localhost",
                previewUrl="https://example.com",
                mysql="mysql://user:pass@localhost/db",
            )

            result_data = json.loads(result)
            assert result_data["success"] is True
            assert "My App" in result_data["message"]
            assert "localhost" in result_data["message"]
            assert "previewUrl" in result_data["message"]
            # mysql should be masked
            assert "connection string saved" in result_data["message"]

    @pytest.mark.asyncio
    async def test_arun_backend_error(self):
        """Test _arun handles backend errors gracefully."""
        mock_response = {"success": False, "error": "Task not found"}

        with patch.object(
            self.tool, "_update_service_via_backend", new_callable=AsyncMock
        ) as mock_update:
            mock_update.return_value = mock_response

            result = await self.tool._arun(name="Test App")

            result_data = json.loads(result)
            assert result_data.get("success") is False
            assert "error" in result_data

    @pytest.mark.asyncio
    async def test_arun_exception_handling(self):
        """Test _arun handles exceptions gracefully."""
        with patch.object(
            self.tool, "_update_service_via_backend", new_callable=AsyncMock
        ) as mock_update:
            mock_update.side_effect = Exception("Connection failed")

            result = await self.tool._arun(name="Test App")

            result_data = json.loads(result)
            assert "error" in result_data
            assert "Connection failed" in result_data["error"]
