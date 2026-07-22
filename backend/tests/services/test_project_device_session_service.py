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
async def test_start_project_device_session_uses_task_execution_workspace_path(
    monkeypatch,
):
    """Task-scoped project sessions should use the prepared worktree path."""
    from app.models.project import Project
    from app.models.task import TaskResource
    from app.services import project_device_session_service as service

    project = SimpleNamespace(
        id=123,
        user_id=7,
        is_active=True,
        config=_project_config(path="/workspace/project", device_id="device-bound"),
    )
    task = SimpleNamespace(
        id=456,
        user_id=7,
        project_id=123,
        kind="Task",
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="wework",
        json={
            "spec": {
                "execution": {
                    "workspace": {
                        "source": "git_worktree",
                        "path": "/workspace/worktrees/456/project",
                    }
                }
            }
        },
    )

    def fake_query(result):
        query = SimpleNamespace()
        query.filter = lambda *args: query
        query.first = lambda: result
        return query

    def query(model):
        if model is Project:
            return fake_query(project)
        if model is TaskResource:
            return fake_query(task)
        raise AssertionError(f"Unexpected model: {model}")

    db = SimpleNamespace(query=query)
    execute_mock = AsyncMock(
        return_value={
            "success": True,
            "session_id": "session-456",
            "url": "http://localhost:17888/?session_id=session-456&token=short",
            "path": "/workspace/worktrees/456/project",
            "device_id": "device-bound",
        }
    )
    monkeypatch.setattr(
        service.local_device_session_service,
        "start_session",
        execute_mock,
    )
    monkeypatch.setattr(
        service,
        "device_service",
        SimpleNamespace(get_device_by_device_id=lambda db, user_id, device_id: None),
        raising=False,
    )

    result = await service.start_project_device_session(
        db=db,
        user_id=7,
        project_id=123,
        session_type="terminal",
        client_origin="wework",
        task_id=456,
    )

    assert result.path == "/workspace/worktrees/456/project"
    kwargs = execute_mock.await_args.kwargs
    assert kwargs["path"] == "/workspace/worktrees/456/project"
    assert kwargs["create_if_missing"] is False


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
async def test_start_project_terminal_session_allows_local_device_type(monkeypatch):
    """Project terminal sessions should work for local devices through Socket.IO relay."""
    from app.services import project_device_session_service as service

    project = SimpleNamespace(
        id=123,
        user_id=7,
        is_active=True,
        config=_project_config(path="/workspace/project", device_id="local-device"),
    )
    device_kind = SimpleNamespace(json={"spec": {"deviceType": "local"}})
    query = SimpleNamespace(filter=lambda *args: SimpleNamespace(first=lambda: project))
    db = SimpleNamespace(query=lambda model: query)
    execute_mock = AsyncMock(
        return_value={
            "success": True,
            "session_id": "terminal-123",
            "project_id": 123,
            "device_id": "local-device",
            "type": "terminal",
            "path": "/workspace/project",
            "url": "",
            "transport": "socketio",
        }
    )
    monkeypatch.setattr(
        service.local_device_session_service,
        "start_session",
        execute_mock,
    )
    monkeypatch.setattr(
        service,
        "device_service",
        SimpleNamespace(
            get_device_by_device_id=lambda db, user_id, device_id: device_kind
        ),
        raising=False,
    )

    result = await service.start_project_device_session(
        db=db,
        user_id=7,
        project_id=123,
        session_type="terminal",
    )

    assert result.transport == "socketio"
    assert result.device_id == "local-device"
    execute_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_start_project_code_server_session_rejects_local_device_type(monkeypatch):
    """Project code-server sessions still require a cloud device gateway."""
    from fastapi import HTTPException

    from app.services import project_device_session_service as service

    project = SimpleNamespace(
        id=123,
        user_id=7,
        is_active=True,
        config=_project_config(path="/workspace/project", device_id="local-device"),
    )
    device_kind = SimpleNamespace(json={"spec": {"deviceType": "local"}})
    query = SimpleNamespace(filter=lambda *args: SimpleNamespace(first=lambda: project))
    db = SimpleNamespace(query=lambda model: query)
    execute_mock = AsyncMock()
    monkeypatch.setattr(
        service.local_device_session_service,
        "start_session",
        execute_mock,
    )
    monkeypatch.setattr(
        service,
        "device_service",
        SimpleNamespace(
            get_device_by_device_id=lambda db, user_id, device_id: device_kind
        ),
        raising=False,
    )

    with pytest.raises(HTTPException) as exc_info:
        await service.start_project_device_session(
            db=db,
            user_id=7,
            project_id=123,
            session_type="code_server",
        )

    assert exc_info.value.status_code == 400
    assert (
        "local devices do not support code-server sessions"
        in exc_info.value.detail.lower()
    )
    execute_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_device_session_service_calls_device_start_session(monkeypatch):
    """Device session service should send a start_session RPC to the online device."""
    from app.services.device import session_service

    monkeypatch.setattr(session_service.secrets, "token_urlsafe", lambda size: "secret")
    mock_sio = AsyncMock()
    mock_sio.call.return_value = {
        "success": True,
        "session_id": "session-123",
        "url": "http://localhost:17888/s/session-123/?token=short",
        "path": "/repo",
        "device_id": "device-abc",
        "type": "terminal",
    }
    terminal_registry = SimpleNamespace(register=AsyncMock())
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
    monkeypatch.setattr(
        session_service,
        "terminal_session_service",
        terminal_registry,
        raising=False,
    )

    result = await session_service.local_device_session_service.start_session(
        db=object(),
        user_id=7,
        device_id="device-abc",
        project_id=123,
        session_type="terminal",
        path="/repo",
    )

    assert result["success"] is True
    assert result["url"] == ""
    assert result["transport"] == "socketio"
    payload = mock_sio.call.await_args.args[1]
    assert payload["type"] == "terminal"
    assert payload["project_id"] == 123
    assert payload["path"] == "/repo"
    assert payload["create_if_missing"] is False
    assert payload["session_id"].startswith("terminal-123-")
    assert payload["access_token"] == "secret"
    assert mock_sio.call.await_args.args[0] == "device:start_terminal_session"
    mock_sio.call.assert_awaited_once()
    terminal_registry.register.assert_awaited_once()
    record = terminal_registry.register.await_args.args[0]
    assert record.session_id == payload["session_id"]
    assert record.user_id == 7
    assert record.device_id == "device-abc"
    assert record.socket_id == "socket-123"
    assert record.project_id == 123
    assert record.path == "/repo"


