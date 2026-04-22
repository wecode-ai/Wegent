# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Content fetching service for resolving ContentRef references."""

from __future__ import annotations

import logging
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from knowledge_runtime.config import get_settings
from shared.models import (
    BackendAttachmentStreamContentRef,
    ContentRef,
    PresignedUrlContentRef,
)

logger = logging.getLogger(__name__)


class ContentFetchError(Exception):
    """Raised when content fetching fails."""

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.details = details or {}


class ContentFetcher:
    """Fetches binary content from ContentRef references.

    Supports two content reference types:
    - PresignedUrlContentRef: Direct HTTP GET to object storage URL
    - BackendAttachmentStreamContentRef: HTTP GET with Bearer token to Backend
    """

    def __init__(self) -> None:
        self._settings = get_settings()

    @retry(
        retry=retry_if_exception(lambda e: getattr(e, "retryable", False)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    async def fetch(
        self,
        content_ref: ContentRef,
    ) -> tuple[bytes, str, str]:
        """Fetch binary content from a ContentRef.

        Args:
            content_ref: The content reference to fetch.

        Returns:
            Tuple of (binary_data, source_file, file_extension).

        Raises:
            ContentFetchError: If fetching fails.
        """
        if isinstance(content_ref, PresignedUrlContentRef):
            return await self._fetch_from_presigned_url(content_ref)
        elif isinstance(content_ref, BackendAttachmentStreamContentRef):
            return await self._fetch_from_backend_stream(content_ref)
        else:
            raise ContentFetchError(
                f"Unsupported content ref type: {type(content_ref).__name__}",
                retryable=False,
            )

    async def _fetch_from_presigned_url(
        self,
        content_ref: PresignedUrlContentRef,
    ) -> tuple[bytes, str, str]:
        """Fetch content directly from a presigned URL.

        Args:
            content_ref: Presigned URL content reference.

        Returns:
            Tuple of (binary_data, source_file, file_extension).
        """
        url = content_ref.url
        logger.debug(f"Fetching content from presigned URL: {url[:100]}...")

        try:
            async with httpx.AsyncClient(
                timeout=self._settings.content_fetch_timeout
            ) as client:
                response = await client.get(url)
                response.raise_for_status()

                # Extract filename and extension from URL if possible
                source_file, file_extension = self._extract_filename_from_url(url)

                return response.content, source_file, file_extension

        except httpx.HTTPStatusError as exc:
            logger.error(f"HTTP error fetching from presigned URL: {exc}")
            raise ContentFetchError(
                f"Failed to fetch content: HTTP {exc.response.status_code}",
                retryable=exc.response.status_code >= 500,
                details={"url": url[:100], "status_code": exc.response.status_code},
            ) from exc
        except httpx.TransportError as exc:
            logger.error(f"Transport error fetching from presigned URL: {exc}")
            raise ContentFetchError(
                f"Transport error fetching content: {exc}",
                retryable=True,
                details={"url": url[:100]},
            ) from exc

    async def _fetch_from_backend_stream(
        self,
        content_ref: BackendAttachmentStreamContentRef,
    ) -> tuple[bytes, str, str]:
        """Fetch content through Backend attachment stream endpoint.

        Args:
            content_ref: Backend attachment stream content reference.

        Returns:
            Tuple of (binary_data, source_file, file_extension).
        """
        url = content_ref.url
        auth_token = content_ref.auth_token

        logger.debug(f"Fetching content from Backend stream: {url}")

        try:
            headers = {"Authorization": f"Bearer {auth_token}"}

            async with httpx.AsyncClient(
                timeout=self._settings.content_fetch_timeout
            ) as client:
                response = await client.get(url, headers=headers)
                response.raise_for_status()

                # Try to get filename from Content-Disposition header
                source_file, file_extension = self._extract_filename_from_response(
                    response, url
                )

                return response.content, source_file, file_extension

        except httpx.HTTPStatusError as exc:
            logger.error(f"HTTP error fetching from Backend stream: {exc}")
            raise ContentFetchError(
                f"Failed to fetch content from Backend: HTTP {exc.response.status_code}",
                retryable=exc.response.status_code >= 500,
                details={"url": url, "status_code": exc.response.status_code},
            ) from exc
        except httpx.TransportError as exc:
            logger.error(f"Transport error fetching from Backend stream: {exc}")
            raise ContentFetchError(
                f"Transport error fetching content from Backend: {exc}",
                retryable=True,
                details={"url": url},
            ) from exc

    def _extract_filename_from_url(self, url: str) -> tuple[str, str]:
        """Extract filename and extension from URL path.

        Args:
            url: The URL to extract from.

        Returns:
            Tuple of (filename, extension).
        """
        # Try to get the last path segment
        path = url.split("?")[0]  # Remove query params
        parts = path.rstrip("/").split("/")
        filename = parts[-1] if parts else "unknown"

        # Extract extension
        if "." in filename:
            extension = "." + filename.rsplit(".", 1)[-1]
        else:
            extension = ""

        return filename, extension

    def _extract_filename_from_response(
        self,
        response: httpx.Response,
        url: str,
    ) -> tuple[str, str]:
        """Extract filename from response headers or URL.

        Args:
            response: HTTP response.
            url: Original URL.

        Returns:
            Tuple of (filename, extension).
        """
        # Try Content-Disposition header first
        content_disposition = response.headers.get("Content-Disposition", "")
        if "filename=" in content_disposition:
            # Parse filename from Content-Disposition
            parts = content_disposition.split("filename=")
            if len(parts) > 1:
                filename = parts[1].strip('"').strip("'")
                if "." in filename:
                    extension = "." + filename.rsplit(".", 1)[-1]
                else:
                    extension = ""
                return filename, extension

        # Fall back to URL extraction
        return self._extract_filename_from_url(url)
