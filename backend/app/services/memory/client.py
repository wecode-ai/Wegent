# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Low-level HTTP client for mem0 API interaction.

This module provides async HTTP methods to interact with mem0 service.
All methods are designed for graceful degradation:
- Service unavailable → log warning, return None/empty list
- Timeout → log warning, return None/empty list
- Error → log error, return None/empty list

Usage:
    client = LongTermMemoryClient(base_url, api_key)
    result = await client.add_memory(user_id, messages, metadata)
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

import aiohttp

from app.core.config import settings
from app.services.memory.schemas import (
    MemoryCreateRequest,
    MemorySearchRequest,
    MemorySearchResponse,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


class LongTermMemoryClient:
    """Async HTTP client for mem0 service.

    This client provides low-level HTTP methods to interact with mem0 API.
    All methods handle errors gracefully and return None/empty on failure.

    Attributes:
        base_url: mem0 service base URL
        api_key: Optional API key for authentication
        timeout: Default timeout for HTTP requests
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> None:
        """Initialize mem0 client.

        Args:
            base_url: mem0 service base URL (default: from settings)
            api_key: Optional API key (default: from settings)
            timeout: Default HTTP timeout in seconds (default: from settings)

        Raises:
            ValueError: If base_url is empty or None
        """
        raw_base = base_url or settings.MEMORY_BASE_URL
        if not raw_base:
            raise ValueError(
                "base_url cannot be empty. Provide a valid mem0 service URL."
            )

        self.base_url = raw_base.rstrip("/")
        self.api_key = api_key or settings.MEMORY_API_KEY
        self.timeout = (
            timeout if timeout is not None else settings.MEMORY_TIMEOUT_SECONDS
        )
        self._session: Optional[aiohttp.ClientSession] = None
        self._session_lock = asyncio.Lock()

    def _get_headers(self) -> Dict[str, str]:
        """Build HTTP headers for mem0 API requests.

        Returns:
            Dictionary of HTTP headers
        """
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session (lazy initialization with thread-safety).

        Uses double-check locking pattern to prevent race conditions when
        multiple coroutines attempt to create the session simultaneously.

        Returns:
            aiohttp ClientSession instance
        """
        if self._session is None or self._session.closed:
            async with self._session_lock:
                # Double-check after acquiring lock
                if self._session is None or self._session.closed:
                    self._session = aiohttp.ClientSession(
                        timeout=aiohttp.ClientTimeout(total=self.timeout)
                    )
        return self._session

    async def close(self) -> None:
        """Close aiohttp session."""
        if self._session and not self._session.closed:
            await self._session.close()

    @trace_async("mem0.client.add_memory")
    async def add_memory(
        self,
        user_id: str,
        messages: List[Dict[str, str]],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Store a new memory in mem0 service.

        Args:
            user_id: User ID (mem0 identifier)
            messages: Message list [{"role": "user", "content": "..."}]
            metadata: Optional metadata for flexible querying

        Returns:
            Response dict with memory ID on success, None on failure

        Example:
            result = await client.add_memory(
                user_id="123",
                messages=[{"role": "user", "content": "I prefer Python"}],
                metadata={"task_id": 456, "team_id": 789}
            )
        """
        try:
            session = await self._get_session()

            request = MemoryCreateRequest(
                user_id=user_id,
                messages=messages,
                metadata=metadata,
            )

            async with session.post(
                f"{self.base_url}/memories",
                json=request.model_dump(exclude_none=True),
                headers=self._get_headers(),
            ) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    # mem0 returns {"results": [{"id": ..., "memory": ..., "event": ...}]}
                    memory_ids = []
                    if isinstance(result, dict) and "results" in result:
                        memory_ids = [
                            str(item.get("id"))
                            for item in result.get("results", [])
                            if isinstance(item, dict) and "id" in item
                        ]
                    logger.info(
                        "Successfully stored memory for user %s: %d memories created (%s)",
                        user_id,
                        len(memory_ids),
                        ", ".join(memory_ids[:3])
                        + ("..." if len(memory_ids) > 3 else ""),
                    )
                    return result
                else:
                    error_text = await resp.text()
                    logger.error(
                        "Failed to store memory (HTTP %d): %s", resp.status, error_text
                    )
                    return None

        except asyncio.TimeoutError:
            logger.warning("Timeout storing memory for user %s", user_id)
            return None
        except aiohttp.ClientError as e:
            logger.warning("Failed to store memory (connection error): %s", e)
            return None
        except Exception as e:
            logger.error("Unexpected error storing memory: %s", e, exc_info=True)
            return None

    @trace_async("mem0.client.search_memories")
    async def search_memories(
        self,
        user_id: str,
        query: str,
        filters: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> MemorySearchResponse:
        """Search for relevant memories.

        Args:
            user_id: User ID (mem0 identifier)
            query: Search query text
            filters: Optional metadata filters (e.g., {"task_id": "123", "project_id": "456"})
                    Note: mem0 automatically adds "metadata." prefix, so use field names directly
            limit: Max results to return
            timeout: Override default timeout for this request

        Returns:
            MemorySearchResponse with results (empty on failure)

        Example:
            results = await client.search_memories(
                user_id="123",
                query="Python preferences",
                filters={"task_id": "456"},
                limit=5,
                timeout=2.0
            )
        """
        try:
            session = await self._get_session()

            request = MemorySearchRequest(
                query=query,
                user_id=user_id,
                filters=filters,
                limit=limit,
            )

            # Use custom timeout if provided
            request_timeout = (
                aiohttp.ClientTimeout(total=timeout) if timeout is not None else None
            )

            async with session.post(
                f"{self.base_url}/search",
                json=request.model_dump(exclude_none=True),
                headers=self._get_headers(),
                timeout=request_timeout,
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    result = MemorySearchResponse(**data)
                    logger.info(
                        "Found %d memories for user %s", len(result.results), user_id
                    )
                    return result
                else:
                    error_text = await resp.text()
                    logger.error(
                        "Failed to search memories (HTTP %d): %s",
                        resp.status,
                        error_text,
                    )
                    return MemorySearchResponse(results=[])

        except asyncio.TimeoutError:
            logger.warning(
                "Timeout searching memories for user %s (timeout=%s)",
                user_id,
                timeout or self.timeout,
            )
            return MemorySearchResponse(results=[])
        except aiohttp.ClientError as e:
            logger.warning("Failed to search memories (connection error): %s", e)
            return MemorySearchResponse(results=[])
        except Exception as e:
            logger.error("Unexpected error searching memories: %s", e, exc_info=True)
            return MemorySearchResponse(results=[])

    @trace_async("mem0.client.delete_memory")
    async def delete_memory(self, memory_id: str) -> bool:
        """Delete a single memory by ID.

        Args:
            memory_id: Memory ID to delete

        Returns:
            True on success, False on failure
        """
        try:
            session = await self._get_session()

            async with session.delete(
                f"{self.base_url}/memories/{memory_id}",
                headers=self._get_headers(),
            ) as resp:
                if resp.status == 200:
                    logger.info("Successfully deleted memory %s", memory_id)
                    return True
                else:
                    error_text = await resp.text()
                    logger.error(
                        "Failed to delete memory %s (HTTP %d): %s",
                        memory_id,
                        resp.status,
                        error_text,
                    )
                    return False

        except asyncio.TimeoutError:
            logger.warning("Timeout deleting memory %s", memory_id)
            return False
        except aiohttp.ClientError as e:
            logger.warning(
                "Failed to delete memory %s (connection error): %s", memory_id, e
            )
            return False
        except Exception as e:
            logger.error(
                "Unexpected error deleting memory %s: %s", memory_id, e, exc_info=True
            )
            return False

    @trace_async("mem0.client.get_memory")
    async def get_memory(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """Get a single memory by ID.

        Args:
            memory_id: Memory ID to retrieve

        Returns:
            Memory dict on success, None on failure
        """
        try:
            session = await self._get_session()

            async with session.get(
                f"{self.base_url}/memories/{memory_id}",
                headers=self._get_headers(),
            ) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    logger.info("Successfully retrieved memory %s", memory_id)
                    return result
                else:
                    error_text = await resp.text()
                    logger.error(
                        "Failed to get memory %s (HTTP %d): %s",
                        memory_id,
                        resp.status,
                        error_text,
                    )
                    return None

        except asyncio.TimeoutError:
            logger.warning("Timeout getting memory %s", memory_id)
            return None
        except aiohttp.ClientError as e:
            logger.warning(
                "Failed to get memory %s (connection error): %s", memory_id, e
            )
            return None
        except Exception as e:
            logger.error(
                "Unexpected error getting memory %s: %s", memory_id, e, exc_info=True
            )
            return None
