# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private IM runtime session state."""

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any


class IMSessionMode:
    """Private IM routing modes, independent from execution targets."""

    CHAT = "chat"
    STAND_IN = "stand_in"


@dataclass
class IMPrivateSession:
    """A user-owned private IM conversation runtime state."""

    session_key: str
    user_id: int
    channel_type: str
    channel_id: int
    conversation_id: str
    sender_id: str
    proactive_recipient_id: str = ""
    display_name: str = ""
    # Last chat task this conversation continued. The conversation -> task
    # cache entry expires, while the session has no TTL, so this mirror lets
    # the mapping be rebuilt instead of silently starting a new task.
    chat_task_id: int | None = None
    last_seen_at: datetime = field(default_factory=datetime.now)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict[str, Any]:
        """Convert the session to a Redis-serializable dictionary."""

        data = asdict(self)
        for key in ("last_seen_at", "created_at", "updated_at"):
            value = data.get(key)
            data[key] = value.isoformat() if isinstance(value, datetime) else None
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IMPrivateSession":
        """Create a session from Redis data."""

        values = dict(data)
        for key in ("last_seen_at", "created_at", "updated_at"):
            values[key] = _parse_datetime(values.get(key))
        # Drop the retired task/chat state when reading an existing IM address.
        for key in (
            "mode",
            "state",
            "active_task_id",
            "active_runtime_task",
            "pending_payload",
            "state_expires_at",
        ):
            values.pop(key, None)
        return cls(**values)


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        return datetime.fromisoformat(value)
    return None
