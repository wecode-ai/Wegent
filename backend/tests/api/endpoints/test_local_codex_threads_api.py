# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local Codex thread API endpoints."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException


def test_get_user_team_allows_public_team(test_db) -> None:
    from app.api.endpoints.local_codex import _get_user_team_or_404
    from app.models.kind import Kind

    team = Kind(
        user_id=0,
        kind="Team",
        name="public-codex",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "public-codex", "namespace": "default"},
            "spec": {"members": [], "collaborationModel": "solo"},
        },
    )
    test_db.add(team)
    test_db.commit()

    assert _get_user_team_or_404(test_db, user_id=7, team_id=team.id).id == team.id


def test_local_codex_bind_request_allows_backend_default_team() -> None:
    from app.schemas.local_codex import LocalCodexBindRequest

    request = LocalCodexBindRequest(
        deviceId="device-abc",
        threadId="018f2d6b-8c7a-7abc-9def-0123456789ab",
    )

    assert request.team_id is None


def test_get_user_team_uses_configured_wework_default_when_team_id_missing(
    test_db,
    monkeypatch,
) -> None:
    from app.api.endpoints.local_codex import _get_user_team_or_404
    from app.core.config import settings
    from app.models.kind import Kind

    monkeypatch.setattr(
        settings,
        "DEFAULT_TEAM_WEWORK",
        "wegent-wework#default",
    )
    team = Kind(
        user_id=0,
        kind="Team",
        name="wegent-wework",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "wegent-wework", "namespace": "default"},
            "spec": {"members": [], "collaborationModel": "solo"},
        },
    )
    test_db.add(team)
    test_db.commit()

    assert _get_user_team_or_404(test_db, user_id=7, team_id=None).id == team.id


@pytest.mark.asyncio
async def test_list_local_codex_threads_dispatches_capped_discovery(
    monkeypatch,
) -> None:
    from app.api.endpoints import local_codex

    service_mock = AsyncMock(
        return_value={
            "success": True,
            "stdout": {
                "threads": [
                    {
                        "threadId": "018f2d6b-8c7a-7abc-9def-0123456789ab",
                        "title": "Thread",
                        "cwd": "/tmp/project",
                        "updatedAt": "2026-06-20T01:00:00Z",
                        "archived": False,
                        "running": False,
                    }
                ]
            },
        }
    )
    monkeypatch.setattr(local_codex, "execute_configured_device_command", service_mock)
    db = object()

    response = await local_codex.list_device_codex_threads(
        device_id="device-abc",
        limit=250,
        db=db,
        current_user=SimpleNamespace(id=7),
    )

    assert [thread.thread_id for thread in response.threads] == [
        "018f2d6b-8c7a-7abc-9def-0123456789ab"
    ]
    assert response.threads[0].cwd == "/tmp/project"
    service_mock.assert_awaited_once_with(
        db=db,
        user_id=7,
        device_id="device-abc",
        command_key="codex_threads_list",
        env={"WEGENT_CODEX_THREADS_LIMIT": "100"},
        timeout_seconds=10,
        max_output_bytes=262144,
    )


