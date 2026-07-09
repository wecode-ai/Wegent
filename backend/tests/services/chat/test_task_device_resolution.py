# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for chat task execution device resolution."""

from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_FRONTEND
from app.models.kind import Kind
from app.models.project import Project
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.chat.task_device_resolution import (
    resolve_chat_task_device_id,
    resolve_chat_task_dispatch_device_id,
)
from app.services.device.local_provider import LocalDeviceProvider


def test_resolve_chat_task_device_prefers_explicit_device(
    test_db: Session,
    test_user: User,
):
    params = TaskCreationParams(
        message="pwd",
        device_id="explicit-device",
        project_id=49,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
        )
        == "explicit-device"
    )


def test_resolve_chat_task_device_maps_explicit_app_device_id(
    test_db: Session,
    test_user: User,
):
    test_db.add(
        _device(
            user_id=test_user.id,
            device_id="device-executor",
            app_device_id="app-device",
        )
    )
    test_db.commit()
    params = TaskCreationParams(
        message="pwd",
        device_id="app-device",
        project_id=49,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
        )
        == "device-executor"
    )


def test_resolve_chat_task_device_uses_frontend_project_config(
    test_db: Session,
    test_user: User,
):
    test_db.add(
        Project(
            id=49,
            user_id=test_user.id,
            name="workspace",
            client_origin=CLIENT_ORIGIN_FRONTEND,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "local",
                    "deviceId": "project-device",
                },
            },
        )
    )
    test_db.commit()

    params = TaskCreationParams(
        message="pwd",
        project_id=49,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
        )
        == "project-device"
    )


def test_resolve_chat_task_device_uses_cloud_project_device_id(
    test_db: Session,
    test_user: User,
):
    test_db.add(
        Project(
            id=51,
            user_id=test_user.id,
            name="cloud workspace",
            client_origin=CLIENT_ORIGIN_FRONTEND,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "cloud",
                    "deviceId": "cloud-crd",
                },
                "workspace": {
                    "source": "device_path",
                    "devicePath": "/workspace/repo",
                },
            },
        )
    )
    test_db.commit()

    params = TaskCreationParams(
        message="pwd",
        project_id=51,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
        )
        == "cloud-crd"
    )


def test_resolve_chat_task_device_uses_remote_project_device_id(
    test_db: Session,
    test_user: User,
):
    test_db.add(
        Project(
            id=52,
            user_id=test_user.id,
            name="remote workspace",
            client_origin=CLIENT_ORIGIN_FRONTEND,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "remote",
                    "deviceId": "remote-device",
                },
                "workspace": {
                    "source": "device_path",
                    "devicePath": "/srv/repo",
                },
            },
        )
    )
    test_db.commit()

    params = TaskCreationParams(
        message="pwd",
        project_id=52,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
        )
        == "remote-device"
    )


def test_resolve_chat_task_device_ignores_managed_cloud_without_device_id(
    test_db: Session,
    test_user: User,
):
    test_db.add(
        Project(
            id=53,
            user_id=test_user.id,
            name="managed cloud workspace",
            client_origin=CLIENT_ORIGIN_FRONTEND,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "cloud",
                },
                "workspace": {"source": "git", "checkoutPath": "repo"},
                "git": {"url": "https://github.com/example/repo.git"},
            },
        )
    )
    test_db.commit()

    params = TaskCreationParams(
        message="pwd",
        project_id=53,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
        )
        is None
    )


def test_resolve_chat_task_device_maps_project_app_device_id(
    test_db: Session,
    test_user: User,
):
    test_db.add(
        _device(
            user_id=test_user.id,
            device_id="device-executor",
            app_device_id="app-device",
        )
    )
    test_db.add(
        Project(
            id=49,
            user_id=test_user.id,
            name="workspace",
            client_origin=CLIENT_ORIGIN_FRONTEND,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "local",
                    "deviceId": "app-device",
                },
            },
        )
    )
    test_db.commit()

    params = TaskCreationParams(
        message="pwd",
        project_id=49,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
        )
        == "device-executor"
    )


def test_resolve_chat_task_device_uses_existing_task_project(
    test_db: Session,
    test_user: User,
):
    test_db.add(
        Project(
            id=49,
            user_id=test_user.id,
            name="workspace",
            client_origin=CLIENT_ORIGIN_FRONTEND,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "local",
                    "deviceId": "project-device",
                },
            },
        )
    )
    task = _task(task_id=2501, user_id=test_user.id, project_id=49)
    test_db.add(task)
    test_db.commit()

    params = TaskCreationParams(
        message="pwd",
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
            task=task,
        )
        == "project-device"
    )


