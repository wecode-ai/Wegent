# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Terminal session routing and authorization metadata."""

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional


@dataclass(frozen=True)
class TerminalSessionRecord:
    """Backend-owned terminal session routing metadata."""

    session_id: str
    user_id: int
    device_id: str
    socket_id: str
    project_id: int
    path: str
    expires_at: Optional[datetime] = None
    authorization_epoch: int = field(default=0, compare=False, repr=False)
    authorization_valid_until: float = field(default=0.0, compare=False, repr=False)

    def is_expired(self, now: Optional[datetime] = None) -> bool:
        """Return whether the session's absolute expiration has passed."""
        if self.expires_at is None:
            return True
        current = now or datetime.now(timezone.utc)
        expires_at = self.expires_at
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return current.astimezone(timezone.utc) >= expires_at.astimezone(timezone.utc)

    def authorization_is_fresh(self, now: Optional[float] = None) -> bool:
        """Return whether socket-bound authorization is within its refresh window."""
        current = time.monotonic() if now is None else now
        return current < self.authorization_valid_until

    def to_dict(self) -> dict[str, Any]:
        """Serialize the record for Redis storage."""
        return {
            "session_id": self.session_id,
            "user_id": self.user_id,
            "device_id": self.device_id,
            "socket_id": self.socket_id,
            "project_id": self.project_id,
            "path": self.path,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TerminalSessionRecord":
        """Deserialize a record loaded from Redis."""
        expires_at = data.get("expires_at")
        if isinstance(expires_at, str) and expires_at:
            expires_at_value = datetime.fromisoformat(expires_at)
        else:
            expires_at_value = None

        return cls(
            session_id=str(data["session_id"]),
            user_id=int(data["user_id"]),
            device_id=str(data["device_id"]),
            socket_id=str(data["socket_id"]),
            project_id=int(data.get("project_id") or 0),
            path=str(data.get("path") or ""),
            expires_at=expires_at_value,
        )