@pytest.mark.asyncio
async def test_bind_local_codex_thread_refreshes_discovery_and_rejects_missing(
    monkeypatch,
) -> None:
    from app.api.endpoints import local_codex
    from app.schemas.local_codex import LocalCodexBindRequest

    service_mock = AsyncMock(return_value={"success": True, "stdout": {"threads": []}})
    monkeypatch.setattr(local_codex, "execute_configured_device_command", service_mock)

    with pytest.raises(HTTPException) as exc_info:
        await local_codex.bind_local_codex_thread_endpoint(
            request=LocalCodexBindRequest(
                deviceId="device-abc",
                threadId="018f2d6b-8c7a-7abc-9def-0123456789ab",
                teamId=11,
            ),
            db=object(),
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 404
    assert "not found" in exc_info.value.detail
    service_mock.assert_awaited_once()
    _, kwargs = service_mock.await_args
    assert kwargs["command_key"] == "codex_threads_list"


@pytest.mark.asyncio
async def test_bind_local_codex_thread_returns_service_binding(monkeypatch) -> None:
    from app.api.endpoints import local_codex
    from app.schemas.local_codex import LocalCodexBindRequest

    service_mock = AsyncMock(
        return_value={
            "success": True,
            "stdout": {
                "threads": [
                    {
                        "threadId": "018f2d6b-8c7a-7abc-9def-0123456789ab",
                        "title": "Thread",
                        "cwd": "/tmp/project",
                        "updatedAt": "2026-06-20T01:00:00Z",
                    }
                ]
            },
        }
    )
    bind_result = SimpleNamespace(
        task_id=123,
        created=False,
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        device_id="device-abc",
        task=SimpleNamespace(id=123),
    )
    bind_mock = MagicMock(return_value=bind_result)
    monkeypatch.setattr(local_codex, "execute_configured_device_command", service_mock)
    monkeypatch.setattr(
        local_codex,
        "_get_user_team_or_404",
        lambda db, user_id, team_id: SimpleNamespace(id=team_id),
    )
    monkeypatch.setattr(local_codex, "bind_local_codex_thread", bind_mock)
    monkeypatch.setattr(
        local_codex,
        "convert_to_task_dict",
        lambda task, db, user_id: {"id": task.id, "project_id": 0},
    )

    response = await local_codex.bind_local_codex_thread_endpoint(
        request=LocalCodexBindRequest(
            deviceId="device-abc",
            threadId="018f2d6b-8c7a-7abc-9def-0123456789ab",
            teamId=11,
        ),
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.task_id == 123
    assert response.task == {"id": 123, "project_id": 0}
    assert response.created is False
    assert response.thread_id == "018f2d6b-8c7a-7abc-9def-0123456789ab"
    bind_mock.assert_called_once()
    _, bind_kwargs = bind_mock.call_args
    assert bind_kwargs["user"].id == 7
    assert bind_kwargs["team"].id == 11
    assert bind_kwargs["title"] == "Thread"
    assert bind_kwargs["cwd"] == "/tmp/project"


@pytest.mark.asyncio
async def test_bind_local_codex_thread_ignores_client_cwd_when_discovery_has_none(
    monkeypatch,
) -> None:
    from app.api.endpoints import local_codex
    from app.schemas.local_codex import LocalCodexBindRequest

    service_mock = AsyncMock(
        return_value={
            "success": True,
            "stdout": {
                "threads": [
                    {
                        "threadId": "018f2d6b-8c7a-7abc-9def-0123456789ab",
                        "title": "Thread",
                    }
                ]
            },
        }
    )
    bind_result = SimpleNamespace(
        task_id=123,
        created=True,
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        device_id="device-abc",
        task=SimpleNamespace(id=123),
    )
    bind_mock = MagicMock(return_value=bind_result)
    monkeypatch.setattr(local_codex, "execute_configured_device_command", service_mock)
    monkeypatch.setattr(
        local_codex,
        "_get_user_team_or_404",
        lambda db, user_id, team_id: SimpleNamespace(id=team_id),
    )
    monkeypatch.setattr(local_codex, "bind_local_codex_thread", bind_mock)
    monkeypatch.setattr(
        local_codex,
        "convert_to_task_dict",
        lambda task, db, user_id: {"id": task.id, "project_id": 0},
    )

    await local_codex.bind_local_codex_thread_endpoint(
        request=LocalCodexBindRequest(
            deviceId="device-abc",
            threadId="018f2d6b-8c7a-7abc-9def-0123456789ab",
            teamId=11,
            cwd="/tmp/client-controlled",
        ),
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    _, bind_kwargs = bind_mock.call_args
    assert bind_kwargs["cwd"] is None


@pytest.mark.asyncio
async def test_list_local_codex_threads_maps_offline_device_to_conflict(
    monkeypatch,
) -> None:
    from app.api.endpoints import local_codex
    from app.services.device.command_service import DeviceCommandError

    service_mock = AsyncMock(side_effect=DeviceCommandError("Device 'dev' is offline"))
    monkeypatch.setattr(local_codex, "execute_configured_device_command", service_mock)

    with pytest.raises(HTTPException) as exc_info:
        await local_codex.list_device_codex_threads(
            device_id="dev",
            limit=50,
            db=object(),
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 409
