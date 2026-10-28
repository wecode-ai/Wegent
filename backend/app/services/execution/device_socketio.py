# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cross-process Socket.IO dispatch for device execution."""

import json
import uuid
from typing import Any

import redis

from app.core.config import settings


def publish_device_execution(
    *,
    event: str,
    namespace: str,
    room: str,
    payload: dict[str, Any],
) -> None:
    """Publish from a worker without a competing local Socket.IO listener."""
    client = redis.from_url(settings.REDIS_URL, decode_responses=False)
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
