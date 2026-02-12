# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
HTTP Callback result emitter.

Emits execution events via HTTP POST to a callback URL.
"""

import logging
from typing import Optional

import httpx

from shared.models import EventType, ExecutionEvent

from .base import BaseResultEmitter

logger = logging.getLogger(__name__)


class CallbackResultEmitter(BaseResultEmitter):
    """HTTP Callback result emitter.

    Pushes events to specified callback URL via HTTP POST.
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        callback_url: str,
        timeout: float = 30.0,
        headers: Optional[dict] = None,
    ):
        """Initialize the callback emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            callback_url: URL to POST events to
            timeout: HTTP request timeout in seconds
            headers: Optional HTTP headers
        """
        super().__init__(task_id, subtask_id)
        self.callback_url = callback_url
        self.timeout = timeout
        self.headers = headers or {}
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client.

        Returns:
            httpx.AsyncClient instance
        """
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit event via HTTP POST.

        Args:
            event: Execution event to emit
        """
        if self._closed:
            logger.warning("[CallbackResultEmitter] Emitter closed, dropping event")
            return

        client = await self._get_client()

        try:
            response = await client.post(
                self.callback_url,
                json=event.to_dict(),
                headers=self.headers,
            )

            if response.status_code != 200:
                logger.warning(
                    f"[CallbackResultEmitter] Callback failed: "
                    f"status={response.status_code}, url={self.callback_url}"
                )
        except Exception as e:
            logger.error(f"[CallbackResultEmitter] Callback error: {e}")

    async def close(self) -> None:
        """Close emitter and HTTP client."""
        await super().close()
        if self._client:
            await self._client.aclose()
            self._client = None


class BatchCallbackEmitter(CallbackResultEmitter):
    """Batch HTTP Callback emitter.

    Buffers events and sends them in batches to reduce HTTP requests.
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        callback_url: str,
        batch_size: int = 10,
        flush_interval: float = 1.0,
        **kwargs,
    ):
        """Initialize the batch callback emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            callback_url: URL to POST events to
            batch_size: Number of events to buffer before sending
            flush_interval: Time interval for flushing buffer (not implemented yet)
            **kwargs: Additional arguments for CallbackResultEmitter
        """
        super().__init__(task_id, subtask_id, callback_url, **kwargs)
        self.batch_size = batch_size
        self.flush_interval = flush_interval
        self._buffer: list[ExecutionEvent] = []
        self._last_flush = 0.0

    async def emit(self, event: ExecutionEvent) -> None:
        """Buffer event, send batch when threshold reached.

        Args:
            event: Execution event to emit
        """
        self._buffer.append(event)

        # Terminal events flush immediately
        if event.type in (
            EventType.DONE.value,
            EventType.ERROR.value,
            EventType.CANCELLED.value,
        ):
            await self._flush()
            return

        # Flush when batch size reached
        if len(self._buffer) >= self.batch_size:
            await self._flush()

    async def _flush(self) -> None:
        """Flush buffer, send all events."""
        if not self._buffer:
            return

        client = await self._get_client()
        events_to_send = self._buffer
        self._buffer = []

        try:
            # Use batch endpoint
            batch_url = self.callback_url.rstrip("/") + "/batch"
            response = await client.post(
                batch_url,
                json=[e.to_dict() for e in events_to_send],
                headers=self.headers,
            )

            if response.status_code != 200:
                logger.warning(
                    f"[BatchCallbackEmitter] Batch callback failed: "
                    f"status={response.status_code}"
                )
        except Exception as e:
            logger.error(f"[BatchCallbackEmitter] Batch callback error: {e}")

    async def close(self) -> None:
        """Flush remaining events before closing."""
        await self._flush()
        await super().close()
