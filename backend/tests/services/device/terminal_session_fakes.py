# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Test-only terminal session storage doubles."""

import time
from dataclasses import replace
from typing import Optional

from app.services.device.terminal_session_record import TerminalSessionRecord


class InMemoryTerminalSessionStore:
    """In-memory terminal session store for tests."""

    def __init__(self) -> None:
        self._records: dict[str, tuple[TerminalSessionRecord, float | None]] = {}
        self._revoked: set[str] = set()

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        expires_at = time.monotonic() + ttl_seconds if ttl_seconds > 0 else None
        self._records[record.session_id] = (record, expires_at)
        self._revoked.discard(record.session_id)

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
        self._revoked.add(session_id)

    async def rebind_socket(
        self,
        record: TerminalSessionRecord,
        socket_id: str,
    ) -> Optional[TerminalSessionRecord]:
        current = await self.get(record.session_id)
        if (
            not current
            or current.user_id != record.user_id
            or current.device_id != record.device_id
        ):
            return None
        rebound = replace(current, socket_id=socket_id)
        expires_at = self._records[record.session_id][1]
        self._records[record.session_id] = (rebound, expires_at)
        return rebound

    async def is_revoked(self, session_id: str) -> bool:
        return session_id in self._revoked
