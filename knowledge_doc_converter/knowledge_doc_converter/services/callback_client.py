"""HTTP callback client for notifying backend of conversion status changes.

Implements exponential backoff retry (3 attempts: 2s, 4s, 8s) for
resilience against transient backend failures.
"""

import base64
import logging
import time
from typing import Optional

import httpx

from knowledge_doc_converter.config import settings
from knowledge_doc_converter.core.metrics import (
    record_callback_failed,
    record_callback_success,
)

logger = logging.getLogger(__name__)


class CallbackClient:
    """HTTP client for calling backend conversion callback APIs."""

    def __init__(self):
        self.base_url = settings.BACKEND_BASE_URL.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
            "Content-Type": "application/json",
        }

    def call(
        self, path: str, payload: dict, max_retries: int = 3, callback_type: str = ""
    ) -> dict:
        """Call backend callback endpoint with exponential backoff retry.

        Args:
            path: API path (e.g., "/api/internal/conversion/callback/status").
            payload: JSON request body.
            max_retries: Maximum number of attempts.
            callback_type: Callback type for metrics ("started", "completed", "failed").

        Returns:
            Parsed JSON response from backend.

        Raises:
            httpx.HTTPError: If all retries are exhausted.
        """
        url = f"{self.base_url}{path}"
        delay = 2
        for attempt in range(max_retries):
            try:
                resp = httpx.post(url, json=payload, headers=self.headers, timeout=30)
                resp.raise_for_status()
                if callback_type:
                    record_callback_success(callback_type)
                return resp.json()
            except httpx.HTTPError as e:
                logger.warning(
                    f"Callback failed (attempt {attempt + 1}/{max_retries}): "
                    f"url={url}, error={e}"
                )
                if attempt == max_retries - 1:
                    if callback_type:
                        record_callback_failed(callback_type)
                    raise
                time.sleep(delay)
                delay *= 2
        return {}  # unreachable, but satisfies type checker

    def notify_started(self, path: str, document_id: int, generation: int) -> dict:
        """Notify backend that conversion has started.

        Args:
            path: Callback status path.
            document_id: Document ID.
            generation: Current index generation.

        Returns:
            Backend response with {"ok": bool, "document_exists": bool}.
        """
        return self.call(
            path,
            {
                "action": "conversion_started",
                "document_id": document_id,
                "generation": generation,
            },
            callback_type="started",
        )

    def notify_completed(
        self,
        path: str,
        document_id: int,
        generation: int,
        converted_name: str,
        converted_extension: str,
        file_size: int,
        markdown_bytes: bytes,
        index_dispatch_payload: dict,
    ) -> dict:
        """Notify backend that conversion has completed.

        Args:
            path: Callback completed path.
            document_id: Document ID.
            generation: Current index generation.
            converted_name: Converted file name (e.g., "report.md").
            converted_extension: Converted file extension (e.g., "md").
            file_size: Markdown file size in bytes.
            markdown_bytes: Raw markdown content (will be base64-encoded).
            index_dispatch_payload: Pass-through payload for index dispatch.

        Returns:
            Backend response with {"ok": bool, "index_task_id": str, "skipped": bool}.
        """
        return self.call(
            path,
            {
                "document_id": document_id,
                "generation": generation,
                "converted_name": converted_name,
                "converted_extension": converted_extension,
                "file_size": file_size,
                "markdown_bytes": base64.b64encode(markdown_bytes).decode(),
                "index_dispatch_payload": index_dispatch_payload,
            },
            callback_type="completed",
        )

    def notify_failed(
        self,
        path: str,
        document_id: int,
        generation: int,
        error_message: str,
    ) -> dict:
        """Notify backend that conversion has failed.

        Args:
            path: Callback status path.
            document_id: Document ID.
            generation: Current index generation.
            error_message: Error description.

        Returns:
            Backend response with {"ok": bool, "document_exists": bool}.
        """
        return self.call(
            path,
            {
                "action": "conversion_failed",
                "document_id": document_id,
                "generation": generation,
                "error_message": error_message,
            },
            callback_type="failed",
        )


callback_client = CallbackClient()
