# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_start_device_terminal_uses_requested_path(monkeypatch):
    from app.api.endpoints import devices
    from app.services.device import session_service

    start_session = AsyncMock(
        return_value={
            "session_id": "terminal-1",
            "device_id": "device-2",
            "type": "terminal",
            "path": "/workspace/worktrees/9/project38",
            "url": "",
            "transport": "socketio",
        }
    )
    monkeypatch.setattr(
        session_service.local_device_session_service,
        "start_session",
        start_session,
    )

    response = await devices.start_device_terminal(
        "device-2",
        payload=devices.DeviceSessionCreate(path=" /workspace/worktrees/9/project38 "),
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.path == "/workspace/worktrees/9/project38"
    start_session.assert_awaited_once()
    kwargs = start_session.await_args.kwargs
    assert kwargs["device_id"] == "device-2"
    assert kwargs["path"] == "/workspace/worktrees/9/project38"
    assert kwargs["create_if_missing"] is False
