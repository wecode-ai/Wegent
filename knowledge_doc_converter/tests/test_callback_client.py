"""Tests for callback_client module."""

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from knowledge_doc_converter.services.callback_client import CallbackClient


@pytest.fixture
def client():
    """Create a CallbackClient with test settings."""
    with patch(
        "knowledge_doc_converter.services.callback_client.settings"
    ) as mock_settings:
        mock_settings.BACKEND_BASE_URL = "http://backend:8000"
        mock_settings.BACKEND_INTERNAL_TOKEN = "test-token"
        return CallbackClient()


class TestCallbackClient:
    """Tests for CallbackClient methods."""

    def test_init_sets_base_url_and_headers(self, client):
        assert client.base_url == "http://backend:8000"
        assert client.headers["Authorization"] == "Bearer test-token"
        assert client.headers["Content-Type"] == "application/json"

    def test_notify_started(self, client):
        with patch.object(client, "call") as mock_call:
            mock_call.return_value = {"ok": True, "document_exists": True}
            result = client.notify_started(
                path="/internal/conversion/callback/status",
                document_id=1,
                generation=3,
            )
            mock_call.assert_called_once_with(
                "/internal/conversion/callback/status",
                {
                    "action": "conversion_started",
                    "document_id": 1,
                    "generation": 3,
                },
                callback_type="started",
            )
            assert result["ok"] is True
            assert result["document_exists"] is True

    def test_notify_failed(self, client):
        with patch.object(client, "call") as mock_call:
            mock_call.return_value = {"ok": True, "document_exists": True}
            result = client.notify_failed(
                path="/internal/conversion/callback/status",
                document_id=1,
                generation=3,
                error_message="test error",
            )
            mock_call.assert_called_once_with(
                "/internal/conversion/callback/status",
                {
                    "action": "conversion_failed",
                    "document_id": 1,
                    "generation": 3,
                    "error_message": "test error",
                },
                callback_type="failed",
            )

    def test_notify_completed(self, client):
        with patch.object(client, "call") as mock_call:
            mock_call.return_value = {
                "ok": True,
                "index_task_id": "task-123",
                "skipped": False,
            }
            result = client.notify_completed(
                path="/internal/conversion/callback/completed",
                document_id=1,
                generation=3,
                converted_name="report.pdf.md",
                converted_extension="md",
                file_size=100,
                markdown_bytes=b"# Hello",
                index_dispatch_payload={"knowledge_base_id": "kb-1"},
            )
            call_args = mock_call.call_args
            payload = call_args[0][1]
            assert payload["document_id"] == 1
            assert payload["converted_name"] == "report.pdf.md"
            assert payload["converted_extension"] == "md"
            assert payload["file_size"] == 100
            # Verify base64 encoding
            import base64

            assert payload["markdown_bytes"] == base64.b64encode(b"# Hello").decode()
            assert payload["index_dispatch_payload"] == {"knowledge_base_id": "kb-1"}

    def test_call_success(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"ok": True}

        with patch("httpx.post", return_value=mock_resp) as mock_post:
            result = client.call("/test/path", {"key": "value"})
            mock_post.assert_called_once_with(
                "http://backend:8000/test/path",
                json={"key": "value"},
                headers=client.headers,
                timeout=30,
            )
            assert result == {"ok": True}

    def test_call_retry_on_failure(self, client):
        """Verify exponential backoff retry on HTTP errors."""
        mock_resp_fail = MagicMock()
        mock_resp_fail.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Server Error", request=MagicMock(), response=MagicMock()
        )

        mock_resp_ok = MagicMock()
        mock_resp_ok.raise_for_status = MagicMock()
        mock_resp_ok.json.return_value = {"ok": True}

        with patch("httpx.post", side_effect=[mock_resp_fail, mock_resp_ok]):
            with patch("time.sleep"):  # Skip actual sleep
                result = client.call("/test/path", {}, max_retries=3)
                assert result == {"ok": True}

    def test_call_raises_after_max_retries(self, client):
        """Verify exception is raised after all retries are exhausted."""
        mock_resp_fail = MagicMock()
        mock_resp_fail.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Server Error", request=MagicMock(), response=MagicMock()
        )

        with patch("httpx.post", return_value=mock_resp_fail):
            with patch("time.sleep"):
                with pytest.raises(httpx.HTTPStatusError):
                    client.call("/test/path", {}, max_retries=2)
