# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for browser terminal session ownership records."""

from datetime import datetime, timezone

import pytest

from app.services.device.terminal_session_service import (
    InMemoryTerminalSessionStore,
    TerminalSessionRecord,
    TerminalSessionService,
)


class FailingTerminalSessionStore:
    """Store double that fails writes for registry failure tests."""

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        raise RuntimeError("store unavailable")

    async def get(self, session_id: str) -> TerminalSessionRecord | None:
        return None

    async def delete(self, session_id: str) -> None:
        return None


@pytest.mark.asyncio
async def test_terminal_session_service_preserves_owner_and_device_binding():
    """Terminal session records should be retrievable and owner-scoped."""
    service = TerminalSessionService(store=InMemoryTerminalSessionStore())
    record = TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-abc",
        socket_id="socket-123",
        project_id=123,
        path="/repo",
        expires_at=datetime(2026, 6, 19, tzinfo=timezone.utc),
    )

    await service.register(record, ttl_seconds=60)

    assert await service.get("terminal-1") == record
    assert await service.authorize("terminal-1", user_id=7) == record
    assert await service.authorize("terminal-1", user_id=8) is None

    await service.delete("terminal-1")

    assert await service.get("terminal-1") is None


@pytest.mark.asyncio
async def test_terminal_session_service_surfaces_registry_write_failures():
    """Terminal startup should fail if the relay registry cannot be persisted."""
    service = TerminalSessionService(store=FailingTerminalSessionStore())
    record = TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-abc",
        socket_id="socket-123",
        project_id=123,
        path="/repo",
    )

    with pytest.raises(RuntimeError, match="store unavailable"):
        await service.register(record, ttl_seconds=60)
