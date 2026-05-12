"""HTTP client for fetching document binary content from backend.

The converter no longer has direct DB access. Instead, it downloads
attachment binary data via the backend's internal download endpoint.
"""

import logging

import httpx

from knowledge_doc_converter.config import settings
from knowledge_doc_converter.core.metrics import (
    record_callback_failed,
    record_callback_success,
)

logger = logging.getLogger(__name__)


class ContentFetcher:
    """Fetch document binary content from backend via HTTP."""

    def __init__(self):
        self.base_url = settings.BACKEND_BASE_URL.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
        }

    def download(self, path: str) -> bytes:
        """Download binary content from backend.

        Args:
            path: API path (e.g., "/api/internal/attachments/42/download").

        Returns:
            Raw binary data of the attachment.

        Raises:
            httpx.HTTPStatusError: If the backend returns a non-2xx status.
        """
        url = f"{self.base_url}{path}"
        try:
            with httpx.stream("GET", url, headers=self.headers, timeout=120) as resp:
                resp.raise_for_status()
                chunks = []
                for chunk in resp.iter_bytes(chunk_size=65536):
                    chunks.append(chunk)
                data = b"".join(chunks)
            record_callback_success("download")
            logger.info(f"Downloaded {len(data)} bytes from {path}")
            return data
        except Exception:
            record_callback_failed("download")
            raise


content_fetcher = ContentFetcher()
