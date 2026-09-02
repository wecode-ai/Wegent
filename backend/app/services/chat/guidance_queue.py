# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Redis-backed FIFO queue for Chat Shell guidance."""

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from app.core.cache import cache_manager
from app.core.constants import (
    MAX_GUIDANCE_ID_LENGTH,
    MAX_GUIDANCE_MESSAGE_LENGTH,
    MAX_GUIDANCE_QUEUE_ITEMS,
)
from app.core.payload_codec import run_payload_codec

DEFAULT_GUIDANCE_QUEUE_TTL_SECONDS = 60 * 60 * 24
MAX_GUIDANCE_QUEUE_ITEM_BYTES = MAX_GUIDANCE_MESSAGE_LENGTH * 4 + 8 * 1024
_ATOMIC_BOUNDED_PUSH_SCRIPT = """
local current = redis.call('LLEN', KEYS[1])
if current >= tonumber(ARGV[1]) then
    return 0
end
redis.call('RPUSH', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
"""


class GuidanceQueueFullError(RuntimeError):
    """Raised when a subtask already owns the maximum pending guidance."""


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
        return {
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "team_id": self.team_id,
            "user_id": self.user_id,
            "guidance_id": self.guidance_id,
            "message": self.message,
            "created_at": self.created_at,
        }

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

    def __init__(
        self,
        ttl_seconds: int = DEFAULT_GUIDANCE_QUEUE_TTL_SECONDS,
        max_items: int = MAX_GUIDANCE_QUEUE_ITEMS,
    ):
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        if max_items <= 0:
            raise ValueError("max_items must be positive")
        self.ttl_seconds = ttl_seconds
        self.max_items = max_items
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
        if guidance_id is not None and len(guidance_id) > MAX_GUIDANCE_ID_LENGTH:
            raise ValueError(f"guidance_id exceeds {MAX_GUIDANCE_ID_LENGTH} characters")
        item = GuidanceQueueItem(
            task_id=task_id,
            subtask_id=subtask_id,
            team_id=team_id,
            user_id=user_id,
            guidance_id=guidance_id or f"guidance-{uuid.uuid4().hex}",
            message=message,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        encoded_item = await run_payload_codec(
            self._encode_item,
            item,
            payload_hint=item,
            force_offload=True,
        )
        if len(encoded_item) > MAX_GUIDANCE_QUEUE_ITEM_BYTES:
            raise ValueError(
                "Encoded guidance item exceeds "
                f"{MAX_GUIDANCE_QUEUE_ITEM_BYTES} bytes"
            )
        key = self.key(task_id, subtask_id)
        client = await self._cache._get_client()
        try:
            added = await client.eval(
                _ATOMIC_BOUNDED_PUSH_SCRIPT,
                1,
                key,
                self.max_items,
                encoded_item,
                self.ttl_seconds,
            )
        finally:
            await client.aclose()
        if int(added) != 1:
            raise GuidanceQueueFullError(
                f"Guidance queue already contains {self.max_items} pending items"
            )
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
        self._require_bounded_item(raw)
        return await run_payload_codec(
            self._decode_item,
            raw,
            payload_hint=raw,
            force_offload=True,
        )

    async def expire(self, *, task_id: int, subtask_id: int) -> list[str]:
        """Delete pending guidance and return expired guidance IDs."""
        key = self.key(task_id, subtask_id)
        client = await self._cache._get_client()
        try:
            raw_items = await client.lrange(key, 0, -1)
            await client.delete(key)
        finally:
            await client.aclose()

        for raw in raw_items:
            self._require_bounded_item(raw)
        return await run_payload_codec(
            self._decode_expired_ids,
            raw_items,
            payload_hint=raw_items,
            force_offload=True,
        )

    @staticmethod
    def _encode_item(item: GuidanceQueueItem) -> bytes:
        return json.dumps(
            item.to_dict(),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")

    @staticmethod
    def _decode_item(raw: bytes | str) -> GuidanceQueueItem:
        return GuidanceQueueItem.from_dict(json.loads(raw))

    @staticmethod
    def _decode_expired_ids(raw_items: list[bytes | str]) -> list[str]:
        expired_ids: list[str] = []
        for raw in raw_items:
            guidance_id = json.loads(raw).get("guidance_id")
            if guidance_id:
                expired_ids.append(str(guidance_id))
        return expired_ids

    @staticmethod
    def _require_bounded_item(raw: bytes | str) -> None:
        if len(raw) > MAX_GUIDANCE_QUEUE_ITEM_BYTES:
            raise ValueError(
                "Stored guidance item exceeds " f"{MAX_GUIDANCE_QUEUE_ITEM_BYTES} bytes"
            )


guidance_queue = GuidanceQueue()
