# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executor-local in-memory runtime stream cache."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

from shared.models import RuntimeStreamAccumulator

logger = logging.getLogger(__name__)

ACTIVE_STREAM_CACHE_IDLE_TTL_SECONDS = 3600
TERMINAL_STREAM_CACHE_TTL_SECONDS = 600


class RuntimeStreamCache:
    """In-memory cache for active executor stream snapshots."""

    def __init__(
        self,
        *,
        active_idle_ttl_seconds: int = ACTIVE_STREAM_CACHE_IDLE_TTL_SECONDS,
        terminal_ttl_seconds: int = TERMINAL_STREAM_CACHE_TTL_SECONDS,
    ) -> None:
        self._active_idle_ttl_seconds = active_idle_ttl_seconds
        self._terminal_ttl_seconds = terminal_ttl_seconds
        self._entries: dict[int, RuntimeStreamAccumulator] = {}
        self._lock = asyncio.Lock()

    async def record_event(
        self,
        *,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: Optional[dict[str, Any]] = None,
    ) -> None:
        """Record one streaming event into the in-memory snapshot."""

        async with self._lock:
            now = time.time()
            self._cleanup_expired_locked(now)
            accumulator = self._entries.get(subtask_id)
            if accumulator is None:
                accumulator = RuntimeStreamAccumulator(
                    task_id=task_id,
                    subtask_id=subtask_id,
                )
                self._entries[subtask_id] = accumulator

            accumulator.apply_event(event_type, data or {})

    async def get_snapshot(self, subtask_id: int) -> Optional[dict[str, Any]]:
        """Return a serialized snapshot for a subtask if still cached."""

        async with self._lock:
            self._cleanup_expired_locked(time.time())
            accumulator = self._entries.get(subtask_id)
            if accumulator is None:
                return None
            return accumulator.to_snapshot().to_dict()

    async def cleanup(self, subtask_id: int) -> bool:
        """Remove a cached subtask snapshot."""

        async with self._lock:
            return self._entries.pop(subtask_id, None) is not None

    async def stats(self) -> dict[str, Any]:
        """Return lightweight cache diagnostics."""

        async with self._lock:
            self._cleanup_expired_locked(time.time())
            terminal_count = sum(
                1
                for accumulator in self._entries.values()
                if accumulator.snapshot.terminal
            )
            return {
                "entry_count": len(self._entries),
                "terminal_entry_count": terminal_count,
                "active_idle_ttl_seconds": self._active_idle_ttl_seconds,
                "terminal_ttl_seconds": self._terminal_ttl_seconds,
            }

    def _cleanup_expired_locked(self, now: float) -> None:
        expired_subtask_ids: list[int] = []
        for subtask_id, accumulator in self._entries.items():
            snapshot = accumulator.snapshot
            ttl = (
                self._terminal_ttl_seconds
                if snapshot.terminal
                else self._active_idle_ttl_seconds
            )
            if now - snapshot.last_activity_at > ttl:
                expired_subtask_ids.append(subtask_id)

        for subtask_id in expired_subtask_ids:
            self._entries.pop(subtask_id, None)

        if expired_subtask_ids:
            logger.info(
                "[RuntimeStreamCache] Evicted %d expired snapshots",
                len(expired_subtask_ids),
            )


runtime_stream_cache = RuntimeStreamCache()


def runtime_stream_cache_transport_kwargs() -> dict[str, Any]:
    """Build common transport kwargs for executor runtime stream caching."""

    return {
        "runtime_cache": runtime_stream_cache,
    }
