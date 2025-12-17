# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base LLM Provider interface.

Defines the abstract interface for all LLM providers with streaming
and tool calling support.
"""

import asyncio
import json
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncGenerator

import httpx

logger = logging.getLogger(__name__)


class ChunkType(Enum):
    """Type of streaming chunk."""

    CONTENT = "content"
    TOOL_CALL = "tool_call_chunk"
    ERROR = "error"
    DONE = "done"


@dataclass
class StreamChunk:
    """Unified streaming chunk representation."""

    type: ChunkType
    content: str = ""
    tool_call: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class ProviderConfig:
    """Configuration for LLM provider."""

    api_key: str
    base_url: str
    model_id: str
    default_headers: dict[str, Any] = field(default_factory=dict)
    timeout: float = 300.0
    max_tokens: int = 4096


def parse_json_safe(data: Any, context: str = "") -> dict[str, Any]:
    """
    Safely parse JSON data.

    Args:
        data: Data to parse (dict or string)
        context: Context for logging

    Returns:
        Parsed dictionary or empty dict on failure
    """
    if isinstance(data, dict):
        return data
    if isinstance(data, str):
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            if context:
                logger.warning("Failed to parse JSON for %s", context)
            return {}
    return {}


def parse_base64_image(image_url: str) -> tuple[str, str] | None:
    """
    Parse base64 image URL into media type and data.

    Args:
        image_url: Data URL (e.g., "data:image/png;base64,...")

    Returns:
        tuple of (media_type, base64_data) or None if invalid
    """
    if not image_url.startswith("data:"):
        return None

    parts = image_url.split(",", 1)
    if len(parts) != 2:
        return None

    header, base64_data = parts
    # Extract media type from "data:image/png;base64"
    try:
        media_type = header.split(":")[1].split(";")[0]
        return media_type, base64_data
    except (IndexError, ValueError):
        return None


def extract_image_url(block: dict) -> str:
    """
    Extract image URL from OpenAI-format image block.

    Args:
        block: Image block dict with 'image_url' key

    Returns:
        The image URL string
    """
    image_url_data = block.get("image_url", {})
    return (
        image_url_data.get("url", "")
        if isinstance(image_url_data, dict)
        else image_url_data
    )


class LLMProvider(ABC):
    """
    Abstract base class for LLM providers.

    Defines the interface for streaming chat completions with
    optional tool calling support.
    """

    def __init__(self, config: ProviderConfig, client: httpx.AsyncClient):
        self.config = config
        self.client = client

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Return the provider name (e.g., 'openai', 'claude', 'gemini')."""
        pass

    @abstractmethod
    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        cancel_event: asyncio.Event,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """Stream chat completion from the LLM."""
        pass

    @abstractmethod
    def format_messages(self, messages: list[dict[str, Any]]) -> Any:
        """Format messages for this provider's API."""
        pass

    @abstractmethod
    def format_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Format tools for this provider's API."""
        pass

    def _build_headers(self) -> dict[str, str]:
        """Build HTTP headers for API requests."""
        headers = {"Content-Type": "application/json"}
        if self.config.default_headers:
            headers.update(self.config.default_headers)
        return headers

    async def _check_cancellation(self, cancel_event: asyncio.Event) -> bool:
        """Check if cancellation has been requested."""
        return cancel_event.is_set()

    async def _stream_sse(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
        cancel_event: asyncio.Event,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """
        Stream SSE responses from API.

        Common SSE parsing logic shared by all providers.

        Args:
            url: API endpoint URL
            payload: Request payload
            headers: Request headers
            cancel_event: Cancellation event

        Yields:
            Parsed JSON data from SSE events
        """
        start_time = time.time()
        chunk_count = 0

        try:
            async with self.client.stream(
                "POST", url, json=payload, headers=headers
            ) as response:
                if response.status_code >= 400:
                    error_body = await response.aread()
                    error_msg = error_body.decode("utf-8", errors="replace")
                    logger.error(
                        "%s API error: status=%s, body=%s",
                        self.provider_name,
                        response.status_code,
                        error_msg,
                    )
                    yield {"_error": error_msg}
                    return

                response.raise_for_status()

                async for line in response.aiter_lines():
                    if await self._check_cancellation(cancel_event):
                        logger.info(
                            "%s stream cancelled after %d chunks in %.2fs",
                            self.provider_name,
                            chunk_count,
                            time.time() - start_time,
                        )
                        return

                    if not line or line.startswith(":"):
                        continue

                    if line.startswith("data: "):
                        data = line[6:]
                        if data == "[DONE]":
                            # Use return instead of break to immediately exit
                            # the generator and close the connection.
                            # Some APIs (e.g., AI) don't close the connection
                            # after sending [DONE], causing aiter_lines() to hang.
                            logger.info(
                                "%s stream completed: %d chunks in %.2fs",
                                self.provider_name,
                                chunk_count,
                                time.time() - start_time,
                            )
                            return

                        try:
                            chunk_count += 1
                            yield json.loads(data)
                        except json.JSONDecodeError:
                            continue

                # If we exit the loop without [DONE], log it
                logger.info(
                    "%s stream ended without [DONE] marker after %d chunks in %.2fs",
                    self.provider_name,
                    chunk_count,
                    time.time() - start_time,
                )

        except httpx.RequestError as e:
            logger.exception("%s request error", self.provider_name)
            yield {"_error": str(e)}