@pytest.mark.asyncio
async def test_local_device_session_service_maps_terminal_registry_failures(
    monkeypatch,
):
    """Terminal registry failures should return a device session error and clean up."""
    from app.services.device import session_service

    mock_sio = AsyncMock()
    mock_sio.call.return_value = {
        "success": True,
        "session_id": "session-123",
        "url": "",
        "path": "/repo",
        "device_id": "device-abc",
        "type": "terminal",
    }
    terminal_registry = SimpleNamespace(
        register=AsyncMock(side_effect=RuntimeError("redis unavailable"))
    )
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
    monkeypatch.setattr(
        session_service,
        "terminal_session_service",
        terminal_registry,
        raising=False,
    )

    with pytest.raises(
        session_service.DeviceSessionError,
        match="Failed to persist terminal session metadata",
    ):
        await session_service.local_device_session_service.start_session(
            db=object(),
            user_id=7,
            device_id="device-abc",
            project_id=123,
            session_type="terminal",
            path="/repo",
        )

    session_id = mock_sio.call.await_args.args[1]["session_id"]
    mock_sio.emit.assert_awaited_once_with(
        "terminal:close",
        {"session_id": session_id},
        to="socket-123",
        namespace="/local-executor",
    )


@pytest.mark.asyncio
async def test_local_device_session_service_adds_missing_url_token(monkeypatch):
    """Returned code-server URLs must include the generated access token."""
    from app.services.device import session_service

    monkeypatch.setattr(session_service.secrets, "token_urlsafe", lambda size: "secret")
    mock_sio = AsyncMock()
    mock_sio.call.return_value = {
        "success": True,
        "session_id": "session-123",
        "url": "http://localhost:17888/s/session-123/",
        "path": "/repo",
        "device_id": "device-abc",
        "type": "code_server",
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
        session_type="code_server",
        path="/repo",
    )

    assert result["url"] == "http://localhost:17888/s/session-123/?token=secret"
    assert result["transport"] == "url"


