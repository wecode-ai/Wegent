# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Artifact upload service for DuckDB files.

Uploads generated .duckdb files to Backend's internal artifact endpoint,
returning the attachment ID of the newly created artifact.
"""

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

logger = logging.getLogger(__name__)


class ArtifactUploadError(Exception):
    """Raised when artifact upload fails."""

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


class ArtifactUploader:
    """Uploads .duckdb artifact files to Backend internal endpoint.

    Uses the Backend's internal artifact upload endpoint to store
    generated DuckDB files, returning the attachment ID for future
    reference by query and schema operations.
    """

    def __init__(self) -> None:
        self._settings = get_settings()

    @retry(
        retry=retry_if_exception(lambda e: getattr(e, "retryable", False)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    async def upload(
        self,
        duckdb_bytes: bytes,
        filename: str,
        source_attachment_id: int,
    ) -> int:
        """Upload .duckdb to Backend POST /api/internal/data/artifacts/upload.

        Args:
            duckdb_bytes: Binary content of the DuckDB file.
            filename: Filename for the uploaded artifact.
            source_attachment_id: Original attachment ID this was generated from.

        Returns:
            The duckdb_attachment_id of the new attachment.

        Raises:
            ArtifactUploadError: If the upload fails.
        """
        url = (
            f"{self._settings.backend_internal_url}"
            f"/api/internal/data/artifacts/upload"
        )

        logger.info(
            "Uploading DuckDB artifact: filename=%s, source_attachment_id=%d, "
            "size=%.1f KB",
            filename,
            source_attachment_id,
            len(duckdb_bytes) / 1024,
        )

        try:
            headers = {}
            if self._settings.internal_service_token:
                headers["Authorization"] = (
                    f"Bearer {self._settings.internal_service_token}"
                )

            async with httpx.AsyncClient(
                timeout=self._settings.content_fetch_timeout
            ) as client:
                # Send as multipart form upload
                files = {
                    "file": (filename, duckdb_bytes, "application/octet-stream"),
                }
                data = {
                    "source_attachment_id": str(source_attachment_id),
                }

                response = await client.post(
                    url,
                    headers=headers,
                    files=files,
                    data=data,
                )
                response.raise_for_status()

                result = response.json()
                attachment_id = result.get("attachment_id")

                if attachment_id is None:
                    raise ArtifactUploadError(
                        f"Backend did not return attachment_id in response: {result}",
                        retryable=False,
                    )

                logger.info(
                    "DuckDB artifact uploaded successfully: " "duckdb_attachment_id=%d",
                    attachment_id,
                )

                return int(attachment_id)

        except httpx.HTTPStatusError as exc:
            logger.error(
                "HTTP error uploading artifact: %d - %s",
                exc.response.status_code,
                exc.response.text[:200],
            )
            raise ArtifactUploadError(
                f"Failed to upload artifact: HTTP {exc.response.status_code}",
                retryable=(
                    exc.response.status_code >= 500
                    or exc.response.status_code in (408, 429)
                ),
                details={
                    "status_code": exc.response.status_code,
                    "url": url,
                },
            ) from exc
        except httpx.TransportError as exc:
            logger.error("Transport error uploading artifact: %s", exc)
            raise ArtifactUploadError(
                f"Transport error uploading artifact: {exc}",
                retryable=True,
                details={"url": url},
            ) from exc
        except ArtifactUploadError:
            raise
        except Exception as exc:
            logger.error("Unexpected error uploading artifact: %s", exc)
            raise ArtifactUploadError(
                f"Failed to upload artifact: {exc}",
                retryable=False,
            ) from exc
