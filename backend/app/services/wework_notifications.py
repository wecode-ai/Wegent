"""Commit inbox records with their source mutation, then deliver live hints and IM."""

import logging
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.wework_notification import NotificationCreate
from app.services.notification_copy import (
    WEB_LINK_LABEL,
    WEWORK_LINK_LABEL,
    NotificationLink,
    push_copy,
)
from app.services.wework_notification_preferences import (
    get_notification_preferences,
    notification_category,
)
from shared.telemetry.decorators import trace_async, trace_sync

logger = logging.getLogger(__name__)
_PENDING = "wework_notification_ids"


def _delivery_channels(db: Session, *, user_id: int, kind: str) -> dict[str, bool]:
    user = db.get(User, user_id)
    preferences = get_notification_preferences(user) if user else None
    category = notification_category(kind)
    channel_preferences = getattr(preferences, category) if preferences else None
    return {
        "in_app": channel_preferences.in_app if channel_preferences else True,
        "system": (
            bool(channel_preferences.system)
            if channel_preferences
            else kind == "assignment"
        ),
        "im": bool(channel_preferences.im) if channel_preferences else True,
    }


def _delivery_payload(notification: WeworkNotification) -> dict:
    return {
        "id": notification.id,
        "user_id": notification.user_id,
        "kind": notification.kind,
        "title": notification.title,
        "body": notification.body,
        "url": notification.url,
        "payload": notification.payload,
    }


def issue_url(
    project_id: str, item_id: str | None = None, comment_id: str | None = None
) -> str:
    """The Wework destination for a board item, optionally one comment inside it."""

    url = f"wework://boards/{quote(project_id, safe='')}"
    if not item_id:
        return url
    url = f"{url}/issues/{quote(item_id, safe='')}"
    return f"{url}/comments/{quote(comment_id, safe='')}" if comment_id else url


def web_issue_url(project_id: str, item_id: str) -> str:
    """The board page of one item for a recipient without the desktop app."""

    base = settings.FRONTEND_URL.rstrip("/")
    return (
        f"{base}/collaboration/{quote(project_id, safe='')}"
        f"/issues/{quote(item_id, safe='')}"
    )


def notification_links(notification: WeworkNotification) -> list[NotificationLink]:
    """Every destination a push for one stored notification should offer.

    The inbox opens inside Wework, so the stored url is the desktop deep link;
    a push reaches recipients who may not run Wework, so it carries the web
    board page as well.
    """

    return _notification_links(_delivery_payload(notification))


def _notification_links(notification: dict) -> list[NotificationLink]:
    payload = (
        notification["payload"] if isinstance(notification.get("payload"), dict) else {}
    )
    links: list[NotificationLink] = []
    if notification.get("url"):
        links.append(NotificationLink(label=WEWORK_LINK_LABEL, url=notification["url"]))
    project_id = payload.get("projectId")
    item_id = payload.get("itemId")
    if project_id and item_id:
        links.append(
            NotificationLink(
                label=WEB_LINK_LABEL,
                url=web_issue_url(str(project_id), str(item_id)),
            )
        )
    return links


def create_notification(
    db: Session,
    *,
    user_id: int,
    actor_user_id: int,
    title: str,
    body: str,
    project_id: str | None = None,
    item_id: str | None = None,
    comment_id: str | None = None,
    url: str | None = None,
    kind: str = "message",
    payload: dict | None = None,
) -> WeworkNotification:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    channels = _delivery_channels(db, user_id=user_id, kind=kind)
    notification = WeworkNotification(
        id=str(uuid4()),
        user_id=user_id,
        actor_user_id=actor_user_id,
        kind=kind,
        title=title,
        body=body,
        url=(
            url
            if url is not None
            else issue_url(project_id, item_id, comment_id) if project_id else ""
        ),
        payload=payload or {},
        created_at=now,
        is_read=False,
        read_status_changed_at=now,
    )
    if channels["in_app"]:
        db.add(notification)
        db.info.setdefault(_PENDING, []).append(
            {"type": "stored", "id": notification.id, "channels": channels}
        )
    elif channels["system"] or channels["im"]:
        db.info.setdefault(_PENDING, []).append(
            {
                "type": "transient",
                "notification": _delivery_payload(notification),
                "channels": channels,
            }
        )
    return notification


@event.listens_for(Session, "after_rollback")
def _discard_delivery(db: Session) -> None:
    db.info.pop(_PENDING, None)


