"""Account-scoped Wework notification channel preferences."""

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.wework_notification import (
    NotificationPreferences,
    NotificationPreferencesUpdate,
)
from app.services.notification_copy import COLLABORATION_NOTIFICATION_KINDS

PREFERENCE_KEY = "wework_notification_preferences"


def _load_user_preferences(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def get_notification_preferences(user: User) -> NotificationPreferences:
    preferences = _load_user_preferences(user.preferences)
    raw = preferences.get(PREFERENCE_KEY)
    if not isinstance(raw, dict):
        return NotificationPreferences()
    return NotificationPreferences.model_validate(raw)


def notification_category(kind: str) -> str:
    return "collaboration" if kind in COLLABORATION_NOTIFICATION_KINDS else "general"


def update_notification_preferences(
    db: Session,
    *,
    user: User,
    values: NotificationPreferencesUpdate,
) -> NotificationPreferences:
    preferences = get_notification_preferences(user)
    category = getattr(preferences, values.category)
    if getattr(category, values.channel) is None:
        raise ValueError(
            f"{values.channel} notifications are unavailable for {values.category}"
        )
    setattr(category, values.channel, values.enabled)

    stored = _load_user_preferences(user.preferences)
    stored[PREFERENCE_KEY] = preferences.model_dump()
    user.preferences = json.dumps(stored)

    if values.channel == "in_app" and not values.enabled:
        query = db.query(WeworkNotification).filter(
            WeworkNotification.user_id == user.id,
            WeworkNotification.is_read.is_(False),
        )
        if values.category == "collaboration":
            query = query.filter(
                WeworkNotification.kind.in_(COLLABORATION_NOTIFICATION_KINDS)
            )
        elif values.category == "general":
            query = query.filter(
                WeworkNotification.kind.notin_(COLLABORATION_NOTIFICATION_KINDS)
            )
        query.update(
            {
                "is_read": True,
                "read_status_changed_at": datetime.now(timezone.utc).replace(
                    tzinfo=None
                ),
            },
            synchronize_session=False,
        )

    db.add(user)
    db.commit()
    db.refresh(user)
    return get_notification_preferences(user)
