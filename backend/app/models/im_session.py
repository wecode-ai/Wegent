# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private IM runtime session state."""

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any


class IMSessionMode:
    """Private IM session modes."""

    CHAT = "chat"
    TASK = "task"


class IMSessionState:
    """Private IM session transient states."""

    IDLE = "idle"
    PENDING_NEW_FLOW = "pending_new_flow"
    PENDING_TASK_SWITCH = "pending_task_switch"
    PENDING_TASK_CREATION = "pending_task_creation"


@dataclass
class IMPrivateSession:
    """A user-owned private IM conversation runtime state."""

    session_key: str
    user_id: int
    channel_type: str
    channel_id: int
    conversation_id: str
    sender_id: str
    display_name: str = ""
    mode: str = IMSessionMode.CHAT
    state: str = IMSessionState.IDLE
    active_task_id: int | None = None
    active_runtime_task: dict[str, Any] | None = None
    current_target_type: str | None = None
    current_target: dict[str, Any] | None = None
    pending_action_id: str | None = None
    pending_payload: dict[str, Any] = field(default_factory=dict)
    state_expires_at: datetime | None = None
    last_seen_at: datetime = field(default_factory=datetime.now)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict[str, Any]:
        """Convert the session to a Redis-serializable dictionary."""

        data = asdict(self)
        for key in ("state_expires_at", "last_seen_at", "created_at", "updated_at"):
            value = data.get(key)
            data[key] = value.isoformat() if isinstance(value, datetime) else None
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IMPrivateSession":
        """Create a session from Redis data."""

        values = dict(data)
        for key in ("state_expires_at", "last_seen_at", "created_at", "updated_at"):
            values[key] = _parse_datetime(values.get(key))
        payload = values.get("pending_payload")
        values["pending_payload"] = payload if isinstance(payload, dict) else {}
        runtime_task = values.get("active_runtime_task")
        values["active_runtime_task"] = (
            runtime_task if isinstance(runtime_task, dict) else None
        )
        current_target = values.get("current_target")
        values["current_target"] = (
            current_target if isinstance(current_target, dict) else None
        )
        pending_action_id = values.get("pending_action_id")
        values["pending_action_id"] = (
            pending_action_id if isinstance(pending_action_id, str) else None
        )
        return cls(**values)


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        return datetime.fromisoformat(value)
    return None