def test_resolve_chat_task_device_falls_back_to_task_spec(
    test_db: Session,
    test_user: User,
):
    task = _task(task_id=2501, user_id=test_user.id, device_id="task-device")
    params = TaskCreationParams(
        message="pwd",
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert (
        resolve_chat_task_device_id(
            test_db,
            user_id=test_user.id,
            params=params,
            task=task,
        )
        == "task-device"
    )


@pytest.mark.asyncio
async def test_resolve_chat_dispatch_device_uses_only_online_local_device_when_project_device_is_stale(
    test_db: Session,
    test_user: User,
):
    test_db.add(_device(user_id=test_user.id, device_id="stale-device"))
    test_db.add(_device(user_id=test_user.id, device_id="online-device"))
    test_db.add(
        Project(
            id=49,
            user_id=test_user.id,
            name="workspace",
            client_origin=CLIENT_ORIGIN_FRONTEND,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "local",
                    "deviceId": "stale-device",
                },
            },
        )
    )
    test_db.commit()

    stale_key = LocalDeviceProvider.generate_online_key(test_user.id, "stale-device")
    online_key = LocalDeviceProvider.generate_online_key(test_user.id, "online-device")

    params = TaskCreationParams(
        message="pwd",
        project_id=49,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    with patch(
        "app.services.chat.task_device_resolution.cache_manager.mget",
        new=AsyncMock(
            return_value={
                stale_key: None,
                online_key: {"status": "online"},
            }
        ),
    ):
        assert (
            await resolve_chat_task_dispatch_device_id(
                test_db,
                user_id=test_user.id,
                params=params,
            )
            == "online-device"
        )


@pytest.mark.asyncio
async def test_resolve_chat_dispatch_device_uses_only_online_local_device_when_project_device_is_inactive(
    test_db: Session,
    test_user: User,
):
    test_db.add(
        _device(user_id=test_user.id, device_id="inactive-device", active=False)
    )
    test_db.add(_device(user_id=test_user.id, device_id="online-device"))
    test_db.add(
        Project(
            id=49,
            user_id=test_user.id,
            name="workspace",
            client_origin=CLIENT_ORIGIN_FRONTEND,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "local",
                    "deviceId": "inactive-device",
                },
            },
        )
    )
    test_db.commit()

    online_key = LocalDeviceProvider.generate_online_key(test_user.id, "online-device")
    params = TaskCreationParams(
        message="pwd",
        project_id=49,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    with patch(
        "app.services.chat.task_device_resolution.cache_manager.mget",
        new=AsyncMock(return_value={online_key: {"status": "online"}}),
    ):
        assert (
            await resolve_chat_task_dispatch_device_id(
                test_db,
                user_id=test_user.id,
                params=params,
            )
            == "online-device"
        )


@pytest.mark.asyncio
async def test_resolve_chat_dispatch_device_keeps_unknown_device_id_when_one_local_device_is_online(
    test_db: Session,
    test_user: User,
):
    test_db.add(_device(user_id=test_user.id, device_id="online-device"))
    test_db.commit()

    online_key = LocalDeviceProvider.generate_online_key(test_user.id, "online-device")
    params = TaskCreationParams(
        message="pwd",
        device_id="unknown-device",
        project_id=49,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    with patch(
        "app.services.chat.task_device_resolution.cache_manager.mget",
        new=AsyncMock(return_value={online_key: {"status": "online"}}),
    ):
        assert (
            await resolve_chat_task_dispatch_device_id(
                test_db,
                user_id=test_user.id,
                params=params,
            )
            == "unknown-device"
        )


def _device(
    *,
    user_id: int,
    device_id: str,
    app_device_id: str | None = None,
    active: bool = True,
) -> Kind:
    spec = {
        "deviceId": device_id,
        "deviceType": "local",
        "connectionMode": "websocket",
        "displayName": device_id,
    }
    if app_device_id:
        spec["appDeviceId"] = app_device_id
    return Kind(
        user_id=user_id,
        kind="Device",
        name=device_id,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": spec,
            "status": {"state": "Available"},
        },
        is_active=active,
    )


def _task(
    *,
    task_id: int,
    user_id: int,
    project_id: int = 0,
    device_id: str | None = None,
) -> TaskResource:
    spec = {
        "title": "Existing task",
        "prompt": "Previous prompt",
        "teamRef": {
            "name": "quickstart",
            "namespace": "default",
            "user_id": user_id,
        },
        "workspaceRef": {
            "name": f"workspace-{task_id}",
            "namespace": "default",
        },
        "is_group_chat": False,
    }
    if device_id:
        spec["device_id"] = device_id

    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": spec,
            "status": {
                "state": "Available",
                "status": "COMPLETED",
                "progress": 100,
                "result": {"value": "done"},
                "errorMessage": "",
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
                "completedAt": datetime.now().isoformat(),
            },
        },
        project_id=project_id,
        client_origin=CLIENT_ORIGIN_FRONTEND,
        is_active=True,
        is_group_chat=False,
    )