@event.listens_for(Session, "after_commit")
def _schedule_delivery(db: Session) -> None:
    from app.core.async_utils import schedule_async_task

    for pending in db.info.pop(_PENDING, []):
        try:
            if pending["type"] == "stored":
                schedule_async_task(
                    deliver_notification,
                    pending["id"],
                    pending["channels"],
                )
            else:
                schedule_async_task(
                    deliver_notification_payload,
                    pending["notification"],
                    pending["channels"],
                )
        except Exception:
            logger.exception("Wework delivery scheduling failed: pending=%s", pending)


@trace_async()
async def deliver_notification(
    notification_id: str,
    channels: dict[str, bool] | None = None,
) -> None:
    from app.db.session import SessionLocal

    with SessionLocal() as db:
        notification = db.get(WeworkNotification, notification_id)
        if notification is None:
            return
        channels = channels or _delivery_channels(
            db, user_id=notification.user_id, kind=notification.kind
        )
        await _deliver_notification_payload(
            db,
            _delivery_payload(notification),
            channels,
            emit_inbox=True,
        )


@trace_async()
async def deliver_notification_payload(
    notification: dict,
    channels: dict[str, bool],
) -> None:
    from app.db.session import SessionLocal

    with SessionLocal() as db:
        await _deliver_notification_payload(
            db,
            notification,
            channels,
            emit_inbox=False,
        )


async def _deliver_notification_payload(
    db: Session,
    notification: dict,
    channels: dict[str, bool],
    *,
    emit_inbox: bool,
) -> None:
    from app.api.ws.wework_runtime_namespace import (
        WEWORK_RUNTIME_EVENT,
        WEWORK_RUNTIME_NAMESPACE,
        wework_runtime_user_room,
    )
    from app.core.socketio import get_sio
    from app.services.im.notification_dispatcher import im_notification_dispatcher
    from app.services.im.session_service import im_session_service

    notification_id = notification["id"]
    user_id = notification["user_id"]
    kind = notification["kind"]
    try:
        if emit_inbox:
            await get_sio().emit(
                WEWORK_RUNTIME_EVENT,
                {
                    "event": "wework.notification.created",
                    "payload": {"id": notification_id},
                },
                room=wework_runtime_user_room(user_id),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )
        if channels["system"] and kind == "assignment":
            await get_sio().emit(
                WEWORK_RUNTIME_EVENT,
                {
                    "event": "project.task.assigned",
                    "payload": notification["payload"],
                },
                room=wework_runtime_user_room(user_id),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )
    except Exception:
        logger.exception("Wework live delivery failed: id=%s", notification_id)

    if not channels["im"]:
        return
    try:
        sessions = await im_session_service.list_user_sessions(db, user_id=user_id)
        payload = (
            notification["payload"]
            if isinstance(notification.get("payload"), dict)
            else {}
        )
        push = push_copy(
            kind=kind,
            title=notification["title"],
            body=notification["body"],
            payload=payload,
        )
        for session in sessions:
            if session.user_id != user_id:
                continue
            result = await im_notification_dispatcher.send_notification(
                db,
                session,
                push,
                links=_notification_links(notification),
            )
            if not result.get("success"):
                logger.warning(
                    "Wework IM delivery failed: id=%s channel=%s",
                    notification_id,
                    session.channel_type,
                )
    except Exception:
        logger.exception("Wework IM delivery failed: id=%s", notification_id)


@trace_sync()
def send_wework_notification(
    db: Session, *, user_id: int, values: NotificationCreate
) -> WeworkNotification:
    recipient_id = values.recipient_user_id or user_id
    if values.project_id is not None:
        _validate_project_source(db, user_id, recipient_id, values)
    elif recipient_id != user_id:
        raise HTTPException(403, "Notifying another user requires a shared project")
    row = create_notification(
        db,
        user_id=recipient_id,
        actor_user_id=user_id,
        title=values.title,
        body=values.body,
        project_id=str(values.project_id) if values.project_id is not None else None,
        item_id=values.item_id,
        url=values.url,
    )
    db.commit()
    if row in db:
        db.refresh(row)
    return row


def _validate_project_source(
    db: Session, user_id: int, recipient_id: int, values: NotificationCreate
) -> None:
    from app.services.cloud_projects import cloud_project_service
    from app.services.loop_items.external_provider import external_loop_item_provider
    from app.services.loop_items.service import loop_item_service

    access = cloud_project_service.access(db, values.project_id, user_id)
    if access.is_public_visitor:
        raise HTTPException(403, "Project membership required")
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
