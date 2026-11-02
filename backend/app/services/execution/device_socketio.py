# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cross-process Socket.IO dispatch for device execution."""

import asyncio
import json
import uuid
from typing import Any

import redis

from app.core.config import settings

_REDIS_PUBLISH_TIMEOUT_SECONDS = 1.0


async def publish_device_execution(
    *,
    event: str,
    namespace: str,
    room: str,
    payload: dict[str, Any],
) -> None:
    """Publish without blocking the application's event loop on Redis I/O."""

    def _publish() -> None:
        client = redis.from_url(
            settings.REDIS_URL,
            decode_responses=False,
            socket_timeout=_REDIS_PUBLISH_TIMEOUT_SECONDS,
            socket_connect_timeout=_REDIS_PUBLISH_TIMEOUT_SECONDS,
        )
        try:
            message = {
                "method": "emit",
                "event": event,
                "data": [payload],
                "namespace": namespace,
                "room": room,
                "host_id": uuid.uuid4().hex,
            }
            client.publish("socketio", json.dumps(message))
        finally:
            client.close()

    await asyncio.wait_for(
        asyncio.to_thread(_publish),
        timeout=_REDIS_PUBLISH_TIMEOUT_SECONDS + 0.5,
    )
