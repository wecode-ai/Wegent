# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for project-scoped local device sessions."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


def _project_config(path: str = "/repo", device_id: str = "device-abc") -> dict:
    return {
        "mode": "workspace",
        "execution": {"targetType": "local", "deviceId": device_id},
        "workspace": {"source": "local_path", "localPath": path},
    }


@pytest.mark.asyncio
async def test_start_project_device_session_uses_project_bound_device_and_path(
    monkeypatch,
):
    """Project session service should use project config instead of request input."""
    from app.services import project_device_session_service as service

    project = SimpleNamespace(
        id=123,
        user_id=7,
        is_active=True,
        config=_project_config(path="/workspace/project", device_id="device-bound"),
    )
    query = SimpleNamespace(
        filter=lambda *args: SimpleNamespace(first=lambda: project),
    )
    db = SimpleNamespace(query=lambda model: query)
    execute_mock = AsyncMock(
        return_value={
            "success": True,
            "session_id": "session-123",
            "url": "http://localhost:17888/?session_id=session-123&token=short",
            "path": "/workspace/project",
            "device_id": "device-bound",
        }
    )
    monkeypatch.setattr(
        service.local_device_session_service,
        "start_session",
        execute_mock,
    )

    result = await service.start_project_device_session(
        db=db,
        user_id=7,
        project_id=123,
        session_type="code_server",
    )

    assert result.session_id == "session-123"
    assert result.device_id == "device-bound"
    assert result.path == "/workspace/project"
    execute_mock.assert_awaited_once()
    kwargs = execute_mock.await_args.kwargs
    assert kwargs["user_id"] == 7
    assert kwargs["device_id"] == "device-bound"
    assert kwargs["session_type"] == "code_server"
    assert kwargs["path"] == "/workspace/project"
    assert kwargs["project_id"] == 123
    assert kwargs["create_if_missing"] is True


@pytest.mark.asyncio
async def test_start_project_device_session_creates_configured_workspace_path(
    monkeypatch,
):
    """Workspace local paths should be created by the bound local device."""
    from app.services import project_device_session_service as service

    project = SimpleNamespace(
        id=34,
        user_id=7,
        is_active=True,
        config=_project_config(
            path="/home/wegent/xxxx199999",
            device_id="device-bound",
        ),
    )
    query = SimpleNamespace(filter=lambda *args: SimpleNamespace(first=lambda: project))
    db = SimpleNamespace(query=lambda model: query)
    execute_mock = AsyncMock(
        return_value={
            "success": True,
            "session_id": "code-server-34-short",
            "url": "http://localhost:17888/s/code-server-34-short/?token=short",
        }
    )
    monkeypatch.setattr(
        service.local_device_session_service,
        "start_session",
        execute_mock,
    )

    result = await service.start_project_device_session(
        db=db,
        user_id=7,
        project_id=34,
        session_type="code_server",
    )

    assert result.path == "/home/wegent/xxxx199999"
    kwargs = execute_mock.await_args.kwargs
    assert kwargs["path"] == "/home/wegent/xxxx199999"
    assert kwargs["create_if_missing"] is True


@pytest.mark.asyncio
async def test_start_project_device_session_accepts_existing_project_path_field(
    monkeypatch,
):
    """Project sessions should reuse the existing project path without concatenation."""
    from app.services import project_device_session_service as service

    project = SimpleNamespace(
        id=17,
        user_id=7,
        is_active=True,
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-bound"},
            "path": "backend/app",
        },
    )
    query = SimpleNamespace(filter=lambda *args: SimpleNamespace(first=lambda: project))
    db = SimpleNamespace(query=lambda model: query)
    execute_mock = AsyncMock(
        return_value={
            "success": True,
            "session_id": "terminal-17-short",
            "url": "http://localhost:17888/s/terminal-17-short/?token=short",
        }
    )
    monkeypatch.setattr(
        service.local_device_session_service,
        "start_session",
        execute_mock,
    )

    result = await service.start_project_device_session(
        db=db,
        user_id=7,
        project_id=17,
        session_type="terminal",
    )

    assert result.path == "backend/app"
    kwargs = execute_mock.await_args.kwargs
    assert kwargs["path"] == "backend/app"
    assert kwargs["create_if_missing"] is False


@pytest.mark.asyncio
async def test_start_project_device_session_uses_default_project_path_when_missing(
    monkeypatch,
):
    """Workspace projects without an explicit path should use the executor default."""
    from app.services import project_device_session_service as service

    project = SimpleNamespace(
        id=17,
        user_id=7,
        is_active=True,
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-bound"},
        },
    )
    query = SimpleNamespace(filter=lambda *args: SimpleNamespace(first=lambda: project))
    db = SimpleNamespace(query=lambda model: query)
    execute_mock = AsyncMock(
        return_value={
            "success": True,
            "session_id": "terminal-17-short",
            "url": "http://localhost:17888/s/terminal-17-short/?token=short",
        }
    )
    monkeypatch.setattr(
        service.local_device_session_service,
        "start_session",
        execute_mock,
    )

    result = await service.start_project_device_session(
        db=db,
        user_id=7,
        project_id=17,
        session_type="terminal",
    )

    assert result.path == "project17"
    kwargs = execute_mock.await_args.kwargs
    assert kwargs["path"] == "project17"
    assert kwargs["create_if_missing"] is True


@pytest.mark.asyncio
async def test_start_project_device_session_rejects_project_without_bound_device():
    """Workspace project sessions require a local bound device."""
    from fastapi import HTTPException

    from app.services import project_device_session_service as service

    project = SimpleNamespace(
        id=123,
        user_id=7,
        is_active=True,
        config={
            "mode": "workspace",
            "execution": {"targetType": "cloud"},
            "workspace": {"source": "local_path", "localPath": "/workspace/project"},
        },
    )
    query = SimpleNamespace(filter=lambda *args: SimpleNamespace(first=lambda: project))
    db = SimpleNamespace(query=lambda model: query)

    with pytest.raises(HTTPException) as exc_info:
        await service.start_project_device_session(
            db=db,
            user_id=7,
            project_id=123,
            session_type="terminal",
        )

    assert exc_info.value.status_code == 400
    assert "local device" in exc_info.value.detail.lower()


@pytest.mark.asyncio
async def test_local_device_session_service_calls_device_start_session(monkeypatch):
    """Device session service should send a start_session RPC to the online device."""
    from app.services.device import session_service

    mock_sio = AsyncMock()
    mock_sio.call.return_value = {
        "success": True,
        "session_id": "session-123",
        "url": "http://localhost:17888/s/session-123/?token=short",
        "path": "/repo",
        "device_id": "device-abc",
        "type": "terminal",
    }
    monkeypatch.setattr(
        session_service.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-123"}),
    )
    monkeypatch.setattr(
        session_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(session_service, "get_sio", lambda: mock_sio)

    result = await session_service.local_device_session_service.start_session(
        db=object(),
        user_id=7,
        device_id="device-abc",
        project_id=123,
        session_type="terminal",
        path="/repo",
    )

    assert result["success"] is True
    payload = mock_sio.call.await_args.args[1]
    assert payload["type"] == "terminal"
    assert payload["project_id"] == 123
    assert payload["path"] == "/repo"
    assert payload["create_if_missing"] is False
    assert payload["session_id"].startswith("terminal-123-")
    assert len(payload["access_token"]) >= 32
    assert mock_sio.call.await_args.args[0] == "device:start_terminal_session"
    mock_sio.call.assert_awaited_once()
