# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executor streaming service for incremental callback processing.

This module handles incremental chunk callbacks from executors (ClaudeCode, Agno),
reusing the same streaming patterns as Chat-Shell for consistent real-time updates.

Key responsibilities:
- Process different chunk types (content, thinking, reasoning, workbench_delta, status)
- Cache content in Redis for fast recovery (every 1s)
- Broadcast updates via WebSocket to connected clients
- Periodically persist to database (every 3s)
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings

logger = logging.getLogger(__name__)


# Redis key patterns for executor streaming
EXECUTOR_STREAMING_KEY_PREFIX = "executor:streaming:"  # executor:streaming:{subtask_id}
EXECUTOR_THINKING_KEY_PREFIX = "executor:thinking:"  # executor:thinking:{subtask_id}
EXECUTOR_WORKBENCH_KEY_PREFIX = "executor:workbench:"  # executor:workbench:{subtask_id}
EXECUTOR_REASONING_KEY_PREFIX = "executor:reasoning:"  # executor:reasoning:{subtask_id}

# Default TTL for streaming cache (5 minutes)
EXECUTOR_STREAMING_TTL = 300


@dataclass
class ExecutorStreamingState:
    """State container for executor streaming session.

    Tracks accumulated content, thinking steps, workbench state, and timing
    for periodic saves.
    """

    task_id: int
    subtask_id: int
    executor_name: Optional[str] = None

    # Accumulated content
    full_content: str = ""
    offset: int = 0
    reasoning_content: str = ""
    reasoning_offset: int = 0
    thinking: list[Dict[str, Any]] = field(default_factory=list)
    workbench: Dict[str, Any] = field(default_factory=dict)

    # Timing for periodic saves
    last_redis_save: float = 0.0
    last_db_save: float = 0.0

    def append_content(self, content: str) -> None:
        """Append content to accumulated response."""
        self.full_content += content
        self.offset += len(content)

    def append_reasoning(self, content: str) -> None:
        """Append reasoning content."""
        self.reasoning_content += content
        self.reasoning_offset += len(content)

    def update_thinking_step(self, step: Dict[str, Any], step_index: int) -> None:
        """Update or append a thinking step by index."""
        if step_index < len(self.thinking):
            # Update existing step
            self.thinking[step_index].update(step)
        else:
            # Append new step
            self.thinking.append(step)

    def apply_workbench_delta(self, delta: Dict[str, Any]) -> None:
        """Apply workbench delta/patch updates.

        Supports:
        - file_changes: add/remove file change entries
        - git_info: merge git info updates
        - status: direct status override
        - error: direct error override
        """
        # Handle file_changes delta
        file_changes = delta.get("file_changes")
        if file_changes:
            current_files = self.workbench.setdefault("file_changes", [])
            # Add new file changes
            files_to_add = file_changes.get("add", [])
            for file_change in files_to_add:
                current_files.append(file_change)
            # Remove file changes (by path)
            files_to_remove = file_changes.get("remove", [])
            paths_to_remove = {f.get("path") for f in files_to_remove}
            self.workbench["file_changes"] = [
                f for f in current_files if f.get("path") not in paths_to_remove
            ]

        # Handle git_info delta
        git_info = delta.get("git_info")
        if git_info:
            current_git = self.workbench.setdefault("git_info", {})
            # Handle task_commits add/remove
            commits_delta = git_info.get("task_commits")
            if commits_delta:
                current_commits = current_git.setdefault("task_commits", [])
                commits_to_add = commits_delta.get("add", [])
                for commit in commits_to_add:
                    current_commits.append(commit)
            # Merge other git_info fields
            for key, value in git_info.items():
                if key != "task_commits":
                    current_git[key] = value

        # Handle direct status/error overrides
        if "status" in delta:
            self.workbench["status"] = delta["status"]
        if "error" in delta:
            self.workbench["error"] = delta["error"]


