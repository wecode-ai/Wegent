# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Low-level HTTP client for mem0 API interaction.

This module provides async HTTP methods to interact with mem0 service.
All methods are designed for graceful degradation:
- Service unavailable → log warning, return None/empty list
- Timeout → log warning, return None/empty list
- Error → log error, return None/empty list

Note: This client uses AsyncSessionManager to create sessions in the
current event loop context, avoiding "Event loop is closed" errors when
called from different event loop contexts (e.g., background tasks).

Usage:
    client = LongTermMemoryClient(base_url, api_key)
    result = await client.add_memory(user_id, messages, metadata)
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import aiohttp

from app.core.async_utils import AsyncSessionManager
from app.core.config import settings
from app.services.memory.schemas import (
    MemoryCreateRequest,
    MemorySearchRequest,
    MemorySearchResponse,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


@dataclass
class HttpResponse:
    """HTTP response wrapper for internal use."""

    success: bool
    data: Optional[Any] = None
    error_text: Optional[str] = None
    status_code: Optional[int] = None


class LongTermMemoryClient:
    """Async HTTP client for mem0 service.

    This client provides low-level HTTP methods to interact with mem0 API.
    All methods handle errors gracefully and return None/empty on failure.

    Note: This client creates a new aiohttp session for each request to avoid
    event loop binding issues. This is intentional - while slightly less
    efficient, it ensures reliability when called from different event loops
    (e.g., background tasks, Celery workers).

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

    def _get_headers(self) -> Dict[str, str]:
        """Build HTTP headers for mem0 API requests.

        Returns:
            Dictionary of HTTP headers
        """
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def _execute_request(
        self,
        method: str,
        endpoint: str,
        *,
        json_data: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        operation: str = "request",
        context: str = "",
        parse_response: bool = True,
    ) -> HttpResponse:
        """Execute an HTTP request with unified error handling.

        This method encapsulates the common pattern of:
        1. Creating an async session with timeout
        2. Making the HTTP request
        3. Handling success/error responses
        4. Managing exceptions (timeout, connection, unexpected)

        Args:
            method: HTTP method ('get', 'post', 'delete')
            endpoint: API endpoint (will be appended to base_url)
            json_data: Optional JSON body for the request
            timeout: Request timeout (defaults to self.timeout)
            operation: Operation name for logging (e.g., 'store memory')
            context: Additional context for logging (e.g., 'user_id=123')
            parse_response: Whether to parse JSON response (False for DELETE)

        Returns:
            HttpResponse with success status and data/error
        """
        url = f"{self.base_url}{endpoint}"
        request_timeout = timeout if timeout is not None else self.timeout

        try:
            async with AsyncSessionManager(timeout=request_timeout) as session:
                http_method = getattr(session, method)
                kwargs: Dict[str, Any] = {"headers": self._get_headers()}
                if json_data is not None:
                    kwargs["json"] = json_data

                async with http_method(url, **kwargs) as resp:
                    if resp.status == 200:
                        data = await resp.json() if parse_response else None
                        return HttpResponse(success=True, data=data)
                    else:
                        error_text = await resp.text()
                        logger.error(
                            "Failed to %s (HTTP %d): %s%s",
                            operation,
                            resp.status,
                            error_text,
                            f" [{context}]" if context else "",
                        )
                        return HttpResponse(
                            success=False,
                            error_text=error_text,
                            status_code=resp.status,
                        )

        except asyncio.TimeoutError:
            logger.warning(
                "Timeout %s (timeout=%s)%s",
                operation,
                request_timeout,
                f" [{context}]" if context else "",
            )
            return HttpResponse(success=False, error_text="timeout")
        except aiohttp.ClientError as e:
            logger.warning(
                "Failed to %s (connection error): %s%s",
                operation,
                e,
                f" [{context}]" if context else "",
            )
            return HttpResponse(success=False, error_text=str(e))
        except Exception as e:
            logger.error(
                "Unexpected error %s: %s%s",
                operation,
                e,
                f" [{context}]" if context else "",
                exc_info=True,
            )
            return HttpResponse(success=False, error_text=str(e))

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
        request = MemoryCreateRequest(
            user_id=user_id,
            messages=messages,
            metadata=metadata,
        )

        response = await self._execute_request(
            method="post",
            endpoint="/memories",
            json_data=request.model_dump(exclude_none=True),
            timeout=settings.MEMORY_WRITE_TIMEOUT_SECONDS,
            operation="store memory",
            context=f"user_id={user_id}",
        )

        if not response.success:
            return None

        result = response.data
        # Log memory creation details
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
            ", ".join(memory_ids[:3]) + ("..." if len(memory_ids) > 3 else ""),
        )
        return result

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
        request = MemorySearchRequest(
            query=query,
            user_id=user_id,
            filters=filters,
            limit=limit,
        )

        response = await self._execute_request(
            method="post",
            endpoint="/search",
            json_data=request.model_dump(exclude_none=True),
            timeout=timeout,
            operation="search memories",
            context=f"user_id={user_id}",
        )

        if not response.success:
            return MemorySearchResponse(results=[])

        if not response.data:
            result = MemorySearchResponse(results=[])
        else:
            result = MemorySearchResponse(**response.data)
        logger.info(
            "Found %d memories for user %s",
            len(result.results),
            user_id,
        )
        return result

    @trace_async("mem0.client.delete_memory")
    async def delete_memory(self, memory_id: str) -> bool:
        """Delete a single memory by ID.

        Args:
            memory_id: Memory ID to delete

        Returns:
            True on success, False on failure
        """
        response = await self._execute_request(
            method="delete",
            endpoint=f"/memories/{memory_id}",
            operation="delete memory",
            context=f"memory_id={memory_id}",
            parse_response=False,
        )

        if response.success:
            logger.info("Successfully deleted memory %s", memory_id)
        return response.success

    @trace_async("mem0.client.get_memory")
    async def get_memory(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """Get a single memory by ID.

        Args:
            memory_id: Memory ID to retrieve

        Returns:
            Memory dict on success, None on failure
        """
        response = await self._execute_request(
            method="get",
            endpoint=f"/memories/{memory_id}",
            operation="get memory",
            context=f"memory_id={memory_id}",
        )

        if response.success:
            logger.info("Successfully retrieved memory %s", memory_id)
            return response.data
        return None
