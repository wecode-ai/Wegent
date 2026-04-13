# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the WebFetchTool."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from chat_shell.tools.builtin.web_fetch import (
    MAX_TEXT_PREVIEW,
    WebFetchTool,
    _is_text_content_type,
)


class TestIsTextContentType:
    """Tests for _is_text_content_type helper."""

    def test_text_html(self):
        assert _is_text_content_type("text/html; charset=utf-8") is True

    def test_text_plain(self):
        assert _is_text_content_type("text/plain") is True

    def test_application_json(self):
        assert _is_text_content_type("application/json") is True

    def test_application_xml(self):
        assert _is_text_content_type("application/xml") is True

    def test_application_pdf(self):
        assert _is_text_content_type("application/pdf") is False

    def test_image_png(self):
        assert _is_text_content_type("image/png") is False

    def test_octet_stream(self):
        assert _is_text_content_type("application/octet-stream") is False


class TestWebFetchTool:
    """Tests for WebFetchTool."""

    def setup_method(self):
        self.tool = WebFetchTool()

    def test_tool_name(self):
        assert self.tool.name == "web_fetch"

    def test_unsupported_method(self):
        result = json.loads(self.tool._run_sync("https://example.com", method="DELETE"))
        assert "error" in result
        assert "Only GET and POST" in result["error"]

    @patch("chat_shell.tools.builtin.web_fetch.httpx.Client")
    def test_successful_text_response(self, mock_client_cls):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "text/html; charset=utf-8"}
        mock_response.text = "<html><body>Hello</body></html>"
        mock_response.content = b"<html><body>Hello</body></html>"

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_client_cls.return_value = mock_client

        result = json.loads(
            self.tool._run_sync("https://example.com", headers={"X-Test": "value"})
        )

        assert result["status_code"] == 200
        assert "content" in result
        assert "Hello" in result["content"]
        assert result["truncated"] is False

    @patch("chat_shell.tools.builtin.web_fetch.httpx.Client")
    def test_successful_json_response(self, mock_client_cls):
        body = json.dumps({"data": "test"})
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.text = body
        mock_response.content = body.encode()

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_client_cls.return_value = mock_client

        result = json.loads(self.tool._run_sync("https://api.example.com/data"))

        assert result["status_code"] == 200
        assert "content" in result
        assert '"data"' in result["content"]

    @patch("chat_shell.tools.builtin.web_fetch.httpx.Client")
    def test_binary_response_base64(self, mock_client_cls):
        binary_content = b"\x89PNG\r\n\x1a\n\x00"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "image/png"}
        mock_response.content = binary_content

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_client_cls.return_value = mock_client

        result = json.loads(self.tool._run_sync("https://example.com/image.png"))

        assert result["status_code"] == 200
        assert "content_base64" in result
        assert result["encoding"] == "base64"
        assert result["content_type"] == "image/png"

    @patch("chat_shell.tools.builtin.web_fetch.httpx.Client")
    def test_http_error_response(self, mock_client_cls):
        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_response.headers = {"content-type": "text/html"}
        mock_response.text = "Not Found"
        mock_response.content = b"Not Found"

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_client_cls.return_value = mock_client

        result = json.loads(self.tool._run_sync("https://example.com/missing"))

        assert result["status_code"] == 404
        assert "error" in result
        assert "HTTP 404" in result["error"]

    @patch("chat_shell.tools.builtin.web_fetch.httpx.Client")
    def test_timeout_error(self, mock_client_cls):
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.side_effect = httpx.TimeoutException("Connection timed out")
        mock_client_cls.return_value = mock_client

        result = json.loads(self.tool._run_sync("https://slow.example.com", timeout=5))

        assert "error" in result
        assert "timed out" in result["error"]

    @patch("chat_shell.tools.builtin.web_fetch.httpx.Client")
    def test_post_request(self, mock_client_cls):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.text = '{"result": "ok"}'
        mock_response.content = b'{"result": "ok"}'

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.post.return_value = mock_response
        mock_client_cls.return_value = mock_client

        result = json.loads(
            self.tool._run_sync(
                "https://api.example.com/submit",
                method="POST",
                body='{"key": "value"}',
            )
        )

        assert result["status_code"] == 200
        mock_client.post.assert_called_once()

    @patch("chat_shell.tools.builtin.web_fetch.httpx.Client")
    def test_custom_headers_passed(self, mock_client_cls):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.text = "{}"
        mock_response.content = b"{}"

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_client_cls.return_value = mock_client

        custom_headers = {
            "Authorization": "Bearer token123",
            "X-Custom-Header": "value",
        }
        self.tool._run_sync("https://api.example.com", headers=custom_headers)

        mock_client.get.assert_called_once_with(
            "https://api.example.com", headers=custom_headers
        )

    @patch("chat_shell.tools.builtin.web_fetch.httpx.Client")
    def test_truncated_large_text(self, mock_client_cls):
        large_text = "x" * (MAX_TEXT_PREVIEW + 1000)
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "text/plain"}
        mock_response.text = large_text
        mock_response.content = large_text.encode()

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response
        mock_client_cls.return_value = mock_client

        result = json.loads(self.tool._run_sync("https://example.com/large"))

        assert result["truncated"] is True
        assert len(result["content"]) == MAX_TEXT_PREVIEW


class TestWebFetchToolAsync:
    """Tests for async WebFetchTool methods."""

    def setup_method(self):
        self.tool = WebFetchTool()

    @pytest.mark.asyncio
    async def test_async_text_response(self):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "text/plain"}
        mock_response.text = "Hello async"
        mock_response.content = b"Hello async"

        with patch("chat_shell.tools.builtin.web_fetch.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_cls.return_value = mock_client

            result = json.loads(await self.tool._arun("https://example.com"))

            assert result["status_code"] == 200
            assert result["content"] == "Hello async"

    @pytest.mark.asyncio
    async def test_async_unsupported_method(self):
        result = json.loads(await self.tool._arun("https://example.com", method="PUT"))
        assert "error" in result

    @pytest.mark.asyncio
    async def test_async_timeout(self):
        with patch("chat_shell.tools.builtin.web_fetch.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timed out"))
            mock_cls.return_value = mock_client

            result = json.loads(await self.tool._arun("https://slow.example.com"))

            assert "error" in result
            assert "timed out" in result["error"]
