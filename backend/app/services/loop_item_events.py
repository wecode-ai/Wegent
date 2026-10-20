# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Best-effort invalidation events for open Wework Issue projections."""

import asyncio
import logging
from concurrent.futures import Future

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
_LOG_CONTEXT = "project=%s issue=%s version=%s reason=%s recipients=%s"


def publish_loop_item_changed(
    db: Session,
    *,
    item: LoopItem,
    reason: str,
    actor_user_id: int,
) -> None:
    """Notify every known project viewer without coupling persistence to sockets."""

    project_id = str(item.cloud_project_id)
    item_id = str(item.id)
    item_version = int(item.version)
    recipient_ids = {actor_user_id, int(item.created_by_user_id or 0)}
    recipient_ids.update(
        int(value)
        for (value,) in db.query(LoopItemCollaborator.user_id)
        .filter(LoopItemCollaborator.loop_item_id == item_id)
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
            ResourceMember.resource_id == project_id,
            ResourceMember.entity_type == "user",
            ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
        )
        .all()
        if value
    )
    recipient_ids.discard(0)
    log_context = (project_id, item_id, item_version, reason, len(recipient_ids))

    loop = get_socketio_loop()
    skip_cause = None
    if loop is None:
        skip_cause = "loop_unavailable"
    elif loop.is_closed():
        skip_cause = "loop_closed"
    elif not recipient_ids:
        skip_cause = "no_recipients"
    if skip_cause:
        logger.info(
            "[LoopItemInvalidation] skipped " + _LOG_CONTEXT + " cause=%s",
            *log_context,
            skip_cause,
        )
        return

    async def _emit() -> None:
        from app.api.ws.wework_runtime_namespace import (
            WEWORK_RUNTIME_NAMESPACE,
            wework_runtime_user_room,
        )
        from app.core.socketio import get_sio

        payload = {
            "projectId": project_id,
            "itemId": item_id,
            "version": item_version,
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
        future.add_done_callback(
            lambda completed: _log_emit_result(completed, log_context)
        )
    except Exception:
        logger.warning(
            "[LoopItemInvalidation] schedule_failed " + _LOG_CONTEXT,
            *log_context,
            exc_info=True,
        )


def _log_emit_result(
    future: Future[None], context: tuple[str, str, int, str, int]
) -> None:
    try:
        future.result()
    except Exception:
        logger.warning(
            "[LoopItemInvalidation] emit_failed " + _LOG_CONTEXT,
            *context,
            exc_info=True,
        )
    else:
        logger.info("[LoopItemInvalidation] emitted " + _LOG_CONTEXT, *context)
