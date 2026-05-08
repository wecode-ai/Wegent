# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for SandboxImageViewerTool and image serialization helpers."""

import base64
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.agents.graph_builder import _strip_image_data_for_storage
from chat_shell.tools.builtin.sandbox_image_viewer import (
    IMAGE_MIME_TYPES,
    SandboxImageViewerTool,
)


class TestStripImageDataForStorage:
    def test_replaces_image_url_blocks_with_placeholder(self):
        blocks = [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ]
        result = _strip_image_data_for_storage(blocks)
        assert result == [{"type": "text", "text": "[image content - not stored]"}]

    def test_preserves_non_image_blocks(self):
        blocks = [
            {"type": "text", "text": "hello"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            {"type": "text", "text": "world"},
        ]
        result = _strip_image_data_for_storage(blocks)
        assert result[0] == {"type": "text", "text": "hello"}
        assert result[1] == {"type": "text", "text": "[image content - not stored]"}
        assert result[2] == {"type": "text", "text": "world"}

    def test_empty_list(self):
        assert _strip_image_data_for_storage([]) == []

    def test_non_dict_items_pass_through(self):
        blocks = ["plain_string", {"type": "text", "text": "ok"}]
        result = _strip_image_data_for_storage(blocks)
        assert result == blocks


class TestSandboxImageViewerTool:
    def _make_tool(self, task_id=42):
        return SandboxImageViewerTool(
            task_id=task_id,
            executor_manager_url="http://exec-mgr:8001",
            auth_token="tok123",
        )

    @pytest.mark.asyncio
    async def test_returns_image_list_for_png(self):
        tool = self._make_tool()
        image_bytes = b"\x89PNG fake data"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "image/png"}
        mock_response.content = image_bytes
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__ = AsyncMock(
                return_value=mock_client
            )
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_client.get = AsyncMock(return_value=mock_response)

            result = await tool._arun(path="/home/user/test.png")

        assert isinstance(result, list)
        assert result[0]["type"] == "image_url"
        expected_b64 = base64.b64encode(image_bytes).decode()
        assert f"data:image/png;base64,{expected_b64}" == result[0]["image_url"]["url"]

    @pytest.mark.asyncio
    async def test_infers_mime_type_from_extension(self):
        tool = self._make_tool()
        image_bytes = b"fake jpeg"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/octet-stream"}
        mock_response.content = image_bytes
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__ = AsyncMock(
                return_value=mock_client
            )
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_client.get = AsyncMock(return_value=mock_response)

            result = await tool._arun(path="/home/user/photo.jpg")

        assert isinstance(result, list)
        assert result[0]["type"] == "image_url"
        assert "image/jpeg" in result[0]["image_url"]["url"]

    @pytest.mark.asyncio
    async def test_returns_error_for_text_file(self):
        tool = self._make_tool()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "text/plain"}
        mock_response.content = b"hello world"
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__ = AsyncMock(
                return_value=mock_client
            )
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_client.get = AsyncMock(return_value=mock_response)

            result = await tool._arun(path="/home/user/readme.txt")

        parsed = json.loads(result)
        assert "error" in parsed
        assert "not an image" in parsed["error"].lower()

    @pytest.mark.asyncio
    async def test_returns_error_for_binary_non_image(self):
        tool = self._make_tool()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/pdf"}
        mock_response.content = b"%PDF binary content"
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__ = AsyncMock(
                return_value=mock_client
            )
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_client.get = AsyncMock(return_value=mock_response)

            result = await tool._arun(path="/home/user/doc.pdf")

        parsed = json.loads(result)
        assert "error" in parsed
        assert "not an image" in parsed["error"].lower()

    @pytest.mark.asyncio
    async def test_returns_error_json_on_404(self):
        tool = self._make_tool()
        mock_response = MagicMock()
        mock_response.status_code = 404

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__ = AsyncMock(
                return_value=mock_client
            )
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_client.get = AsyncMock(return_value=mock_response)

            result = await tool._arun(path="/home/user/missing.png")

        parsed = json.loads(result)
        assert "error" in parsed
        assert "not found" in parsed["error"].lower()

    def test_tool_metadata(self):
        tool = self._make_tool()
        assert tool.name == "view_sandbox_image_file"
        assert tool.task_id == 42
        assert tool.executor_manager_url == "http://exec-mgr:8001"
        assert tool.auth_token == "tok123"

    def test_all_common_image_types_recognized(self):
        for mime in ["image/jpeg", "image/png", "image/gif", "image/webp"]:
            assert mime in IMAGE_MIME_TYPES
