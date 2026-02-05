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
import threading
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


def _is_in_async_task() -> bool:
    """Check if we're running inside an asyncio Task.

    aiohttp's ClientTimeout requires being inside an asyncio.Task,
    not just inside an event loop. This is because Python 3.11+'s
    asyncio.timeout() context manager checks for task context.

    Returns:
        True if running inside an asyncio Task, False otherwise
    """
    try:
        task = asyncio.current_task()
        return task is not None
    except RuntimeError:
        return False


def _get_current_loop_id() -> int:
    """Get the current event loop's id for comparison.

    Returns:
        Loop id, or 0 if no loop is running
    """
    try:
        loop = asyncio.get_running_loop()
        return id(loop)
    except RuntimeError:
        return 0


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
        # Per-loop locks to avoid "attached to different loop" errors
        # asyncio.Lock is bound to the event loop it was created in
        self._session_locks: Dict[int, asyncio.Lock] = {}
        self._session_locks_guard = threading.Lock()
        # Track which event loop the session was created in
        self._session_loop_id: int = 0

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

        The session is bound to the event loop it was created in. If the current
        loop is different from the one the session was created in, we recreate
        the session to avoid "Event loop is closed" errors.

        IMPORTANT: We do NOT set timeout on the ClientSession itself because
        aiohttp's ClientTimeout uses asyncio.timeout() internally, which
        requires being inside an asyncio.Task. When called from Celery via
        loop.run_until_complete(), we may not be in a Task context.
        Instead, timeout is applied per-request only when in Task context.

        Returns:
            aiohttp ClientSession instance
        """
        current_loop_id = _get_current_loop_id()

        # Get or create lock for this event loop
        # asyncio.Lock is bound to the loop it was created in, so we need per-loop locks
        with self._session_locks_guard:
            if current_loop_id not in self._session_locks:
                self._session_locks[current_loop_id] = asyncio.Lock()
            session_lock = self._session_locks[current_loop_id]

        # Check if we need a new session (no session, closed, or different loop)
        needs_new_session = (
            self._session is None
            or self._session.closed
            or (current_loop_id != 0 and self._session_loop_id != current_loop_id)
        )

        if needs_new_session:
            async with session_lock:
                # Double-check after acquiring lock
                current_loop_id = _get_current_loop_id()
                needs_new_session = (
                    self._session is None
                    or self._session.closed
                    or (
                        current_loop_id != 0
                        and self._session_loop_id != current_loop_id
                    )
                )

                if needs_new_session:
                    # Close old session if it exists and is from a different loop
                    if self._session and not self._session.closed:
                        try:
                            await self._session.close()
                        except Exception as e:
                            # Log the error but continue - session cleanup is not critical
                            logger.warning("Failed to close old aiohttp session: %s", e)

                    # Create session WITHOUT timeout - timeout is applied per-request
                    # This avoids "Timeout context manager should be used inside a task"
                    self._session = aiohttp.ClientSession()
                    self._session_loop_id = current_loop_id
                    logger.debug(
                        "Created new aiohttp session for loop %s", current_loop_id
                    )

        return self._session

    def _get_request_timeout(
        self, custom_timeout: Optional[float] = None
    ) -> Optional[aiohttp.ClientTimeout]:
        """Get timeout for a request, only if we're in an asyncio Task.

        aiohttp's ClientTimeout uses asyncio.timeout() internally (Python 3.11+),
        which requires being inside an asyncio.Task. When called from Celery
        via loop.run_until_complete(), we may not be in a Task context.

        Args:
            custom_timeout: Custom timeout value, or None to use default

        Returns:
            ClientTimeout if in Task context, None otherwise (no timeout)
        """
        if not _is_in_async_task():
            logger.debug(
                "Not in asyncio Task context, skipping timeout (may be Celery worker)"
            )
            return None

        timeout_value = custom_timeout if custom_timeout is not None else self.timeout
        return aiohttp.ClientTimeout(total=timeout_value)

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

            # Get timeout only if in Task context
            request_timeout = self._get_request_timeout()

            async with session.post(
                f"{self.base_url}/memories",
                json=request.model_dump(exclude_none=True),
                headers=self._get_headers(),
                timeout=request_timeout,
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

            # Get timeout only if in Task context
            request_timeout = self._get_request_timeout(timeout)

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

            # Get timeout only if in Task context
            request_timeout = self._get_request_timeout()

            async with session.delete(
                f"{self.base_url}/memories/{memory_id}",
                headers=self._get_headers(),
                timeout=request_timeout,
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

            # Get timeout only if in Task context
            request_timeout = self._get_request_timeout()

            async with session.get(
                f"{self.base_url}/memories/{memory_id}",
                headers=self._get_headers(),
                timeout=request_timeout,
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
