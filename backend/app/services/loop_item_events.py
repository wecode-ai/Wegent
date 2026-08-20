# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Best-effort invalidation events for open Wework Issue projections."""

import asyncio
import logging

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, LoopItemCollaborator
from app.models.resource_member import (
    APPROVED_MEMBER_STATUS_VALUES,
    ResourceMember,
)
from app.models.share_link import ResourceType
from app.services.loop_item_executions.wake import get_socketio_loop

logger = logging.getLogger(__name__)

LOOP_ITEM_CHANGED_EVENT = "wework:loop_item:changed"


def publish_loop_item_changed(
    db: Session,
    *,
    item: LoopItem,
    reason: str,
    actor_user_id: int,
) -> None:
    """Notify every known project viewer without coupling persistence to sockets."""

    recipient_ids = {actor_user_id, int(item.created_by_user_id or 0)}
    recipient_ids.update(
        int(value)
        for (value,) in db.query(LoopItemCollaborator.user_id)
        .filter(LoopItemCollaborator.loop_item_id == item.id)
        .all()
        if value
    )
    recipient_ids.update(
        int(value)
        for (value,) in db.query(ResourceMember.user_id)
        .filter(
            ResourceMember.resource_type.in_(
                (ResourceType.CLOUD_PROJECT.value, ResourceType.CLOUD_PROJECT.name)
            ),
            ResourceMember.resource_id == item.cloud_project_id,
            ResourceMember.entity_type == "user",
            ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
        )
        .all()
        if value
    )
    recipient_ids.discard(0)

    loop = get_socketio_loop()
    if loop is None or loop.is_closed() or not recipient_ids:
        return

    async def _emit() -> None:
        from app.api.ws.wework_runtime_namespace import (
            WEWORK_RUNTIME_NAMESPACE,
            wework_runtime_user_room,
        )
        from app.core.socketio import get_sio

        payload = {
            "projectId": str(item.cloud_project_id),
            "itemId": item.id,
            "version": item.version,
            "reason": reason,
        }
        for user_id in recipient_ids:
            await get_sio().emit(
                LOOP_ITEM_CHANGED_EVENT,
                payload,
                room=wework_runtime_user_room(user_id),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )

    try:
        future = asyncio.run_coroutine_threadsafe(_emit(), loop)
        future.add_done_callback(_log_emit_failure)
    except Exception:
        logger.warning(
            "Failed to schedule loop-item invalidation item=%s", item.id, exc_info=True
        )


def _log_emit_failure(future: "asyncio.Future[None]") -> None:
    try:
        future.result()
    except Exception:
        logger.warning("Loop-item invalidation emit failed", exc_info=True)
