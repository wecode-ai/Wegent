# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""High-level memory management API.

This module provides business logic for memory operations:
- Search relevant memories for chat context
- Store user messages as memories (fire-and-forget)
- Cleanup memories when tasks are deleted

All methods handle errors gracefully and don't block main flow.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from shared.telemetry.decorators import trace_async, trace_sync

from app.core.config import settings
from app.services.memory.client import LongTermMemoryClient
from app.services.memory.schemas import MemoryMetadata, MemorySearchResult
from app.services.memory.utils import (
    format_metadata_for_logging,
    inject_memories_to_prompt,
)

logger = logging.getLogger(__name__)


class MemoryManager:
    """High-level API for memory operations.

    This manager provides business logic on top of LongTermMemoryClient:
    - Validates settings
    - Builds metadata
    - Handles fire-and-forget writes
    - Provides timeout reads

    Singleton instance is created on first use.
    """

    _instance: Optional["MemoryManager"] = None
    _client: Optional[LongTermMemoryClient] = None

    def __init__(self) -> None:
        """Initialize MemoryManager (use get_instance() instead)."""
        if settings.MEMORY_ENABLED:
            self._client = LongTermMemoryClient(
                base_url=settings.MEMORY_BASE_URL,
                api_key=settings.MEMORY_API_KEY,
            )
            logger.info(
                "MemoryManager initialized (enabled, base_url=%s)",
                settings.MEMORY_BASE_URL,
            )
        else:
            logger.info("MemoryManager initialized (disabled)")

    @classmethod
    def get_instance(cls) -> "MemoryManager":
        """Get singleton instance of MemoryManager.

        Returns:
            MemoryManager instance
        """
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def is_enabled(self) -> bool:
        """Check if memory feature is enabled.

        Returns:
            True if enabled and configured correctly
        """
        return settings.MEMORY_ENABLED and self._client is not None

    @trace_async("memory.manager.search_memories")
    async def search_memories(
        self,
        user_id: str,
        query: str,
        group_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> List[MemorySearchResult]:
        """Search for relevant memories across all conversations.

        This method implements cross-conversation memory retrieval.
        It searches all memories for the user, not limited to current task/team.

        Uses timeout to avoid blocking chat flow.

        Args:
            user_id: User ID
            query: Search query text (user message)
            group_id: Optional conversation group ID (future use)
            timeout: Override default timeout (default: MEMORY_TIMEOUT_SECONDS)

        Returns:
            List of relevant memories (empty on failure/timeout)

        Example:
            memories = await manager.search_memories(
                user_id="123",
                query="How do I deploy to production?",
                timeout=2.0
            )
        """
        if not self.is_enabled:
            return []

        try:
            # Use configured timeout if not specified
            search_timeout = (
                timeout if timeout is not None else settings.MEMORY_TIMEOUT_SECONDS
            )

            # Build metadata filters - only filter by group_id if specified
            # Do NOT filter by task_id or team_id to enable cross-conversation memory
            filters = {}
            if group_id is not None:
                filters["metadata.group_id"] = group_id

            # Search with timeout
            result = await self._client.search_memories(
                user_id=user_id,
                query=query,
                filters=filters if filters else None,
                limit=settings.MEMORY_MAX_RESULTS,
                timeout=search_timeout,
            )

            logger.info(
                "Retrieved %d cross-conversation memories for user %s",
                len(result.results),
                user_id,
            )

            return result.results

        except Exception as e:
            logger.error("Unexpected error searching memories: %s", e, exc_info=True)
            return []

    @trace_async("memory.manager.save_user_message")
    async def save_user_message_async(
        self,
        user_id: str,
        team_id: str,
        task_id: str,
        subtask_id: str,
        message: str,
        workspace_id: Optional[str] = None,
        group_id: Optional[str] = None,
        is_group_chat: bool = False,
    ) -> None:
        """Store user message in memory (fire-and-forget).

        This method is called after user subtask is created.
        Runs in background, doesn't block main flow.

        Only stores USER messages, not AI responses (per requirements).

        Args:
            user_id: User ID
            team_id: Team/Agent ID
            task_id: Task ID (for deletion)
            subtask_id: Subtask ID (traceability)
            message: User message content
            workspace_id: Optional workspace ID (for Code tasks)
            group_id: Optional conversation group ID (future use)
            is_group_chat: Whether this is a group chat

        Example:
            asyncio.create_task(
                manager.save_user_message_async(
                    user_id="123",
                    team_id="456",
                    task_id="789",
                    subtask_id="1011",
                    message="I prefer Python for backend"
                )
            )
        """
        if not self.is_enabled:
            return

        try:
            # Build metadata
            metadata = MemoryMetadata(
                task_id=task_id,
                subtask_id=subtask_id,
                team_id=team_id,
                workspace_id=workspace_id,
                group_id=group_id,
                is_group_chat=is_group_chat,
                created_at=datetime.now(timezone.utc).isoformat(),
            )

            # Log the generated timestamp for debugging
            logger.info("Generated memory timestamp: %s (UTC)", metadata.created_at)

            # Build messages (mem0 format)
            messages = [{"role": "user", "content": message}]

            # Call mem0 API
            result = await self._client.add_memory(
                user_id=user_id,
                messages=messages,
                metadata=metadata.model_dump(),
            )

            if result:
                # mem0 returns {"results": [{"id": ..., "memory": ..., "event": ...}]}
                memory_count = 0
                if isinstance(result, dict) and "results" in result:
                    memory_count = len(result.get("results", []))
                logger.info(
                    "Stored %d memories for user %s, task %s, subtask %s",
                    memory_count,
                    user_id,
                    task_id,
                    subtask_id,
                )
            else:
                logger.warning(
                    "Failed to store memory for user %s, task %s, subtask %s",
                    user_id,
                    task_id,
                    subtask_id,
                )

        except Exception as e:
            logger.error(
                "Unexpected error storing memory for user %s, task %s: %s",
                user_id,
                task_id,
                e,
                exc_info=True,
            )

    @trace_async("memory.manager.cleanup_memories")
    async def cleanup_task_memories(
        self, user_id: str, task_id: str, batch_size: int = 1000
    ) -> int:
        """Delete all memories associated with a task.

        This method is called when a task is deleted.
        Uses metadata search to find all related memories, then deletes them.
        Implements pagination to handle large numbers of memories.

        Args:
            user_id: User ID
            task_id: Task ID to cleanup
            batch_size: Max memories to delete per batch

        Returns:
            Number of memories deleted

        Example:
            asyncio.create_task(
                manager.cleanup_task_memories(user_id="123", task_id="789")
            )
        """
        if not self.is_enabled:
            return 0

        try:
            total_delete_count = 0
            total_error_count = 0
            consecutive_no_progress = 0
            max_no_progress_attempts = 3

            # Keep searching until no more memories are found
            while True:
                # Step 1: Search for memories with this task_id
                search_result = await self._client.search_memories(
                    user_id=user_id,
                    query="",  # Empty query to match all
                    filters={"metadata.task_id": task_id},
                    limit=batch_size,
                )

                memories = search_result.results
                if not memories:
                    # No more memories to cleanup
                    break

                # Step 2: Delete each memory in this batch
                batch_delete_count = 0
                batch_error_count = 0

                for memory in memories:
                    memory_id = memory.id
                    try:
                        success = await self._client.delete_memory(memory_id)
                        if success:
                            batch_delete_count += 1
                        else:
                            batch_error_count += 1
                    except Exception as e:
                        logger.error(
                            "Failed to delete memory %s: %s",
                            memory_id,
                            e,
                            exc_info=True,
                        )
                        batch_error_count += 1

                total_delete_count += batch_delete_count
                total_error_count += batch_error_count

                # Check for progress
                if batch_delete_count == 0:
                    consecutive_no_progress += 1
                    logger.warning(
                        "No progress in cleanup batch for task %s (%d consecutive attempts with no deletions)",
                        task_id,
                        consecutive_no_progress,
                    )
                    if consecutive_no_progress >= max_no_progress_attempts:
                        logger.error(
                            "Stopping cleanup for task %s after %d attempts with no successful deletions. "
                            "Deleted %d memories, %d errors encountered.",
                            task_id,
                            max_no_progress_attempts,
                            total_delete_count,
                            total_error_count,
                        )
                        break
                else:
                    consecutive_no_progress = 0

                logger.info(
                    "Cleaned up batch of %d memories for task %s (%d errors)",
                    batch_delete_count,
                    task_id,
                    batch_error_count,
                )

                # If we deleted fewer than batch_size memories, we've reached the end
                if len(memories) < batch_size:
                    break

            logger.info(
                "Cleaned up %d memories for task %s (%d errors)",
                total_delete_count,
                task_id,
                total_error_count,
            )

            return total_delete_count

        except Exception as e:
            logger.error(
                "Unexpected error cleaning up memories for task %s: %s",
                task_id,
                e,
                exc_info=True,
            )
            return 0

    @trace_sync("memory.manager.inject_memories")
    def inject_memories_to_prompt(
        self, base_prompt: str, memories: List[MemorySearchResult]
    ) -> str:
        """Inject memories into system prompt.

        Wrapper around utils.inject_memories_to_prompt() for convenience.

        Args:
            base_prompt: Original system prompt
            memories: List of memories to inject

        Returns:
            Enhanced system prompt with memory context
        """
        return inject_memories_to_prompt(base_prompt, memories)

    @trace_async("memory.manager.close")
    async def close(self) -> None:
        """Close HTTP client session."""
        if self._client:
            await self._client.close()


# Convenience function for getting manager instance
def get_memory_manager() -> MemoryManager:
    """Get singleton MemoryManager instance.

    Returns:
        MemoryManager instance
    """
    return MemoryManager.get_instance()