class ExecutorStreamingService:
    """Service for processing executor incremental callbacks.

    Manages streaming state for multiple concurrent executor sessions,
    handling Redis caching, WebSocket broadcasting, and periodic DB persistence.
    """

    def __init__(self):
        self._states: Dict[int, ExecutorStreamingState] = {}  # subtask_id -> state
        self._lock = asyncio.Lock()

        # Configuration (using same intervals as Chat-Shell)
        self._redis_save_interval = getattr(
            settings, "STREAMING_REDIS_SAVE_INTERVAL", 1.0
        )
        self._db_save_interval = getattr(settings, "STREAMING_DB_SAVE_INTERVAL", 3.0)

    def _get_or_create_state(
        self,
        task_id: int,
        subtask_id: int,
        executor_name: Optional[str] = None,
    ) -> ExecutorStreamingState:
        """Get existing state or create new one for subtask."""
        if subtask_id not in self._states:
            self._states[subtask_id] = ExecutorStreamingState(
                task_id=task_id,
                subtask_id=subtask_id,
                executor_name=executor_name,
            )
        return self._states[subtask_id]

    def _cleanup_state(self, subtask_id: int) -> None:
        """Clean up state for completed subtask."""
        if subtask_id in self._states:
            del self._states[subtask_id]

    async def process_chunk(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        chunk_type: str,
        data: Dict[str, Any],
        executor_name: Optional[str] = None,
        timestamp: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Process an incremental chunk callback.

        Args:
            db: Database session
            task_id: Task ID
            subtask_id: Subtask ID
            chunk_type: Type of chunk (chunk, thinking, reasoning, workbench_delta, status)
            data: Chunk data payload
            executor_name: Optional executor name
            timestamp: Optional ISO timestamp

        Returns:
            Processing result dict
        """
        async with self._lock:
            state = self._get_or_create_state(task_id, subtask_id, executor_name)

        try:
            # Process based on chunk type
            if chunk_type == "chunk":
                await self._process_content_chunk(state, data)
            elif chunk_type == "thinking":
                await self._process_thinking_chunk(state, data)
            elif chunk_type == "reasoning":
                await self._process_reasoning_chunk(state, data)
            elif chunk_type == "workbench_delta":
                await self._process_workbench_delta(state, data)
            elif chunk_type == "status":
                await self._process_status_chunk(db, state, data)
            else:
                logger.warning(f"Unknown chunk type: {chunk_type}")

            # Perform periodic saves
            await self._periodic_save(db, state)

            return {"status": "success", "offset": state.offset}

        except Exception as e:
            logger.error(f"Error processing chunk: {e}", exc_info=True)
            return {"status": "error", "message": str(e)}

    async def _process_content_chunk(
        self, state: ExecutorStreamingState, data: Dict[str, Any]
    ) -> None:
        """Process content chunk - append text and emit WebSocket event."""
        content = data.get("content", "")
        if not content:
            return

        state.append_content(content)

        # Emit WebSocket chunk event
        await self._emit_chunk_event(
            state.task_id,
            state.subtask_id,
            content,
            state.offset,
            result=None,  # Don't include full result in every chunk
        )

    async def _process_thinking_chunk(
        self, state: ExecutorStreamingState, data: Dict[str, Any]
    ) -> None:
        """Process thinking step chunk."""
        step = data.get("step", {})
        step_index = data.get("step_index", len(state.thinking))

        state.update_thinking_step(step, step_index)

        # Emit WebSocket chunk event with thinking update
        await self._emit_chunk_event(
            state.task_id,
            state.subtask_id,
            "",  # No content change
            state.offset,
            result={"thinking": state.thinking},
        )

    async def _process_reasoning_chunk(
        self, state: ExecutorStreamingState, data: Dict[str, Any]
    ) -> None:
        """Process reasoning content chunk (DeepSeek R1)."""
        content = data.get("content", "")
        if not content:
            return

        state.append_reasoning(content)

        # Emit WebSocket chunk event with reasoning update
        await self._emit_chunk_event(
            state.task_id,
            state.subtask_id,
            "",  # No main content change
            state.offset,
            result={
                "reasoning_content": state.reasoning_content,
                "reasoning_chunk": content,
            },
        )

    async def _process_workbench_delta(
        self, state: ExecutorStreamingState, data: Dict[str, Any]
    ) -> None:
        """Process workbench delta/patch update."""
        delta = data.get("delta", {})
        if not delta:
            return

        state.apply_workbench_delta(delta)

        # Emit WebSocket chunk event with workbench update
        await self._emit_chunk_event(
            state.task_id,
            state.subtask_id,
            "",  # No content change
            state.offset,
            result={"workbench": state.workbench},
        )

    async def _process_status_chunk(
        self, db: Session, state: ExecutorStreamingState, data: Dict[str, Any]
    ) -> None:
        """Process status update chunk."""
        status = data.get("status", "").upper()
        progress = data.get("progress", 0)
        error_message = data.get("error_message")

        # Terminal statuses trigger cleanup
        if status in ("COMPLETED", "FAILED", "CANCELLED"):
            # Build final result
            result = self._build_result(state)
            if error_message:
                result["error"] = error_message

            # Emit done event
            await self._emit_done_event(
                state.task_id,
                state.subtask_id,
                state.offset,
                result,
            )

            # Final DB save
            await self._save_to_db(db, state, status, error_message)

            # Clean up Redis cache
            await self._cleanup_redis(state.subtask_id)

            # Clean up state
            async with self._lock:
                self._cleanup_state(state.subtask_id)

    async def _periodic_save(self, db: Session, state: ExecutorStreamingState) -> None:
        """Perform periodic saves to Redis and DB."""
        current_time = time.time()

        # Save to Redis (every 1s)
        if current_time - state.last_redis_save >= self._redis_save_interval:
            await self._save_to_redis(state)
            state.last_redis_save = current_time

        # Save to DB (every 3s)
        if current_time - state.last_db_save >= self._db_save_interval:
            await self._save_to_db(db, state, "RUNNING")
            state.last_db_save = current_time

    async def _save_to_redis(self, state: ExecutorStreamingState) -> None:
        """Save streaming state to Redis for fast recovery."""
        try:
            # Save content
            content_key = f"{EXECUTOR_STREAMING_KEY_PREFIX}{state.subtask_id}"
            await cache_manager.set(
                content_key, state.full_content, expire=EXECUTOR_STREAMING_TTL
            )

            # Save thinking if present
            if state.thinking:
                thinking_key = f"{EXECUTOR_THINKING_KEY_PREFIX}{state.subtask_id}"
                await cache_manager.set(
                    thinking_key, state.thinking, expire=EXECUTOR_STREAMING_TTL
                )

            # Save workbench if present
            if state.workbench:
                workbench_key = f"{EXECUTOR_WORKBENCH_KEY_PREFIX}{state.subtask_id}"
                await cache_manager.set(
                    workbench_key, state.workbench, expire=EXECUTOR_STREAMING_TTL
                )

            # Save reasoning if present
            if state.reasoning_content:
                reasoning_key = f"{EXECUTOR_REASONING_KEY_PREFIX}{state.subtask_id}"
                await cache_manager.set(
                    reasoning_key, state.reasoning_content, expire=EXECUTOR_STREAMING_TTL
                )

            logger.debug(f"Saved executor streaming state to Redis: {state.subtask_id}")

        except Exception as e:
            logger.error(f"Failed to save to Redis: {e}")

    async def _save_to_db(
        self,
        db: Session,
        state: ExecutorStreamingState,
        status: str,
        error_message: Optional[str] = None,
    ) -> None:
        """Save streaming state to database."""
        try:
            from app.models.subtask import Subtask, SubtaskStatus

            subtask = db.get(Subtask, state.subtask_id)
            if not subtask:
                logger.warning(f"Subtask not found: {state.subtask_id}")
                return

            # Build result
            result = self._build_result(state)
            if status != "RUNNING":
                result["streaming"] = False
            else:
                result["streaming"] = True

            # Update subtask
            subtask.status = SubtaskStatus(status)
            subtask.result = result
            if error_message:
                subtask.error_message = error_message

            db.commit()
            logger.debug(f"Saved executor streaming state to DB: {state.subtask_id}")

        except Exception as e:
            logger.error(f"Failed to save to DB: {e}")
            db.rollback()

    async def _cleanup_redis(self, subtask_id: int) -> None:
        """Clean up Redis cache for completed subtask."""
        try:
            keys = [
                f"{EXECUTOR_STREAMING_KEY_PREFIX}{subtask_id}",
                f"{EXECUTOR_THINKING_KEY_PREFIX}{subtask_id}",
                f"{EXECUTOR_WORKBENCH_KEY_PREFIX}{subtask_id}",
                f"{EXECUTOR_REASONING_KEY_PREFIX}{subtask_id}",
            ]
            for key in keys:
                await cache_manager.delete(key)
            logger.debug(f"Cleaned up Redis cache for subtask: {subtask_id}")
        except Exception as e:
            logger.error(f"Failed to cleanup Redis: {e}")

    def _build_result(self, state: ExecutorStreamingState) -> Dict[str, Any]:
        """Build result dict from current state."""
        result: Dict[str, Any] = {
            "value": state.full_content,
        }
        if state.thinking:
            result["thinking"] = state.thinking
        if state.workbench:
            result["workbench"] = state.workbench
        if state.reasoning_content:
            result["reasoning_content"] = state.reasoning_content
        return result

    async def _emit_chunk_event(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Emit WebSocket chat:chunk event."""
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            emitter = get_ws_emitter()
            if emitter:
                await emitter.emit_chat_chunk(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=content,
                    offset=offset,
                    result=result,
                )
            else:
                logger.debug("WebSocket emitter not available")
        except Exception as e:
            logger.error(f"Failed to emit chunk event: {e}")

    async def _emit_done_event(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Dict[str, Any],
    ) -> None:
        """Emit WebSocket chat:done event."""
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            emitter = get_ws_emitter()
            if emitter:
                await emitter.emit_chat_done(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    offset=offset,
                    result=result,
                )
            else:
                logger.debug("WebSocket emitter not available")
        except Exception as e:
            logger.error(f"Failed to emit done event: {e}")


# Global service instance
executor_streaming_service = ExecutorStreamingService()
