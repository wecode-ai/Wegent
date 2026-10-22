# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared delivery receipts for replayable runtime terminal notifications."""

import hashlib
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator

from redis.asyncio import Redis

from app.core.cache import cache_manager
from app.services.im.session_service import im_session_service

DELIVERY_LOCK_SECONDS = 120


def runtime_notification_id(payload: dict[str, Any], status: str) -> str | None:
    """Identify a turn independently of process-local event sequence numbers."""

    data = payload.get("data")
    data = data if isinstance(data, dict) else {}
    response = data.get("response")
    response = response if isinstance(response, dict) else {}
    turn_id = (
        data.get("turnId")
        or data.get("turn_id")
        or payload.get("turnId")
        or payload.get("turn_id")
        or payload.get("subtaskId")
        or payload.get("subtask_id")
        or response.get("id")
    )
    updated_at = payload.get("updatedAt") or payload.get("updated_at")
    if turn_id:
        identity = f"turn:{turn_id}"
    elif updated_at:
        identity = f"updated:{updated_at}"
    else:
        # Older events without a turn or update identity cannot be deduplicated
        # by content: distinct turns may legitimately return identical replies.
        return None
    normalized_status = status.strip().lower()
    normalized_status = {
        "done": "completed",
        "success": "completed",
        "error": "failed",
        "canceled": "cancelled",
    }.get(normalized_status, normalized_status)
    return f"{identity}:{normalized_status}"


@dataclass
class RuntimeNotificationReceipt:
    client: Redis
    key: str

    async def record_sent(self) -> None:
        # Successful receipts do not expire: reopening an old task must not
        # turn its already-delivered completion into a new notification.
        await self.client.set(self.key, b"sent")


@asynccontextmanager
async def claim_runtime_notification(
    *,
    user_id: int,
    address: dict[str, Any],
    session_key: str,
    notification_id: str,
) -> AsyncIterator[RuntimeNotificationReceipt | None]:
    """Serialize one recipient's delivery and retain successful receipts."""

    identity = json.dumps(
        [
            user_id,
            im_session_service.runtime_task_notification_key(address),
            session_key,
            notification_id,
        ],
        ensure_ascii=True,
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    key = f"channel:runtime_notification_receipt:{digest}"
    async with cache_manager._client_context() as client:
        lock = client.lock(f"{key}:lock", timeout=DELIVERY_LOCK_SECONDS, blocking=False)
        acquired = await lock.acquire()
        if not acquired:
            yield None
            return
        try:
            if await client.get(key):
                yield None
                return
            yield RuntimeNotificationReceipt(client, key)
        finally:
            if await lock.owned():
                await lock.release()
