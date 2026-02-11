# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Blocks collector for mixed content rendering.

Collects tool blocks and text blocks across multiple callback requests
for a single subtask, maintaining the correct order (tool-text-tool-text).

Uses Redis for distributed storage to handle multi-instance deployments
where callback requests may hit different backend instances.

Uses unified block types from shared.models.blocks for consistency.
"""

import json
import logging
from typing import Any, Dict, List, Optional

from shared.models.blocks import BlockStatus, create_text_block, create_tool_block

logger = logging.getLogger(__name__)

# TTL for blocks data in Redis (10 minutes)
BLOCKS_TTL_SECONDS = 600

# Redis key prefix
REDIS_KEY_PREFIX = "subtask_blocks:"


def _get_redis_key(subtask_id: int) -> str:
    """Get Redis key for a subtask's blocks state."""
    return f"{REDIS_KEY_PREFIX}{subtask_id}"


class BlocksCollector:
    """Collector for subtask blocks using Redis for distributed storage.

    Maintains blocks state across multiple HTTP callback requests
    for each subtask, enabling proper mixed content rendering.

    Uses Redis to support multi-instance backend deployments.
    All methods are async to avoid blocking the event loop.
    """

    def __init__(self):
        """Initialize the blocks collector."""
        pass

    async def _get_state(self, subtask_id: int) -> Dict[str, Any]:
        """Get state for a subtask from Redis.

        Args:
            subtask_id: Subtask ID

        Returns:
            State dict with blocks, current_text_block_id, and accumulated_content
        """
        from app.core.cache import cache_manager

        key = _get_redis_key(subtask_id)

        try:
            data = await cache_manager.get(key)
            if data and isinstance(data, dict):
                return data
        except Exception as e:
            logger.warning(
                f"[BlocksCollector] Failed to get state from Redis for subtask {subtask_id}: {e}"
            )

        # Return default state
        return {
            "blocks": [],
            "current_text_block_id": None,
            "accumulated_content": "",
        }

    async def _save_state(self, subtask_id: int, state: Dict[str, Any]) -> None:
        """Save state for a subtask to Redis.

        Args:
            subtask_id: Subtask ID
            state: State dict to save
        """
        from app.core.cache import cache_manager

        key = _get_redis_key(subtask_id)

        try:
            await cache_manager.set(key, state, expire=BLOCKS_TTL_SECONDS)
        except Exception as e:
            logger.warning(
                f"[BlocksCollector] Failed to save state to Redis for subtask {subtask_id}: {e}"
            )

    async def add_tool_block(
        self,
        subtask_id: int,
        tool_use_id: str,
        tool_name: str,
        tool_input: Optional[Dict[str, Any]] = None,
        display_name: Optional[str] = None,
    ) -> None:
        """Add a tool block for a subtask.

        This also finalizes any current text block before adding the tool block.

        Args:
            subtask_id: Subtask ID
            tool_use_id: Tool use ID
            tool_name: Tool name
            tool_input: Tool input parameters
            display_name: Optional display name for the tool
        """
        state = await self._get_state(subtask_id)

        # Finalize current text block before adding tool block
        self._finalize_text_block_in_state(state)

        # Create tool block using unified function
        block = create_tool_block(
            tool_use_id=tool_use_id,
            tool_name=tool_name,
            tool_input=tool_input,
            display_name=display_name,
        )
        state["blocks"].append(block)
        await self._save_state(subtask_id, state)

        logger.info(
            f"[BlocksCollector] Added tool block for subtask {subtask_id}: "
            f"id={block['id']}, tool_name={tool_name}, raw_block={json.dumps(block, ensure_ascii=False)}"
        )

    async def update_tool_block_status(
        self,
        subtask_id: int,
        tool_use_id: str,
        status: str = "done",
        tool_output: Optional[str] = None,
    ) -> None:
        """Update tool block status.

        Args:
            subtask_id: Subtask ID
            tool_use_id: Tool use ID
            status: New status (default: "done")
            tool_output: Optional tool output
        """
        state = await self._get_state(subtask_id)

        for block in state["blocks"]:
            if block.get("type") == "tool" and block.get("tool_use_id") == tool_use_id:
                block["status"] = status
                if tool_output:
                    block["tool_output"] = tool_output
                logger.debug(
                    f"[BlocksCollector] Updated tool block status for subtask {subtask_id}: "
                    f"id={tool_use_id}, status={status}"
                )
                break

        await self._save_state(subtask_id, state)

    async def add_text_content(self, subtask_id: int, content: str) -> None:
        """Add text content to the current text block.

        Creates a new text block if there isn't one currently active.

        Args:
            subtask_id: Subtask ID
            content: Text content to add
        """
        if not content:
            return

        state = await self._get_state(subtask_id)
        state["accumulated_content"] = state.get("accumulated_content", "") + content

        current_text_block_id = state.get("current_text_block_id")

        if current_text_block_id:
            # Update existing text block
            for block in state["blocks"]:
                if block.get("id") == current_text_block_id:
                    block["content"] = block.get("content", "") + content
                    break
        else:
            # Create new text block using unified function
            block = create_text_block(content=content)
            state["current_text_block_id"] = block["id"]
            state["blocks"].append(block)
            logger.info(
                f"[BlocksCollector] Created text block for subtask {subtask_id}: "
                f"id={block['id']}, raw_block={json.dumps(block, ensure_ascii=False)}"
            )

        await self._save_state(subtask_id, state)

    def _finalize_text_block_in_state(self, state: Dict[str, Any]) -> None:
        """Finalize the current text block in state by setting status to done."""
        current_text_block_id = state.get("current_text_block_id")
        if current_text_block_id:
            for block in state["blocks"]:
                if block.get("id") == current_text_block_id:
                    block["status"] = BlockStatus.DONE.value
                    break
            state["current_text_block_id"] = None

    async def finalize_and_get_blocks(self, subtask_id: int) -> List[Dict[str, Any]]:
        """Finalize any pending text block and return all blocks.

        This should be called when the subtask completes (DONE event).

        Args:
            subtask_id: Subtask ID

        Returns:
            List of all blocks for the subtask
        """
        state = await self._get_state(subtask_id)
        self._finalize_text_block_in_state(state)
        await self._save_state(subtask_id, state)

        blocks = state["blocks"]
        logger.info(
            f"[BlocksCollector] Finalized blocks for subtask {subtask_id}: "
            f"count={len(blocks)}, raw_blocks={json.dumps(blocks, ensure_ascii=False)}"
        )
        return blocks

    async def get_accumulated_content(self, subtask_id: int) -> str:
        """Get accumulated content for a subtask.

        Args:
            subtask_id: Subtask ID

        Returns:
            Accumulated content string
        """
        state = await self._get_state(subtask_id)
        return state.get("accumulated_content", "")

    async def cleanup_subtask(self, subtask_id: int) -> None:
        """Clean up state for a completed subtask.

        Args:
            subtask_id: Subtask ID
        """
        from app.core.cache import cache_manager

        key = _get_redis_key(subtask_id)

        try:
            await cache_manager.delete(key)
            logger.debug(f"[BlocksCollector] Cleaned up state for subtask {subtask_id}")
        except Exception as e:
            logger.warning(
                f"[BlocksCollector] Failed to cleanup state from Redis for subtask {subtask_id}: {e}"
            )


# Global singleton instance
_blocks_collector: Optional[BlocksCollector] = None


def get_blocks_collector() -> BlocksCollector:
    """Get the global BlocksCollector instance."""
    global _blocks_collector
    if _blocks_collector is None:
        _blocks_collector = BlocksCollector()
    return _blocks_collector
