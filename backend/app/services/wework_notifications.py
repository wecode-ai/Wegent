"""Commit inbox records with their source mutation, then deliver live hints and IM."""

import logging
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.wework_notification import WeworkNotification
from app.schemas.wework_notification import NotificationCreate
from shared.telemetry.decorators import trace_async, trace_sync

logger = logging.getLogger(__name__)
_PENDING = "wework_notification_ids"


def issue_url(project_id: str, item_id: str | None = None) -> str:
    url = f"wework://boards/{quote(project_id, safe='')}"
    return f"{url}/issues/{quote(item_id, safe='')}" if item_id else url


def create_notification(
    db: Session,
    *,
    user_id: int,
    actor_user_id: int,
    title: str,
    body: str,
    project_id: str,
    item_id: str | None = None,
    kind: str = "message",
    payload: dict | None = None,
) -> WeworkNotification:
    notification = WeworkNotification(
        id=str(uuid4()),
        user_id=user_id,
        actor_user_id=actor_user_id,
        kind=kind,
        title=title,
        body=body,
        url=issue_url(project_id, item_id),
        payload=payload or {},
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(notification)
    db.info.setdefault(_PENDING, []).append(notification.id)
    return notification


@event.listens_for(Session, "after_rollback")
def _discard_delivery(db: Session) -> None:
    db.info.pop(_PENDING, None)


@event.listens_for(Session, "after_commit")
def _schedule_delivery(db: Session) -> None:
    from app.core.async_utils import schedule_async_task

    for notification_id in db.info.pop(_PENDING, []):
        try:
            schedule_async_task(deliver_notification, notification_id)
        except Exception:
            logger.exception(
                "Wework delivery scheduling failed: id=%s", notification_id
            )


@trace_async()
async def deliver_notification(notification_id: str) -> None:
    from app.api.ws.wework_runtime_namespace import (
        WEWORK_RUNTIME_EVENT,
        WEWORK_RUNTIME_NAMESPACE,
        wework_runtime_user_room,
    )
    from app.core.socketio import get_sio
    from app.db.session import SessionLocal
    from app.services.im.notification_dispatcher import im_notification_dispatcher
    from app.services.im.session_service import im_session_service

    with SessionLocal() as db:
        notification = db.get(WeworkNotification, notification_id)
        if notification is None:
            return
        try:
            await get_sio().emit(
                WEWORK_RUNTIME_EVENT,
                {
                    "event": "wework.notification.created",
                    "payload": {"id": notification.id},
                },
                room=wework_runtime_user_room(notification.user_id),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )
            if notification.kind == "assignment":
                await get_sio().emit(
                    WEWORK_RUNTIME_EVENT,
                    {"event": "project.task.assigned", "payload": notification.payload},
                    room=wework_runtime_user_room(notification.user_id),
                    namespace=WEWORK_RUNTIME_NAMESPACE,
                )
        except Exception:
            logger.exception("Wework live delivery failed: id=%s", notification.id)
        try:
            sessions = await im_session_service.list_user_sessions(
                db, user_id=notification.user_id
            )
            for session in sessions:
                if session.user_id != notification.user_id:
                    continue
                result = await im_notification_dispatcher.send_text(
                    db, session, f"{notification.body}\n\n{notification.url}"
                )
                if not result.get("success"):
                    logger.warning(
                        "Wework IM delivery failed: id=%s channel=%s",
                        notification.id,
                        session.channel_type,
                    )
        except Exception:
            logger.exception("Wework IM delivery failed: id=%s", notification.id)


@trace_sync()
def send_project_notification(
    db: Session, *, user_id: int, values: NotificationCreate
) -> WeworkNotification:
    from app.services.cloud_projects import cloud_project_service
    from app.services.loop_items import loop_item_service
    from app.services.loop_items.external_provider import external_loop_item_provider

    access = cloud_project_service.access(db, values.project_id, user_id)
    if access.is_public_visitor:
        raise HTTPException(403, "Project membership required")
    recipient_id = values.recipient_user_id or user_id
    recipient = cloud_project_service.access(db, values.project_id, recipient_id)
    if recipient.is_public_visitor:
        raise HTTPException(403, "Recipient must be a project member")
    if values.item_id:
        if access.project.task_provider in {"github", "gitlab"}:
            item = external_loop_item_provider.get(db, values.item_id, user_id)
            item_project_id = item["cloud_project_id"]
        else:
            item = loop_item_service.get(db, values.item_id, user_id)
            item_project_id = item.cloud_project_id
        if str(item_project_id) != str(values.project_id):
            raise HTTPException(404, "Issue not found in project")
    row = create_notification(
        db,
        user_id=recipient_id,
        actor_user_id=user_id,
        title=values.title,
        body=values.body,
        project_id=str(values.project_id),
        item_id=values.item_id,
    )
    db.commit()
    db.refresh(row)
    return row
