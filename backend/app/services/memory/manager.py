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

import logging
from typing import Any, Dict, List, Optional

from app.core.config import settings
from app.services.memory.client import LongTermMemoryClient
from app.services.memory.schemas import MemoryMetadata, MemorySearchResult
from app.services.memory.utils import inject_memories_to_prompt
from shared.telemetry.decorators import trace_async, trace_sync

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

    def _get_prefixed_user_id(self, user_id: str) -> str:
        """Build user ID with configured prefix for resource isolation.

        Since mem0 may be a shared service across multiple systems,
        this method adds a configurable prefix to isolate wegent's resources.

        Args:
            user_id: Original user ID from wegent platform

        Returns:
            Prefixed user ID for mem0 API calls
        """
        return f"{settings.MEMORY_USER_ID_PREFIX}{user_id}"

    @trace_async("memory.manager.search_memories")
    async def search_memories(
        self,
        user_id: str,
        query: str,
        project_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> List[MemorySearchResult]:
        """Search for relevant memories with project-based prioritization.

        This method implements priority-based memory retrieval:
        1. If project_id is provided, first search within the same project
        2. Then search user's general memories to fill remaining slots
        3. Prioritizes project-specific memories over general memories

        Uses timeout to avoid blocking chat flow.

        Args:
            user_id: User ID
            query: Search query text (user message)
            project_id: Optional project ID for prioritization
            timeout: Override default timeout (default: MEMORY_TIMEOUT_SECONDS)

        Returns:
            List of relevant memories (project memories first, then general)

        Example:
            memories = await manager.search_memories(
                user_id="123",
                query="How do I deploy to production?",
                project_id="456",
                timeout=2.0
            )
        """
        if not self.is_enabled:
            return []

        try:
            # Build prefixed user_id for resource isolation
            prefixed_user_id = self._get_prefixed_user_id(user_id)

            # Use configured timeout if not specified
            search_timeout = (
                timeout if timeout is not None else settings.MEMORY_TIMEOUT_SECONDS
            )
            max_results = settings.MEMORY_MAX_RESULTS

            # If no project_id, search all memories
            if project_id is None:
                result = await self._client.search_memories(
                    user_id=prefixed_user_id,
                    query=query,
                    filters=None,
                    limit=max_results,
                    timeout=search_timeout,
                )
                logger.info(
                    "Retrieved %d cross-conversation memories for user %s (no project filter)",
                    len(result.results),
                    user_id,
                )
                return result.results

            # Priority-based search: project memories first
            project_memories = []
            general_memories = []

            # Step 1: Search project-specific memories (higher priority)
            try:
                project_result = await self._client.search_memories(
                    user_id=prefixed_user_id,
                    query=query,
                    filters={"project_id": project_id},
                    limit=max_results,
                    timeout=search_timeout / 2,  # Use half timeout for first search
                )
                project_memories = project_result.results
                logger.info(
                    "Retrieved %d project-specific memories (project_id=%s) for user %s",
                    len(project_memories),
                    project_id,
                    user_id,
                )
            except Exception as e:
                logger.warning(
                    "Failed to search project-specific memories: %s", e, exc_info=True
                )

            # Step 2: Search general memories (lower priority) if we need more
            remaining_slots = max_results - len(project_memories)
            if remaining_slots > 0:
                try:
                    # Search for memories without project_id OR with different project_id
                    # This includes both individual conversations and other projects
                    general_result = await self._client.search_memories(
                        user_id=prefixed_user_id,
                        query=query,
                        filters=None,  # Search all to get user's general knowledge
                        limit=max_results,  # Get more to filter out project-specific ones
                        timeout=search_timeout / 2,  # Use remaining half timeout
                    )
                    # Filter out memories from the current project (already have them)
                    general_memories = [
                        m
                        for m in general_result.results
                        if m.metadata.get("project_id") != project_id
                    ][
                        :remaining_slots
                    ]  # Take only remaining slots
                    logger.info(
                        "Retrieved %d general memories for user %s",
                        len(general_memories),
                        user_id,
                    )
                except Exception as e:
                    logger.warning(
                        "Failed to search general memories: %s", e, exc_info=True
                    )

            # Combine: project memories first, then general
            combined_memories = project_memories + general_memories
            logger.info(
                "Total %d memories retrieved for user %s (project: %d, general: %d)",
                len(combined_memories),
                user_id,
                len(project_memories),
                len(general_memories),
            )

            return combined_memories

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
        messages: List[Dict[str, Any]],
        workspace_id: Optional[str] = None,
        project_id: Optional[str] = None,
        is_group_chat: bool = False,
    ) -> None:
        """Store user messages with conversation context in memory (fire-and-forget).

        This method is called after user subtask is created.
        Runs in background, doesn't block main flow.

        Messages should include recent conversation context (e.g., 2 history + 1 current)
        to provide better context for memory generation. Each message can be:
        - {"role": "user", "content": "text"} for user messages
        - {"role": "assistant", "content": "text"} for AI responses

        For group chat, messages should already have sender names prefixed.

        Args:
            user_id: User ID
            team_id: Team/Agent ID
            task_id: Task ID (for deletion)
            subtask_id: Subtask ID (traceability)
            messages: List of messages with conversation context (mem0 format)
            workspace_id: Optional workspace ID (for Code tasks)
            project_id: Optional project ID for group conversations
            is_group_chat: Whether this is a group chat

        Example:
            asyncio.create_task(
                manager.save_user_message_async(
                    user_id="123",
                    team_id="456",
                    task_id="789",
                    subtask_id="1011",
                    messages=[
                        {"role": "user", "content": "User[Alice]: What's the weather?"},
                        {"role": "assistant", "content": "It's sunny today."},
                        {"role": "user", "content": "User[Alice]: I prefer Python for backend"}
                    ],
                    project_id="proj-123"
                )
            )
        """
        if not self.is_enabled:
            return

        try:
            # Build prefixed user_id for resource isolation
            prefixed_user_id = self._get_prefixed_user_id(user_id)

            # Build metadata (created_at is managed by mem0 automatically)
            metadata = MemoryMetadata(
                task_id=task_id,
                subtask_id=subtask_id,
                team_id=team_id,
                workspace_id=workspace_id,
                project_id=project_id,
                is_group_chat=is_group_chat,
            )

            # Call mem0 API with context messages
            result = await self._client.add_memory(
                user_id=prefixed_user_id,
                messages=messages,
                metadata=metadata.model_dump(),
            )

            if result:
                # mem0 returns {"results": [{"id": ..., "memory": ..., "event": ...}]}
                memory_count = 0
                memory_texts: List[str] = []
                if isinstance(result, dict) and "results" in result:
                    results_list = result.get("results", [])
                    memory_count = len(results_list)
                    # Extract memory texts for domain detection
                    for mem_result in results_list:
                        if isinstance(mem_result, dict) and "memory" in mem_result:
                            memory_texts.append(mem_result["memory"])
                logger.info(
                    "Stored %d memories for user %s, task %s, subtask %s, project %s (from %d context messages)",
                    memory_count,
                    user_id,
                    task_id,
                    subtask_id,
                    project_id or "None",
                    len(messages),
                )

                # Publish event for pet experience update (decoupled from pet module)
                if memory_count > 0:
                    from app.core.events import MemoryCreatedEvent, get_event_bus

                    await get_event_bus().publish(
                        MemoryCreatedEvent(
                            user_id=int(user_id),
                            memory_count=memory_count,
                            memory_texts=memory_texts,
                        )
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
            # Build prefixed user_id for resource isolation
            prefixed_user_id = self._get_prefixed_user_id(user_id)

            total_delete_count = 0
            total_error_count = 0
            consecutive_no_progress = 0
            max_no_progress_attempts = 3

            # Keep searching until no more memories are found
            while True:
                # Step 1: Search memories with this task_id using metadata filter
                # Note: search_memories requires a query, we use "*" as a wildcard
                search_result = await self._client.search_memories(
                    user_id=prefixed_user_id,
                    query="*",
                    filters={"task_id": task_id},
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
