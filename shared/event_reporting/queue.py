# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class QueuedEvent:
    event_type: str
    payload: bytes


class ByteBoundedQueue:
    """A drop-newest byte-bounded queue with a non-blocking producer path."""

    def __init__(self, max_bytes: int) -> None:
        self._max_bytes = max_bytes
        self._items: deque[QueuedEvent] = deque()
        self._bytes = 0
        self._in_flight_bytes = 0
        self._lock = threading.Lock()

    def admit(self, max_event_bytes: int) -> str | None:
        """Reserve worst-case space before bounded encoding; never wait for a lock."""
        if not self._lock.acquire(blocking=False):
            return "queue_busy"
        if self._bytes + self._in_flight_bytes + max_event_bytes > self._max_bytes:
            self._lock.release()
            return "queue_full"
        return None

    def finish(self, item: QueuedEvent | None) -> None:
        """Commit or abort an admission and release its lock."""
        try:
            if item is not None:
                self._items.append(item)
                self._bytes += len(item.payload)
        finally:
            self._lock.release()

    def release(self, item: QueuedEvent) -> None:
        """Release sender-owned bytes only when its delivery observation finishes."""
        with self._lock:
            self._in_flight_bytes -= len(item.payload)

    def pop_batch(self, max_items: int) -> list[QueuedEvent]:
        if max_items <= 0:
            return []
        with self._lock:
            items: list[QueuedEvent] = []
            while self._items and len(items) < max_items:
                item = self._items.popleft()
                self._bytes -= len(item.payload)
                self._in_flight_bytes += len(item.payload)
                items.append(item)
            return items

    def discard(self) -> list[QueuedEvent]:
        with self._lock:
            items = list(self._items)
            self._items.clear()
            self._bytes = 0
            return items

    def snapshot(self) -> tuple[int, int]:
        with self._lock:
            return len(self._items), self._bytes
