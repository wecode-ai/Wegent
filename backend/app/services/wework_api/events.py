# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Ephemeral native event fanout across Backend workers; no stored state."""

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from app.core.cache import cache_manager


def channel(user_id: int, device_id: str, task_id: str) -> str:
    identity = json.dumps([user_id, device_id, task_id], separators=(",", ":"))
    return "wework-api:live:" + hashlib.sha256(identity.encode()).hexdigest()


async def publish_runtime_event(user_id: int, device_id: str, envelope: dict) -> None:
    payload = envelope.get("payload") or {}
    data = payload.get("data") or {}
    task_id = payload.get("taskId") or (
        data.get("taskId") if isinstance(data, dict) else None
    )
    if not task_id:
        return
    client = await cache_manager._get_client()
    try:
        await client.publish(
            channel(user_id, device_id, str(task_id)), json.dumps(envelope)
        )
    finally:
        await client.aclose()


@dataclass
class Subscription:
    client: Any
    pubsub: Any

    async def receive(self) -> dict | None:
        message = await self.pubsub.get_message(
            ignore_subscribe_messages=True, timeout=1.0
        )
        if message is None or message.get("type") != "message":
            return None
        return json.loads(message["data"])

    async def close(self) -> None:
        try:
            await self.pubsub.aclose()
        finally:
            await self.client.aclose()


async def subscribe(user_id: int, device_id: str, task_id: str) -> Subscription:
    client = await cache_manager._get_client()
    pubsub = client.pubsub()
    try:
        await pubsub.subscribe(channel(user_id, device_id, task_id))
        # Consume the subscribe acknowledgement before dispatching the task.
        # Sending SUBSCRIBE alone does not guarantee the server registered it.
        message = await pubsub.get_message(timeout=5.0)
        if message is None or message.get("type") != "subscribe":
            raise RuntimeError("Runtime stream subscription was not acknowledged")
    except BaseException:
        await pubsub.aclose()
        await client.aclose()
        raise
    return Subscription(client, pubsub)
