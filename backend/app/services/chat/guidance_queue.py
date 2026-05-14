# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Redis-backed FIFO queue for Chat Shell guidance."""

import json
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional

from app.core.cache import cache_manager

DEFAULT_GUIDANCE_QUEUE_TTL_SECONDS = 60 * 60 * 24


@dataclass
class GuidanceQueueItem:
    """A queued user guidance item for a running Chat Shell turn."""

    task_id: int
    subtask_id: int
    team_id: int
    user_id: int
    guidance_id: str
    message: str
    created_at: str

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "GuidanceQueueItem":
        """Create from dictionary."""
        return cls(
            task_id=int(data.get("task_id", 0)),
            subtask_id=int(data.get("subtask_id", 0)),
            team_id=int(data.get("team_id", 0)),
            user_id=int(data.get("user_id", 0)),
            guidance_id=str(data.get("guidance_id", "")),
            message=str(data.get("message", "")),
            created_at=str(data.get("created_at", "")),
        )


class GuidanceQueue:
    """Redis FIFO queue keyed by task and subtask."""

    def __init__(self, ttl_seconds: int = DEFAULT_GUIDANCE_QUEUE_TTL_SECONDS):
        self.ttl_seconds = ttl_seconds
        self._cache = cache_manager

    @staticmethod
    def key(task_id: int, subtask_id: int) -> str:
        """Return the Redis list key for a Chat Shell subtask."""
        return f"chat:guidance:{task_id}:{subtask_id}"

    async def enqueue(
        self,
        *,
        task_id: int,
        subtask_id: int,
        team_id: int,
        user_id: int,
        message: str,
        guidance_id: Optional[str] = None,
    ) -> GuidanceQueueItem:
        """Append a guidance item to the queue."""
        item = GuidanceQueueItem(
            task_id=task_id,
            subtask_id=subtask_id,
            team_id=team_id,
            user_id=user_id,
            guidance_id=guidance_id or f"guidance-{uuid.uuid4().hex}",
            message=message,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        key = self.key(task_id, subtask_id)
        client = await self._cache._get_client()
        try:
            await client.rpush(key, json.dumps(item.to_dict()).encode("utf-8"))
            await client.expire(key, self.ttl_seconds)
        finally:
            await client.aclose()
        return item

    async def consume(
        self, *, task_id: int, subtask_id: int
    ) -> Optional[GuidanceQueueItem]:
        """Pop the oldest guidance item, if any."""
        client = await self._cache._get_client()
        try:
            raw = await client.lpop(self.key(task_id, subtask_id))
        finally:
            await client.aclose()
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return GuidanceQueueItem.from_dict(json.loads(raw))

    async def expire(self, *, task_id: int, subtask_id: int) -> list[str]:
        """Delete pending guidance and return expired guidance IDs."""
        key = self.key(task_id, subtask_id)
        client = await self._cache._get_client()
        try:
            raw_items = await client.lrange(key, 0, -1)
            await client.delete(key)
        finally:
            await client.aclose()

        expired_ids: list[str] = []
        for raw in raw_items:
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            data = json.loads(raw)
            guidance_id = data.get("guidance_id")
            if guidance_id:
                expired_ids.append(str(guidance_id))
        return expired_ids


guidance_queue = GuidanceQueue()
