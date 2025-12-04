# SPDX-FileCopyrightText: 2025 WeCode-AI, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Memory service for long-term memory integration with mem0.

This module provides integration with self-hosted mem0 service for
user-level long-term memory that persists across chat sessions.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class MemoryService:
    """
    Service for managing long-term memories using mem0.

    Provides methods for adding, querying, updating and deleting memories.
    Uses user_id as the memory isolation identifier.
    """

    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None
        self._base_url = getattr(settings, 'MEM0_BASE_URL', '')
        self._api_key = getattr(settings, 'MEM0_API_KEY', '')
        self._enabled = getattr(settings, 'MEM0_ENABLED', True)

    @property
    def is_configured(self) -> bool:
        """Check if mem0 is properly configured."""
        return bool(self._base_url) and self._enabled

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client for mem0 API calls."""
        if self._client is None or self._client.is_closed:
            headers = {
                "Content-Type": "application/json",
            }
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"

            self._client = httpx.AsyncClient(
                base_url=self._base_url.rstrip('/'),
                headers=headers,
                timeout=30.0,
            )
        return self._client

    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def health_check(self) -> bool:
        """
        Check if mem0 service is healthy.

        Returns:
            bool: True if service is healthy, False otherwise
        """
        if not self.is_configured:
            return False

        try:
            client = await self._get_client()
            response = await client.get("/health")
            return response.status_code == 200
        except Exception as e:
            logger.warning(f"mem0 health check failed: {e}")
            return False

    async def add_memory(
        self,
        user_id: int,
        messages: List[Dict[str, str]],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Add a memory based on conversation messages.

        mem0 will automatically extract and store relevant information
        from the conversation, handling deduplication and updates.

        Args:
            user_id: User ID for memory isolation
            messages: List of conversation messages (role, content)
            metadata: Optional metadata to associate with the memory

        Returns:
            Response from mem0 API or None if failed
        """
        if not self.is_configured:
            logger.debug("mem0 not configured, skipping add_memory")
            return None

        try:
            client = await self._get_client()

            payload = {
                "messages": messages,
                "user_id": str(user_id),
            }
            if metadata:
                payload["metadata"] = metadata

            response = await client.post("/v1/memories/", json=payload)

            if response.status_code in (200, 201):
                return response.json()
            else:
                logger.warning(f"mem0 add_memory failed: status={response.status_code}, body={response.text}")
                return None

        except Exception as e:
            logger.warning(f"mem0 add_memory error: {e}")
            return None

    async def search_memories(
        self,
        user_id: int,
        query: str,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        """
        Search for relevant memories based on a query.

        Args:
            user_id: User ID for memory isolation
            query: Search query
            limit: Maximum number of memories to return

        Returns:
            List of relevant memories
        """
        if not self.is_configured:
            logger.debug("mem0 not configured, skipping search_memories")
            return []

        try:
            client = await self._get_client()

            payload = {
                "query": query,
                "user_id": str(user_id),
                "limit": limit,
            }

            response = await client.post("/v1/memories/search/", json=payload)

            if response.status_code == 200:
                data = response.json()
                # mem0 returns memories in a 'results' field
                return data.get("results", data) if isinstance(data, dict) else data
            else:
                logger.warning(f"mem0 search_memories failed: status={response.status_code}")
                return []

        except Exception as e:
            logger.warning(f"mem0 search_memories error: {e}")
            return []

    async def get_all_memories(
        self,
        user_id: int,
    ) -> List[Dict[str, Any]]:
        """
        Get all memories for a user.

        Args:
            user_id: User ID for memory isolation

        Returns:
            List of all user's memories
        """
        if not self.is_configured:
            logger.debug("mem0 not configured, skipping get_all_memories")
            return []

        try:
            client = await self._get_client()

            response = await client.get(
                "/v1/memories/",
                params={"user_id": str(user_id)},
            )

            if response.status_code == 200:
                data = response.json()
                # Handle both list and dict responses
                if isinstance(data, list):
                    return data
                return data.get("results", data.get("memories", []))
            else:
                logger.warning(f"mem0 get_all_memories failed: status={response.status_code}")
                return []

        except Exception as e:
            logger.warning(f"mem0 get_all_memories error: {e}")
            return []

    async def get_memory(
        self,
        memory_id: str,
    ) -> Optional[Dict[str, Any]]:
        """
        Get a single memory by ID.

        Args:
            memory_id: Memory ID

        Returns:
            Memory data or None if not found
        """
        if not self.is_configured:
            return None

        try:
            client = await self._get_client()

            response = await client.get(f"/v1/memories/{memory_id}/")

            if response.status_code == 200:
                return response.json()
            else:
                logger.warning(f"mem0 get_memory failed: status={response.status_code}")
                return None

        except Exception as e:
            logger.warning(f"mem0 get_memory error: {e}")
            return None

    async def update_memory(
        self,
        memory_id: str,
        content: str,
    ) -> Optional[Dict[str, Any]]:
        """
        Update a memory's content.

        Args:
            memory_id: Memory ID
            content: New memory content

        Returns:
            Updated memory data or None if failed
        """
        if not self.is_configured:
            return None

        try:
            client = await self._get_client()

            payload = {
                "text": content,
            }

            response = await client.put(f"/v1/memories/{memory_id}/", json=payload)

            if response.status_code == 200:
                return response.json()
            else:
                logger.warning(f"mem0 update_memory failed: status={response.status_code}")
                return None

        except Exception as e:
            logger.warning(f"mem0 update_memory error: {e}")
            return None

    async def delete_memory(
        self,
        memory_id: str,
    ) -> bool:
        """
        Delete a memory.

        Args:
            memory_id: Memory ID

        Returns:
            True if deleted successfully
        """
        if not self.is_configured:
            return False

        try:
            client = await self._get_client()

            response = await client.delete(f"/v1/memories/{memory_id}/")

            if response.status_code in (200, 204):
                return True
            else:
                logger.warning(f"mem0 delete_memory failed: status={response.status_code}")
                return False

        except Exception as e:
            logger.warning(f"mem0 delete_memory error: {e}")
            return False

    def format_memories_for_context(
        self,
        memories: List[Dict[str, Any]],
    ) -> str:
        """
        Format memories as context for LLM prompt.

        Args:
            memories: List of memory objects

        Returns:
            Formatted string to inject into system prompt
        """
        if not memories:
            return ""

        lines = ["<user_memories>", "The following are relevant memories about the user:"]

        for memory in memories:
            content = memory.get("memory", memory.get("text", memory.get("content", "")))
            if content:
                lines.append(f"- {content}")

        lines.append("</user_memories>")

        return "\n".join(lines)


# Global memory service instance
memory_service = MemoryService()
