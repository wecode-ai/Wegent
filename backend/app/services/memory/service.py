# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lightweight memory service with fire-and-forget operations."""

import asyncio
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class MemoryService:
    """
    Lightweight memory service - fire-and-forget operations.

    Design principles:
    - Zero database changes (no memory_ids field)
    - Fire-and-forget for store/delete (non-blocking)
    - Short timeout for retrieval (2s max)
    - Graceful degradation on any failure
    """

    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def enabled(self) -> bool:
        return settings.MEMORY_ENABLED and bool(settings.MEMORY_BASE_URL)

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=settings.MEMORY_BASE_URL.rstrip("/"),
                timeout=settings.MEMORY_TIMEOUT,
            )
        return self._client

    async def retrieve_for_chat(
        self,
        user_id: int,
        team_id: int,
        task_id: int,
        query: str,
        group_id: Optional[int] = None,
    ) -> str:
        """
        Retrieve memories (synchronous with timeout).

        Returns empty string on any failure - never blocks chat.
        """
        if not self.enabled:
            return ""

        try:
            client = await self._get_client()

            # Build filters
            filters = {"OR": [{"task_id": task_id}]}
            if group_id:
                filters["OR"].append({"group_id": group_id})

            response = await client.post(
                "/search",
                json={
                    "query": query,
                    "user_id": f"user_{user_id}",
                    "agent_id": f"team_{team_id}",
                    "filters": filters,
                    "limit": settings.MEMORY_SEARCH_LIMIT,
                },
            )

            if response.status_code != 200:
                return ""

            data = response.json()
            memories = data.get("results", data.get("memories", []))

            if not memories:
                return ""

            # Format as XML
            memory_blocks = []
            for mem in memories:
                score = mem.get("score", "")
                score_attr = f' relevance="{score:.2f}"' if score else ""
                memory_blocks.append(
                    f'<memory{score_attr}>\n{mem.get("memory", "")}\n</memory>'
                )

            memories_xml = "\n\n".join(memory_blocks)
            return f"""<long_term_memory>
以下是与当前用户相关的历史记忆，请在回答时参考这些背景信息：

{memories_xml}
</long_term_memory>"""

        except Exception as e:
            logger.debug(f"Memory retrieval failed (non-blocking): {e}")
            return ""

    def store_exchange(
        self,
        user_id: int,
        team_id: int,
        task_id: int,
        user_message: str,
        assistant_message: str,
        workspace_id: Optional[int] = None,
        group_id: Optional[int] = None,
        is_group_chat: bool = False,
        sender_name: Optional[str] = None,
    ):
        """
        Store conversation (fire-and-forget).

        Returns immediately, actual storage happens in background.
        """
        if not self.enabled:
            return

        # Smart filter
        if not self._should_store(user_message, assistant_message):
            return

        # Fire and forget
        asyncio.create_task(
            self._store_exchange_async(
                user_id,
                team_id,
                task_id,
                user_message,
                assistant_message,
                workspace_id,
                group_id,
                is_group_chat,
                sender_name,
            )
        )

    async def _store_exchange_async(
        self,
        user_id: int,
        team_id: int,
        task_id: int,
        user_message: str,
        assistant_message: str,
        workspace_id: Optional[int],
        group_id: Optional[int],
        is_group_chat: bool,
        sender_name: Optional[str],
    ):
        """Actual async storage implementation."""
        try:
            client = await self._get_client()

            messages = []
            if is_group_chat and sender_name:
                messages.append(
                    {"role": "user", "name": sender_name, "content": user_message}
                )
            else:
                messages.append({"role": "user", "content": user_message})
            messages.append({"role": "assistant", "content": assistant_message})

            metadata = {
                "task_id": task_id,
                "workspace_id": workspace_id,
                "is_group_chat": is_group_chat,
            }
            if group_id:
                metadata["group_id"] = group_id
            if sender_name:
                metadata["sender_name"] = sender_name

            await client.post(
                "/memories",
                json={
                    "messages": messages,
                    "user_id": f"user_{user_id}",
                    "agent_id": f"team_{team_id}",
                    "metadata": metadata,
                },
            )
            logger.debug(f"Memory stored for task={task_id}")

        except Exception as e:
            logger.warning(f"Memory storage failed (non-blocking): {e}")

    def delete_by_task(self, task_id: int):
        """
        Delete task memories (fire-and-forget).

        Returns immediately, actual deletion happens in background.
        """
        if not self.enabled:
            return

        asyncio.create_task(self._delete_by_task_async(task_id))

    async def _delete_by_task_async(self, task_id: int):
        """Actual async deletion implementation."""
        try:
            client = await self._get_client()

            # Search all memories with this task_id
            response = await client.post(
                "/search",
                json={
                    "query": "",
                    "filters": {"task_id": task_id},
                    "limit": 1000,  # Get all
                },
            )

            if response.status_code != 200:
                return

            data = response.json()
            memories = data.get("results", data.get("memories", []))

            # Delete each memory
            for mem in memories:
                mem_id = mem.get("id")
                if mem_id:
                    await client.delete(f"/memories/{mem_id}")

            logger.info(f"Deleted {len(memories)} memories for task={task_id}")

        except Exception as e:
            logger.warning(f"Memory deletion failed (non-blocking): {e}")

    def _should_store(self, user_message: str, assistant_message: str) -> bool:
        """Smart filter to avoid storing trivial messages."""

        def is_meaningful(content: str) -> bool:
            if not content or len(content.strip()) < settings.MEMORY_FILTER_MIN_LENGTH:
                return False

            content_lower = content.strip().lower()
            filler_phrases = {
                p.strip().lower()
                for p in settings.MEMORY_FILTER_PHRASES.split(",")
                if p.strip()
            }

            if content_lower in filler_phrases:
                return False

            return True

        return is_meaningful(user_message) or is_meaningful(assistant_message)

    async def close(self):
        """Close HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None


# Global singleton
_memory_service: Optional[MemoryService] = None


def get_memory_service() -> MemoryService:
    """Get memory service singleton."""
    global _memory_service
    if _memory_service is None:
        _memory_service = MemoryService()
    return _memory_service