@pytest.mark.asyncio
async def test_cloud_device_session_service_rewrites_localhost_session_url(
    monkeypatch,
):
    """Cloud code-server sessions should not return the device-local localhost URL."""
    from app.services.device import session_service

    monkeypatch.setattr(session_service.secrets, "token_urlsafe", lambda size: "short")
    mock_sio = AsyncMock()
    mock_sio.call.return_value = {
        "success": True,
        "session_id": "session-123",
        "url": "http://localhost:17888/s/session-123/?token=short",
        "path": "/repo",
        "device_id": "device-abc",
        "type": "code_server",
    }
    device_kind = SimpleNamespace(
        json={
            "spec": {
                "deviceType": "cloud",
                "cloudConfig": {"sandboxId": "sandbox-123"},
            }
        }
    )
    monkeypatch.setattr(
        session_service.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-123"}),
    )
    monkeypatch.setattr(
        session_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: device_kind,
    )
    monkeypatch.setattr(session_service, "get_sio", lambda: mock_sio)

    class FakeCloudDeviceProvider:
        async def get_vm_status(self, sandbox_id):
            assert sandbox_id == "sandbox-123"
            return {"ip_address": "10.1.2.3"}

    monkeypatch.setattr(
        session_service,
        "_get_cloud_device_provider",
        lambda: FakeCloudDeviceProvider(),
    )

    result = await session_service.local_device_session_service.start_session(
        db=object(),
        user_id=7,
        device_id="device-abc",
        project_id=123,
        session_type="code_server",
        path="/repo",
    )

    assert result["url"] == "http://10.1.2.3:17888/s/session-123/?token=short"
    assert result["transport"] == "url"


@pytest.mark.asyncio
async def test_cloud_device_session_service_uses_runtime_transfer_host(
    monkeypatch,
):
    """Cloud IDE URLs should use the host advertised by the online executor."""
    from app.services.device import session_service

    monkeypatch.setattr(session_service.secrets, "token_urlsafe", lambda size: "short")
    mock_sio = AsyncMock()
    mock_sio.call.return_value = {
        "success": True,
        "session_id": "session-123",
        "url": "http://localhost:17888/s/session-123/?token=short",
        "path": "/repo",
        "device_id": "device-abc",
        "type": "code_server",
    }
    device_kind = SimpleNamespace(
        json={
            "spec": {
                "deviceType": "cloud",
                "cloudConfig": {"sandboxId": "sandbox-123"},
            }
        }
    )
    monkeypatch.setattr(
        session_service.device_service,
        "get_device_online_info",
        AsyncMock(
            return_value={
                "socket_id": "socket-123",
                "runtime_transfer_host": "10.2.3.4",
            }
        ),
    )
    monkeypatch.setattr(
        session_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: device_kind,
    )
    monkeypatch.setattr(session_service, "get_sio", lambda: mock_sio)
    monkeypatch.setattr(
        session_service,
        "_get_cloud_device_provider",
        lambda: (_ for _ in ()).throw(ModuleNotFoundError("wecode")),
    )

    result = await session_service.local_device_session_service.start_session(
        db=object(),
        user_id=7,
        device_id="device-abc",
        project_id=123,
        session_type="code_server",
        path="/repo",
    )

    assert result["url"] == "http://10.2.3.4:17888/s/session-123/?token=short"
    assert result["transport"] == "url"
