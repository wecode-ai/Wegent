"""Tests for content_fetcher module."""

from unittest.mock import MagicMock, patch

import httpx
import pytest

from knowledge_doc_converter.services.content_fetcher import ContentFetcher


@pytest.fixture
def fetcher():
    """Create a ContentFetcher with test settings."""
    with patch(
        "knowledge_doc_converter.services.content_fetcher.settings"
    ) as mock_settings:
        mock_settings.BACKEND_BASE_URL = "http://backend:8000"
        mock_settings.BACKEND_INTERNAL_TOKEN = "test-token"
        return ContentFetcher()


class TestContentFetcher:
    """Tests for ContentFetcher."""

    def test_init_sets_base_url_and_headers(self, fetcher):
        assert fetcher.base_url == "http://backend:8000"
        assert fetcher.headers["Authorization"] == "Bearer test-token"

    def test_download_success(self, fetcher):
        """Test successful binary download."""
        test_data = b"PDF-1.4 binary content..."

        mock_iter_bytes = MagicMock()
        mock_iter_bytes.iter_bytes.return_value = iter([test_data[:10], test_data[10:]])
        mock_iter_bytes.__enter__ = MagicMock(return_value=mock_iter_bytes)
        mock_iter_bytes.__exit__ = MagicMock(return_value=False)
        mock_iter_bytes.raise_for_status = MagicMock()

        with patch("httpx.stream", return_value=mock_iter_bytes):
            result = fetcher.download("/internal/attachments/42/download")

        assert result == test_data

    def test_download_raises_on_404(self, fetcher):
        """Test HTTPStatusError raised on 404."""
        mock_iter_bytes = MagicMock()
        mock_iter_bytes.__enter__ = MagicMock(return_value=mock_iter_bytes)
        mock_iter_bytes.__exit__ = MagicMock(return_value=False)
        mock_iter_bytes.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Not Found", request=MagicMock(), response=MagicMock(status_code=404)
        )

        with patch("httpx.stream", return_value=mock_iter_bytes):
            with pytest.raises(httpx.HTTPStatusError):
                fetcher.download("/internal/attachments/999/download")
