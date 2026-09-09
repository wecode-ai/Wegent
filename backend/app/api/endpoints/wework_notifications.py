"""Authenticated Wework inbox and user notification creation."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user, get_current_user_jwt_apikey_tasktoken
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.wework_notification import (
    InboxView,
    NotificationCreate,
    NotificationView,
)
from app.services.wework_notifications import send_wework_notification

router = APIRouter()


@router.get("", response_model=InboxView)
def list_notifications(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> InboxView:
    query = db.query(WeworkNotification).filter(WeworkNotification.user_id == user.id)
    rows = (
        query.order_by(
            WeworkNotification.created_at.desc(), WeworkNotification.id.desc()
        )
        .offset(offset)
        .limit(limit + 1)
        .all()
    )
    return InboxView(
        items=[NotificationView.model_validate(row) for row in rows[:limit]],
        unread_count=query.filter(WeworkNotification.is_read.is_(False)).count(),
        next_offset=offset + limit if len(rows) > limit else None,
    )


@router.post("", response_model=NotificationView, status_code=201)
def send_notification(
    values: NotificationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WeworkNotification:
    return send_wework_notification(db, user_id=user.id, values=values)


@router.post("/read-all", status_code=204)
def read_all_notifications(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    db.query(WeworkNotification).filter(
        WeworkNotification.user_id == user.id,
        WeworkNotification.is_read.is_(False),
    ).update(
        {
            "is_read": True,
            "read_status_changed_at": datetime.now(timezone.utc).replace(tzinfo=None),
        }
    )
    db.commit()


@router.post("/{notification_id}/read", response_model=NotificationView)
def read_notification(
    notification_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WeworkNotification:
    row = (
        db.query(WeworkNotification)
        .filter(
            WeworkNotification.id == notification_id,
            WeworkNotification.user_id == user.id,
        )
        .first()
    )
    if row is None:
        raise HTTPException(404, "Notification not found")
    if not row.is_read:
        db.query(WeworkNotification).filter(
            WeworkNotification.id == row.id,
            WeworkNotification.is_read.is_(False),
        ).update(
            {
                "is_read": True,
                "read_status_changed_at": datetime.now(timezone.utc).replace(
                    tzinfo=None
                ),
            }
        )
        db.commit()
        db.refresh(row)
    return row
