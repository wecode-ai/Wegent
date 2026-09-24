"""Account-scoped Wework notification channel preferences."""

import json
import logging
from datetime import datetime, timezone
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.wework_notification import (
    NotificationPreferences,
    NotificationPreferencesUpdate,
)
from app.services.notification_copy import COLLABORATION_NOTIFICATION_KINDS

PREFERENCE_KEY = "wework_notification_preferences"
logger = logging.getLogger(__name__)


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

    defaults = NotificationPreferences()
    merged = defaults.model_dump()
    dropped_value = False
    for category_name, default_channels in merged.items():
        raw_channels = raw.get(category_name)
        if not isinstance(raw_channels, dict):
            dropped_value = dropped_value or category_name in raw
            continue
        for channel_name, default_value in default_channels.items():
            if channel_name not in raw_channels:
                continue
            value = raw_channels[channel_name]
            if isinstance(value, bool) and default_value is not None:
                merged[category_name][channel_name] = value
            elif value is None and default_value is None:
                merged[category_name][channel_name] = value
            else:
                dropped_value = True
        dropped_value = dropped_value or any(
            channel_name not in default_channels for channel_name in raw_channels
        )
    dropped_value = dropped_value or any(
        category_name not in merged for category_name in raw
    )

    try:
        result = NotificationPreferences.model_validate(merged)
    except ValidationError:
        logger.warning(
            "Invalid Wework notification preferences ignored: user_id=%s",
            user.id,
        )
        return defaults
    if dropped_value:
        logger.warning(
            "Unknown or invalid Wework notification preferences ignored: user_id=%s",
            user.id,
        )
    return result


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

    if (
        values.channel == "in_app"
        and not values.enabled
        and values.category in ("collaboration", "general")
    ):
        query = db.query(WeworkNotification).filter(
            WeworkNotification.user_id == user.id,
            WeworkNotification.is_read.is_(False),
        )
        if values.category == "collaboration":
            query = query.filter(
                WeworkNotification.kind.in_(COLLABORATION_NOTIFICATION_KINDS)
            )
        else:
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
