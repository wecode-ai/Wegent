# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ContentFetcher service."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from knowledge_runtime.services.content_fetcher import (
    ContentFetcher,
    ContentFetchError,
)
from shared.models import (
    BackendAttachmentStreamContentRef,
    PresignedUrlContentRef,
)


@pytest.fixture
def content_fetcher():
    """Create a ContentFetcher instance with mocked settings."""
    with patch(
        "knowledge_runtime.services.content_fetcher.get_settings"
    ) as mock_settings:
        settings = MagicMock()
        settings.content_fetch_timeout = 120
        mock_settings.return_value = settings
        yield ContentFetcher()


class TestContentFetcher:
    """Tests for ContentFetcher."""

    @pytest.mark.asyncio
    async def test_fetch_from_presigned_url_success(self, content_fetcher) -> None:
        """Test successful fetch from presigned URL."""
        content_ref = PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/file.pdf?signature=xxx",
        )

        mock_response = MagicMock()
        mock_response.content = b"test content"
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            binary_data, source_file, file_extension = await content_fetcher.fetch(
                content_ref
            )

        assert binary_data == b"test content"
        assert source_file == "file.pdf"
        assert file_extension == ".pdf"

    @pytest.mark.asyncio
    async def test_fetch_from_backend_stream_success(self, content_fetcher) -> None:
        """Test successful fetch from Backend attachment stream."""
        content_ref = BackendAttachmentStreamContentRef(
            kind="backend_attachment_stream",
            url="http://localhost:8000/api/internal/attachments/123/stream",
            auth_token="test-token",
        )

        mock_response = MagicMock()
        mock_response.content = b"test content from backend"
        mock_response.headers = {
            "Content-Disposition": 'attachment; filename="report.docx"'
        }
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            binary_data, source_file, file_extension = await content_fetcher.fetch(
                content_ref
            )

        assert binary_data == b"test content from backend"
        assert source_file == "report.docx"
        assert file_extension == ".docx"

    @pytest.mark.asyncio
    async def test_fetch_http_error_4xx_not_retryable(self, content_fetcher) -> None:
        """Test that 4xx HTTP errors are not retryable."""
        content_ref = PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/file.pdf",
        )

        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Not Found", request=MagicMock(), response=mock_response
        )

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            with pytest.raises(ContentFetchError) as exc_info:
                await content_fetcher.fetch(content_ref)

        assert not exc_info.value.retryable

    @pytest.mark.asyncio
    async def test_fetch_http_error_5xx_retryable(self, content_fetcher) -> None:
        """Test that 5xx HTTP errors are retryable."""
        content_ref = PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/file.pdf",
        )

        mock_response = MagicMock()
        mock_response.status_code = 503
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Service Unavailable", request=MagicMock(), response=mock_response
        )

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            with pytest.raises(ContentFetchError) as exc_info:
                await content_fetcher.fetch(content_ref)

        assert exc_info.value.retryable

    @pytest.mark.asyncio
    async def test_fetch_transport_error_retryable(self, content_fetcher) -> None:
        """Test that transport errors are converted to retryable ContentFetchError."""
        content_ref = PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/file.pdf",
        )

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                side_effect=httpx.ConnectError("Connection failed")
            )

            # The retry decorator will retry 3 times, then raise ContentFetchError
            with pytest.raises(ContentFetchError) as exc_info:
                await content_fetcher.fetch(content_ref)

            assert exc_info.value.retryable

    def test_extract_filename_from_url(self, content_fetcher) -> None:
        """Test filename extraction from URL."""
        filename, ext = content_fetcher._extract_filename_from_url(
            "https://example.com/path/to/document.pdf?query=1"
        )
        assert filename == "document.pdf"
        assert ext == ".pdf"

    def test_extract_filename_from_url_no_extension(self, content_fetcher) -> None:
        """Test filename extraction when no extension."""
        filename, ext = content_fetcher._extract_filename_from_url(
            "https://example.com/path/to/document"
        )
        assert filename == "document"
        assert ext == ""

    def test_extract_filename_from_response_header(self, content_fetcher) -> None:
        """Test filename extraction from Content-Disposition header."""
        response = MagicMock()
        response.headers = {"Content-Disposition": 'attachment; filename="report.docx"'}

        filename, ext = content_fetcher._extract_filename_from_response(
            response, "https://example.com/file"
        )
        assert filename == "report.docx"
        assert ext == ".docx"

    @pytest.mark.asyncio
    async def test_fetch_from_presigned_url_encrypted_success(
        self, content_fetcher
    ) -> None:
        """Test successful fetch and decryption from presigned URL."""
        from shared.utils.crypto import encrypt_attachment

        original_content = b"test content to encrypt"
        encrypted_content = encrypt_attachment(original_content)

        content_ref = PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/file.pdf?signature=xxx",
            is_encrypted=True,
        )

        mock_response = MagicMock()
        mock_response.content = encrypted_content
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            binary_data, source_file, file_extension = await content_fetcher.fetch(
                content_ref
            )

        assert binary_data == original_content
        assert source_file == "file.pdf"
        assert file_extension == ".pdf"

    @pytest.mark.asyncio
    async def test_fetch_from_presigned_url_encrypted_decryption_failure(
        self, content_fetcher
    ) -> None:
        """Test that decryption failure raises ContentFetchError."""
        content_ref = PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/file.pdf",
            is_encrypted=True,
        )

        # Invalid encrypted data (not properly encrypted)
        mock_response = MagicMock()
        mock_response.content = b"invalid encrypted content that will fail decryption"
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            with pytest.raises(ContentFetchError) as exc_info:
                await content_fetcher.fetch(content_ref)

        assert "Failed to decrypt attachment" in str(exc_info.value)
        assert not exc_info.value.retryable

    @pytest.mark.asyncio
    async def test_fetch_from_presigned_url_not_encrypted(
        self, content_fetcher
    ) -> None:
        """Test that non-encrypted content is returned as-is."""
        content_ref = PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/file.pdf",
            is_encrypted=False,
        )

        mock_response = MagicMock()
        mock_response.content = b"plain text content"
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            binary_data, _, _ = await content_fetcher.fetch(content_ref)

        assert binary_data == b"plain text content"

    @pytest.mark.asyncio
    async def test_fetch_from_presigned_url_default_is_encrypted_false(
        self, content_fetcher
    ) -> None:
        """Test that is_encrypted defaults to False."""
        content_ref = PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/file.pdf",
        )

        mock_response = MagicMock()
        mock_response.content = b"content without encryption flag"
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            binary_data, _, _ = await content_fetcher.fetch(content_ref)

        # Should return content as-is (no decryption attempted)
        assert binary_data == b"content without encryption flag"
