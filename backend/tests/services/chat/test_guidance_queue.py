import json

import pytest
from pydantic import ValidationError

from app.api.ws.events import ChatGuidePayload
from app.core.constants import MAX_GUIDANCE_ID_LENGTH, MAX_GUIDANCE_MESSAGE_LENGTH
from app.services.chat.guidance_queue import (
    GuidanceQueue,
    GuidanceQueueFullError,
    GuidanceQueueItem,
)


class FakeRedis:
    def __init__(self) -> None:
        self.lists: dict[str, list[bytes]] = {}
        self.expirations: dict[str, int] = {}
        self.closed = False

    async def rpush(self, key: str, value: bytes) -> int:
        self.lists.setdefault(key, []).append(value)
        return len(self.lists[key])

    async def eval(self, script: str, num_keys: int, key: str, *args):
        del script
        assert num_keys == 1
        max_items, value, ttl_seconds = args
        values = self.lists.setdefault(key, [])
        if len(values) >= int(max_items):
            return 0
        values.append(value)
        self.expirations[key] = int(ttl_seconds)
        return 1

    async def lpop(self, key: str):
        values = self.lists.get(key, [])
        if not values:
            return None
        return values.pop(0)

    async def lrange(self, key: str, start: int, end: int):
        values = self.lists.get(key, [])
        if end == -1:
            return values[start:]
        return values[start : end + 1]

    async def delete(self, key: str) -> int:
        existed = key in self.lists
        self.lists.pop(key, None)
        return int(existed)

    async def expire(self, key: str, seconds: int) -> bool:
        self.expirations[key] = seconds
        return True

    async def aclose(self) -> None:
        self.closed = True


def test_chat_guidance_payload_has_a_finite_message_size() -> None:
    with pytest.raises(ValidationError):
        ChatGuidePayload(
            task_id=1,
            subtask_id=2,
            team_id=3,
            message="x" * (MAX_GUIDANCE_MESSAGE_LENGTH + 1),
        )


def test_chat_guidance_payload_has_a_finite_correlation_id() -> None:
    with pytest.raises(ValidationError):
        ChatGuidePayload(
            task_id=1,
            subtask_id=2,
            team_id=3,
            message="guide",
            client_guidance_id="x" * (MAX_GUIDANCE_ID_LENGTH + 1),
        )


@pytest.mark.asyncio
async def test_guidance_queue_consumes_fifo(monkeypatch) -> None:
    redis = FakeRedis()
    queue = GuidanceQueue(ttl_seconds=60)

    async def get_client():
        return redis

    monkeypatch.setattr(queue._cache, "_get_client", get_client)

    first = await queue.enqueue(
        task_id=1,
        subtask_id=2,
        team_id=3,
        user_id=4,
        message="first",
        guidance_id="g1",
    )
    second = await queue.enqueue(
        task_id=1,
        subtask_id=2,
        team_id=3,
        user_id=4,
        message="second",
        guidance_id="g2",
    )

    assert first.guidance_id == "g1"
    assert second.guidance_id == "g2"
    assert redis.expirations["chat:guidance:1:2"] == 60

    consumed_first = await queue.consume(task_id=1, subtask_id=2)
    consumed_second = await queue.consume(task_id=1, subtask_id=2)

    assert consumed_first is not None
    assert consumed_first.message == "first"
    assert consumed_second is not None
    assert consumed_second.message == "second"
    assert await queue.consume(task_id=1, subtask_id=2) is None


@pytest.mark.asyncio
async def test_guidance_queue_expire_returns_ids(monkeypatch) -> None:
    redis = FakeRedis()
    queue = GuidanceQueue(ttl_seconds=60)

    async def get_client():
        return redis

    monkeypatch.setattr(queue._cache, "_get_client", get_client)
    key = queue.key(task_id=1, subtask_id=2)
    redis.lists[key] = [
        json.dumps(
            GuidanceQueueItem(
                task_id=1,
                subtask_id=2,
                team_id=3,
                user_id=4,
                guidance_id="g1",
                message="first",
                created_at="now",
            ).to_dict()
        ).encode(),
        json.dumps({"guidance_id": "g2"}).encode(),
    ]

    expired_ids = await queue.expire(task_id=1, subtask_id=2)

    assert expired_ids == ["g1", "g2"]
    assert key not in redis.lists


@pytest.mark.asyncio
async def test_guidance_queue_atomically_rejects_items_above_capacity(
    monkeypatch,
) -> None:
    redis = FakeRedis()
    queue = GuidanceQueue(ttl_seconds=60, max_items=2)

    async def get_client():
        return redis

    monkeypatch.setattr(queue._cache, "_get_client", get_client)
    for guidance_id in ("g1", "g2"):
        await queue.enqueue(
            task_id=1,
            subtask_id=2,
            team_id=3,
            user_id=4,
            message=guidance_id,
            guidance_id=guidance_id,
        )

    with pytest.raises(GuidanceQueueFullError, match="2 pending items"):
        await queue.enqueue(
            task_id=1,
            subtask_id=2,
            team_id=3,
            user_id=4,
            message="third",
            guidance_id="g3",
        )

    assert len(redis.lists[queue.key(1, 2)]) == 2
