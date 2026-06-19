# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser terminal session ownership records."""

import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional, Protocol

from app.core.cache import cache_manager

TERMINAL_SESSION_KEY_PREFIX = "terminal_session:"


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


class TerminalSessionStore(Protocol):
    """Storage interface for terminal session records."""

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        """Persist a terminal session record."""

    async def get(self, session_id: str) -> Optional[TerminalSessionRecord]:
        """Load a terminal session record."""

    async def delete(self, session_id: str) -> None:
        """Delete a terminal session record."""


class RedisTerminalSessionStore:
    """Redis-backed terminal session store."""

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        ttl = max(1, int(ttl_seconds))
        ok = await cache_manager.set(
            _record_key(record.session_id), record.to_dict(), ttl
        )
        if not ok:
            raise RuntimeError("Failed to persist terminal session record")

    async def get(self, session_id: str) -> Optional[TerminalSessionRecord]:
        data = await cache_manager.get(_record_key(session_id))
        if not isinstance(data, dict):
            return None
        try:
            return TerminalSessionRecord.from_dict(data)
        except (KeyError, TypeError, ValueError):
            return None

    async def delete(self, session_id: str) -> None:
        await cache_manager.delete(_record_key(session_id))


class InMemoryTerminalSessionStore:
    """In-memory terminal session store for tests."""

    def __init__(self) -> None:
        self._records: dict[str, tuple[TerminalSessionRecord, float | None]] = {}

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        expires_at = time.monotonic() + ttl_seconds if ttl_seconds > 0 else None
        self._records[record.session_id] = (record, expires_at)

    async def get(self, session_id: str) -> Optional[TerminalSessionRecord]:
        item = self._records.get(session_id)
        if not item:
            return None

        record, expires_at = item
        if expires_at is not None and time.monotonic() >= expires_at:
            self._records.pop(session_id, None)
            return None
        return record

    async def delete(self, session_id: str) -> None:
        self._records.pop(session_id, None)


class TerminalSessionService:
    """Manage terminal session ownership and relay routing records."""

    def __init__(self, store: Optional[TerminalSessionStore] = None) -> None:
        self._store = store or RedisTerminalSessionStore()

    async def register(
        self,
        record: TerminalSessionRecord,
        ttl_seconds: int,
    ) -> None:
        """Register a terminal session record with a TTL."""
        await self._store.set(record, ttl_seconds)

    async def get(self, session_id: str) -> Optional[TerminalSessionRecord]:
        """Load a terminal session record by ID."""
        if not session_id:
            return None
        return await self._store.get(session_id)

    async def authorize(
        self,
        session_id: str,
        *,
        user_id: int,
    ) -> Optional[TerminalSessionRecord]:
        """Return the session record only when it belongs to the user."""
        record = await self.get(session_id)
        if not record or record.user_id != user_id:
            return None
        return record

    async def delete(self, session_id: str) -> None:
        """Remove a terminal session record."""
        if session_id:
            await self._store.delete(session_id)


def _record_key(session_id: str) -> str:
    return f"{TERMINAL_SESSION_KEY_PREFIX}{session_id}"


terminal_session_service = TerminalSessionService()
