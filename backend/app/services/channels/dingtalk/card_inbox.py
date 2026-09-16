# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Durable receipt of card actions before acknowledging the Stream callback."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal

from pydantic import BaseModel
from redis.asyncio.lock import Lock

from app.core.cache import cache_manager
from app.services.channels.dingtalk.card_binding import CARD_BINDING_TTL, CardBinding

logger = logging.getLogger(__name__)

ENQUEUE = """
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], 'pending')
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
return 1
"""

SETTLE = """
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
"""


class CardActionRecord(BaseModel):
    binding: CardBinding
    track_id: str
    event_id: str
    text: str
    image_urls: list[str]
    actor_staff_id: str | None = None
    state: Literal["pending", "running", "completed", "failed", "uncertain"] = "pending"


class CardActionInbox:
    """Keep outstanding receipts until settled; terminal deduplication lasts 7 days.

    A crashed running action is not automatically replayed: creating an AI turn
    is not transactional with Redis. Recovery reports the uncertain outcome.
    """

    def __init__(self, channel_id: int):
        self.channel_id = channel_id
        self.pending_key = f"dingtalk:card_inbox:{channel_id}"

    def event_key(self, event_id: str) -> str:
        return f"dingtalk:card_receipt:{self.channel_id}:{event_id}"

    async def enqueue(self, record: CardActionRecord) -> bool:
        client = await cache_manager._get_client()
        try:
            return bool(
                await client.eval(
                    ENQUEUE,
                    2,
                    self.event_key(record.event_id),
                    self.pending_key,
                    record.event_id,
                    record.model_dump_json(),
                )
            )
        finally:
            await client.aclose()

    async def outstanding(self) -> list[str]:
        client = await cache_manager._get_client()
        try:
            return [
                key.decode() async for key, _ in client.hscan_iter(self.pending_key)
            ]
        finally:
            await client.aclose()

    async def load(self, event_id: str) -> CardActionRecord | None:
        client = await cache_manager._get_client()
        try:
            raw = await client.hget(self.pending_key, event_id)
            return CardActionRecord.model_validate_json(raw) if raw else None
        finally:
            await client.aclose()

    async def save(self, record: CardActionRecord) -> None:
        client = await cache_manager._get_client()
        try:
            await client.hset(
                self.pending_key, record.event_id, record.model_dump_json()
            )
        finally:
            await client.aclose()

    async def settle(self, record: CardActionRecord) -> None:
        client = await cache_manager._get_client()
        try:
            await client.eval(
                SETTLE,
                2,
                self.event_key(record.event_id),
                self.pending_key,
                record.event_id,
                json.dumps({"state": record.state}),
                CARD_BINDING_TTL,
            )
        finally:
            await client.aclose()

    @asynccontextmanager
    async def claim(self, event_id: str) -> AsyncIterator[bool]:
        client = await cache_manager._get_client()
        lock = client.lock(
            f"{self.event_key(event_id)}:lock", timeout=90, blocking=False
        )
        acquired = False
        renewal = None
        try:
            acquired = await lock.acquire()
            if acquired:
                owner = asyncio.current_task()
                assert owner is not None
                renewal = asyncio.create_task(self._renew(lock, owner))
            yield acquired
        finally:
            if renewal:
                renewal.cancel()
                await asyncio.gather(renewal, return_exceptions=True)
            try:
                if acquired and await lock.owned():
                    await lock.release()
            finally:
                await client.aclose()

    async def _renew(self, lock: Lock, owner: asyncio.Task[Any]) -> None:
        try:
            while True:
                await asyncio.sleep(30)
                await lock.extend(90, replace_ttl=True)
        except Exception:
            logger.exception("[DingTalkCard] Lost action lease; stopping dispatch")
            owner.cancel()
