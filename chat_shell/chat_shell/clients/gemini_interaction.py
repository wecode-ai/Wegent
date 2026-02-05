# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gemini Interaction API client for Deep Research functionality.

This client wraps the Gemini Interaction API which provides long-running
research tasks with streaming results.

API Reference: https://ai.google.dev/gemini-api/docs/interactions
"""

import logging
from typing import Any, AsyncIterator

import httpx

logger = logging.getLogger(__name__)


class GeminiInteractionError(Exception):
    """Exception raised for Gemini Interaction API errors."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class GeminiInteractionClient:
    """HTTP client for Gemini Interaction API.

    Supports:
    - Creating background research tasks (non-streaming)
    - Polling task status (non-streaming)
    - Streaming task results (SSE)
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
    ):
        """Initialize the client.

        Args:
            base_url: Base URL for the Gemini Interaction API
            api_key: API key for authentication
            timeout: Request timeout in seconds
        """
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _get_headers(self) -> dict[str, str]:
        """Get request headers with authentication."""
        return {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key,
        }

    async def create_interaction(
        self,
        input_text: str,
        agent: str = "deep-research-pro-preview-12-2025",
    ) -> dict[str, Any]:
        """Create a new research interaction (non-streaming).

        Args:
            input_text: The research query
            agent: The agent model to use

        Returns:
            Response containing interaction id and status

        Raises:
            GeminiInteractionError: If the API returns an error
        """
        url = f"{self.base_url}/v1beta/interactions"
        payload = {
            "background": True,
            "stream": False,
            "agent": agent,
            "input": input_text,
        }

        logger.info(
            "[GEMINI_CLIENT][CREATE] Request: url=%s, payload=%s",
            url,
            {
                **payload,
                "input": (
                    input_text[:200] + "..." if len(input_text) > 200 else input_text
                ),
            },
        )

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                response = await client.post(
                    url,
                    json=payload,
                    headers=self._get_headers(),
                )
                logger.info(
                    "[GEMINI_CLIENT][CREATE] Response: status=%d, body=%s",
                    response.status_code,
                    (
                        response.text[:1000]
                        if len(response.text) > 1000
                        else response.text
                    ),
                )
                response.raise_for_status()
                result = response.json()
                logger.info(
                    "[GEMINI_CLIENT][CREATE] Success: id=%s, status=%s",
                    result.get("id"),
                    result.get("status"),
                )
                return result
            except httpx.HTTPStatusError as e:
                logger.error(
                    "[GEMINI_CLIENT] Create interaction failed: status=%d, body=%s",
                    e.response.status_code,
                    e.response.text,
                )
                raise GeminiInteractionError(
                    f"Failed to create interaction: {e.response.text}",
                    status_code=e.response.status_code,
                )
            except httpx.RequestError as e:
                logger.error("[GEMINI_CLIENT] Request error: %s", e)
                raise GeminiInteractionError(f"Request failed: {e}")

    async def get_interaction_status(
        self,
        interaction_id: str,
    ) -> dict[str, Any]:
        """Get the status of an interaction (non-streaming).

        Args:
            interaction_id: The interaction ID to query

        Returns:
            Response containing interaction status

        Raises:
            GeminiInteractionError: If the API returns an error
        """
        url = f"{self.base_url}/v1beta/interactions/{interaction_id}"

        logger.info("[GEMINI_CLIENT][STATUS] Request: url=%s", url)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                response = await client.get(
                    url,
                    headers=self._get_headers(),
                )
                logger.info(
                    "[GEMINI_CLIENT][STATUS] Response: status=%d, body=%s",
                    response.status_code,
                    response.text[:500] if len(response.text) > 500 else response.text,
                )
                response.raise_for_status()
                result = response.json()
                logger.info(
                    "[GEMINI_CLIENT][STATUS] Success: id=%s, status=%s",
                    interaction_id,
                    result.get("status"),
                )
                return result
            except httpx.HTTPStatusError as e:
                logger.error(
                    "[GEMINI_CLIENT] Get status failed: id=%s, status=%d, body=%s",
                    interaction_id,
                    e.response.status_code,
                    e.response.text,
                )
                raise GeminiInteractionError(
                    f"Failed to get interaction status: {e.response.text}",
                    status_code=e.response.status_code,
                )
            except httpx.RequestError as e:
                logger.error("[GEMINI_CLIENT] Request error: %s", e)
                raise GeminiInteractionError(f"Request failed: {e}")

    async def stream_interaction_result(
        self,
        interaction_id: str,
    ) -> AsyncIterator[tuple[str, str]]:
        """Stream the result of a completed interaction.

        Args:
            interaction_id: The interaction ID to stream

        Yields:
            Tuples of (event_type, event_data) from the SSE stream

        Raises:
            GeminiInteractionError: If the API returns an error
        """
        url = f"{self.base_url}/v1beta/interactions/{interaction_id}"
        params = {"stream": "true"}

        logger.info(
            "[GEMINI_CLIENT][STREAM] Request: url=%s, params=%s",
            url,
            params,
        )

        async with httpx.AsyncClient(timeout=None) as client:
            try:
                async with client.stream(
                    "GET",
                    url,
                    params=params,
                    headers=self._get_headers(),
                ) as response:
                    logger.info(
                        "[GEMINI_CLIENT][STREAM] Response started: status=%d",
                        response.status_code,
                    )
                    if response.status_code != 200:
                        error_body = await response.aread()
                        logger.error(
                            "[GEMINI_CLIENT][STREAM] Failed: id=%s, status=%d, body=%s",
                            interaction_id,
                            response.status_code,
                            error_body.decode(),
                        )
                        raise GeminiInteractionError(
                            f"Failed to stream interaction: {error_body.decode()}",
                            status_code=response.status_code,
                        )

                    event_type = ""
                    event_data = ""
                    event_count = 0

                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line:
                            # Empty line signals end of event
                            if event_type and event_data:
                                event_count += 1
                                # Log every event for debugging
                                logger.info(
                                    "[GEMINI_CLIENT][STREAM] Event #%d: type=%s, data=%s",
                                    event_count,
                                    event_type,
                                    (
                                        event_data[:500]
                                        if len(event_data) > 500
                                        else event_data
                                    ),
                                )
                                yield event_type, event_data
                                event_type = ""
                                event_data = ""
                            continue

                        if line.startswith("event: "):
                            event_type = line[7:]
                        elif line.startswith("data: "):
                            event_data = line[6:]

                    # Yield any remaining event
                    if event_type and event_data:
                        event_count += 1
                        logger.info(
                            "[GEMINI_CLIENT][STREAM] Final event #%d: type=%s, data=%s",
                            event_count,
                            event_type,
                            event_data[:500] if len(event_data) > 500 else event_data,
                        )
                        yield event_type, event_data

                    logger.info(
                        "[GEMINI_CLIENT][STREAM] Completed: id=%s, total_events=%d",
                        interaction_id,
                        event_count,
                    )

            except httpx.RequestError as e:
                logger.error("[GEMINI_CLIENT] Stream request error: %s", e)
                raise GeminiInteractionError(f"Stream request failed: {e}")
