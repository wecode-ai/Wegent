# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.distributed_lock import distributed_lock
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.workspace import ExecutionEnvironmentDefinition
from app.services import execution_environment_initialization
from app.services.device.runtime_route import normalize_execution_device_id
from app.services.workspaces.resource_mapping import execution_environment_values
from tests.utils.devices import SHARED_APP_DEVICE_ID, create_app_device

PRIMARY_REPOSITORY = {
    "name": "Wegent",
    "url": "https://github.com/wecode-ai/Wegent.git",
    "ref": "main",
    "path": "wegent",
    "primary": True,
}


def _remote_device() -> Kind:
    return Kind(
        kind="Device",
        name="remote-device",
        namespace="default",
        user_id=7,
        json={"spec": {"deviceType": "remote", "deviceId": "remote-device"}},
    )


class _InMemoryLock:
    """Deterministic stand-in for the Redis watchdog lock.

    The suite runs under pytest-xdist against a shared Redis, so tests using
    the same environment and device would otherwise collide on the real lock.
    """

    def __init__(self) -> None:
        self.held: set[str] = set()
        self.names: list[str] = []

    @asynccontextmanager
    async def acquire(self, lock_name: str, **_kwargs: object):
        self.names.append(lock_name)
        acquired = lock_name not in self.held
        if acquired:
            self.held.add(lock_name)
        try:
            yield acquired
        finally:
            self.held.discard(lock_name)


@pytest.fixture(autouse=True)
def initialization_lock(monkeypatch: pytest.MonkeyPatch) -> _InMemoryLock:
    lock = _InMemoryLock()
    monkeypatch.setattr(
        distributed_lock, "acquire_watchdog_context_async", lock.acquire
    )
    return lock


@pytest.mark.asyncio
async def test_initialization_serializes_concurrent_prepares_per_device(
    monkeypatch: pytest.MonkeyPatch,
    initialization_lock: _InMemoryLock,
) -> None:
    # A second preparation for the same environment on the same device must
    # fail fast with a clear conflict instead of racing on the clone target.
    monkeypatch.setattr(
        execution_environment_initialization,
        "sync_git_accounts_to_device",
        AsyncMock(),
    )
    started = asyncio.Event()
    release = asyncio.Event()

    async def _execute(**_kwargs: object) -> dict[str, object]:
        started.set()
        await release.wait()
        return {
            "success": True,
            "exit_code": 0,
            "stdout": {"workspacePath": "/workspace/environment"},
        }

    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        AsyncMock(side_effect=_execute),
    )
    db = MagicMock()
    db.get.return_value = object()
    definition = {"repositories": [PRIMARY_REPOSITORY], "setup_steps": []}
    first = asyncio.create_task(
        execution_environment_initialization.initialize_execution_environment(
            db=db,
            device=_remote_device(),
            environment_id="project-1",
            definition=definition,
        )
    )
    await started.wait()

    with pytest.raises(HTTPException) as excinfo:
        await execution_environment_initialization.initialize_execution_environment(
            db=db,
            device=_remote_device(),
            environment_id="project-1",
            definition=definition,
        )

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail == (
        "Execution environment initialization is already in progress on this device"
    )
    release.set()
    assert (await first)["status"] == "ready"
    assert initialization_lock.names == [
        "execution-environment-init:project-1:remote-device",
        "execution-environment-init:project-1:remote-device",
    ]


@pytest.mark.asyncio
async def test_initialization_lock_is_scoped_per_environment_and_device(
    monkeypatch: pytest.MonkeyPatch,
    initialization_lock: _InMemoryLock,
) -> None:
    # A preparation in flight must not block a different environment on the
    # same device or the same environment on a different device.
    monkeypatch.setattr(
        execution_environment_initialization,
        "sync_git_accounts_to_device",
        AsyncMock(),
    )
    started = asyncio.Event()
    release = asyncio.Event()
    executions = 0

    async def _execute(**_kwargs: object) -> dict[str, object]:
        nonlocal executions
        executions += 1
        if executions == 1:
            started.set()
            await release.wait()
        return {
            "success": True,
            "exit_code": 0,
            "stdout": {"workspacePath": "/workspace/environment"},
        }

    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        AsyncMock(side_effect=_execute),
    )
    db = MagicMock()
    db.get.return_value = object()
    definition = {"repositories": [PRIMARY_REPOSITORY], "setup_steps": []}
    first = asyncio.create_task(
        execution_environment_initialization.initialize_execution_environment(
            db=db,
            device=_remote_device(),
            environment_id="project-1",
            definition=definition,
        )
    )
    await started.wait()

    other_environment = (
        await execution_environment_initialization.initialize_execution_environment(
            db=db,
            device=_remote_device(),
            environment_id="project-2",
            definition=definition,
        )
    )
    other_device = Kind(
        kind="Device",
        name="other-remote-device",
        namespace="default",
        user_id=7,
        json={"spec": {"deviceType": "remote", "deviceId": "other-remote-device"}},
    )
    other_device_state = (
        await execution_environment_initialization.initialize_execution_environment(
            db=db,
            device=other_device,
            environment_id="project-1",
            definition=definition,
        )
    )
    release.set()

    assert other_environment["status"] == "ready"
    assert other_device_state["status"] == "ready"
    assert (await first)["status"] == "ready"
    assert initialization_lock.names == [
        "execution-environment-init:project-1:remote-device",
        "execution-environment-init:project-2:remote-device",
        "execution-environment-init:project-1:other-remote-device",
    ]


@pytest.mark.asyncio
async def test_initialization_syncs_git_credentials_to_remote_devices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        AsyncMock(
            return_value={
                "success": True,
                "exit_code": 0,
                "stdout": {"workspacePath": "/workspace/environment"},
            }
        ),
    )
    sync = AsyncMock()
    monkeypatch.setattr(
        execution_environment_initialization,
        "sync_git_accounts_to_device",
        sync,
    )
    db = MagicMock()
    db.get.return_value = object()

    await execution_environment_initialization.initialize_execution_environment(
        db=db,
        device=_remote_device(),
        environment_id="project-1",
        definition={"repositories": [PRIMARY_REPOSITORY], "setup_steps": []},
    )

    sync.assert_awaited_once()
    assert sync.await_args.kwargs["device_id"] == "remote-device"
    assert sync.await_args.kwargs["allow_empty"] is False


@pytest.mark.asyncio
async def test_initialization_keeps_device_credentials_when_owner_has_no_accounts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.device.git_credentials import (
        DeviceGitCredentialResolutionError,
    )

    execute = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": {"workspacePath": "/workspace/environment"},
        }
    )
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        execute,
    )
    monkeypatch.setattr(
        execution_environment_initialization,
        "sync_git_accounts_to_device",
        AsyncMock(side_effect=DeviceGitCredentialResolutionError("none")),
    )
    db = MagicMock()
    db.get.return_value = object()

    result = (
        await execution_environment_initialization.initialize_execution_environment(
            db=db,
            device=_remote_device(),
            environment_id="project-1",
            definition={"repositories": [PRIMARY_REPOSITORY], "setup_steps": []},
        )
    )

    assert result["status"] == "ready"
    assert execute.await_count == 1


@pytest.mark.asyncio
async def test_initialization_surfaces_credential_sync_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock()
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        execute,
    )
    monkeypatch.setattr(
        execution_environment_initialization,
        "sync_git_accounts_to_device",
        AsyncMock(side_effect=RuntimeError("device rejected the sync")),
    )
    db = MagicMock()
    db.get.return_value = object()

    result = (
        await execution_environment_initialization.initialize_execution_environment(
            db=db,
            device=_remote_device(),
            environment_id="project-1",
            definition={"repositories": [PRIMARY_REPOSITORY], "setup_steps": []},
        )
    )

    assert result["status"] == "error"
    assert result["error"] == "device rejected the sync"
    execute.assert_not_called()


@pytest.mark.asyncio
async def test_initialization_does_not_sync_git_credentials_to_app_devices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        AsyncMock(
            return_value={
                "success": True,
                "exit_code": 0,
                "stdout": {"workspacePath": "/workspace/environment"},
            }
        ),
    )
    sync = AsyncMock()
    monkeypatch.setattr(
        execution_environment_initialization,
        "sync_git_accounts_to_device",
        sync,
    )

    await execution_environment_initialization.initialize_execution_environment(
        db=object(),
        device=Kind(
            kind="Device",
            name="shared-app-device-name",
            namespace="default",
            user_id=7,
            json={"spec": {"deviceType": "app", "deviceId": "shared-app-device-name"}},
        ),
        environment_id="project-1",
        definition={"repositories": [PRIMARY_REPOSITORY], "setup_steps": []},
    )

    sync.assert_not_called()


@pytest.mark.asyncio
async def test_initialization_prepares_device_and_returns_ready_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": {"workspacePath": "/workspace/environment-project-1"},
        }
    )
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        execute,
    )
    device = Kind(
        kind="Device",
        name="device-kind-name",
        namespace="default",
        user_id=7,
        json={"spec": {"deviceId": "device-runtime-id"}},
    )
    definition = {
        "repositories": [
            {
                "name": "Wegent",
                "url": "https://github.com/wecode-ai/Wegent.git",
                "ref": "main",
                "path": "wegent",
                "primary": True,
            },
            {
                "name": "SDK",
                "url": "https://github.com/example/sdk.git",
                "ref": "v2",
                "path": "deps/sdk",
                "primary": False,
            },
        ],
        "setup_steps": [
            {"command": "corepack enable", "working_directory": "wegent"},
            {"command": "pnpm install", "working_directory": "wegent"},
        ],
    }

    result = (
        await execution_environment_initialization.initialize_execution_environment(
            db=object(),
            device=device,
            environment_id="project-1",
            definition=definition,
        )
    )

    assert result["status"] == "ready"
    assert result["prepared_device_id"] == "device-runtime-id"
    assert result["prepared_workspace_path"] == "/workspace/environment-project-1"
    assert isinstance(result["prepared_at"], str)
    assert result["prepared_at"].endswith("+00:00")
    assert result["error"] == ""
    assert len(result["fingerprint"]) == 64
    command = execute.await_args.kwargs
    assert command["command_key"] == "environment_prepare"
    assert command["device_id"] == "device-kind-name"
    assert command["allow_internal"] is True
    payload = json.loads(command["args"][0])
    assert payload == {
        "environmentId": f"project-1-{result['fingerprint'][:12]}",
        "repositories": definition["repositories"],
        "setupSteps": definition["setup_steps"],
        "fingerprint": result["fingerprint"],
    }


@pytest.mark.asyncio
async def test_initialization_failure_returns_error_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        AsyncMock(
            return_value={
                "success": False,
                "exit_code": 1,
                "stderr": "setup failed",
            }
        ),
    )
    device = Kind(
        kind="Device",
        name="device-runtime-id",
        namespace="default",
        user_id=7,
        json={},
    )

    result = (
        await execution_environment_initialization.initialize_execution_environment(
            db=object(),
            device=device,
            environment_id="workspace-1",
            definition={
                "repositories": [PRIMARY_REPOSITORY],
                "setup_steps": [
                    {"command": "exit 1", "working_directory": ""},
                ],
            },
        )
    )

    assert result["status"] == "error"
    assert result["prepared_device_id"] == "device-runtime-id"
    assert result["prepared_workspace_path"] == ""
    assert result["prepared_at"] is None
    assert result["error"] == "setup failed"


@pytest.mark.asyncio
async def test_initialization_rejects_definition_without_primary_repository(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock()
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        execute,
    )
    device = Kind(
        kind="Device",
        name="device-runtime-id",
        namespace="default",
        user_id=7,
        json={},
    )

    with pytest.raises(HTTPException) as excinfo:
        await execution_environment_initialization.initialize_execution_environment(
            db=object(),
            device=device,
            environment_id="workspace-1",
            definition={"repositories": []},
        )

    assert excinfo.value.status_code == 422
    execute.assert_not_called()


@pytest.mark.asyncio
async def test_initialization_routes_app_device_by_unique_record_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": {"workspacePath": "/workspace/environment-project-1"},
        }
    )
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        execute,
    )
    device = Kind(
        id=42,
        kind="Device",
        name="shared-app-device-name",
        namespace="default",
        user_id=7,
        json={
            "spec": {
                "deviceType": "app",
                "deviceId": "shared-app-device-name",
            }
        },
    )

    result = (
        await execution_environment_initialization.initialize_execution_environment(
            db=object(),
            device=device,
            environment_id="project-1",
            definition={"repositories": [PRIMARY_REPOSITORY], "setup_steps": []},
        )
    )

    assert execute.await_args.kwargs["device_id"] == "app-record-42"
    assert result["status"] == "ready"
    assert result["prepared_device_id"] == "app-record-42"


@pytest.mark.asyncio
async def test_app_installations_sharing_one_logical_id_prepare_distinct_identities(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        AsyncMock(
            return_value={
                "success": True,
                "exit_code": 0,
                "stdout": {"workspacePath": "/workspace/environment"},
            }
        ),
    )
    devices = [create_app_device(test_db, user_id=test_user.id) for _ in range(2)]

    prepared = [
        await execution_environment_initialization.initialize_execution_environment(
            db=test_db,
            device=device,
            environment_id="project-1",
            definition={"repositories": [PRIMARY_REPOSITORY], "setup_steps": []},
        )
        for device in devices
    ]

    assert {device.name for device in devices} == {SHARED_APP_DEVICE_ID}
    assert [state["prepared_device_id"] for state in prepared] == [
        f"app-record-{devices[0].id}",
        f"app-record-{devices[1].id}",
    ]
    # The persisted identity must be the one queue rows carry, otherwise the
    # prepared worktree can never be matched back to its installation.
    for state in prepared:
        assert (
            normalize_execution_device_id(
                test_db,
                user_id=test_user.id,
                submitted_device_id=state["prepared_device_id"],
            )
            == state["prepared_device_id"]
        )


def test_execution_environment_values_expose_the_prepared_identity(
    test_db: Session,
    test_user: User,
) -> None:
    devices = [create_app_device(test_db, user_id=test_user.id) for _ in range(2)]
    grant = ResourceMember(
        resource_type=ResourceType.DEVICE.value,
        resource_id=devices[0].id,
        entity_type="project",
        entity_id="1",
        role=BaseRole.Developer.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=test_user.id,
    )
    test_db.add(grant)
    test_db.commit()

    values = [
        execution_environment_values(
            test_db,
            grant,
            device,
            connection_status="online",
        )["device_key"]
        for device in devices
    ]

    assert values == [
        f"app-record-{devices[0].id}",
        f"app-record-{devices[1].id}",
    ]


def test_definition_accepts_multiple_repositories_and_repository_scoped_steps() -> None:
    definition = ExecutionEnvironmentDefinition.model_validate(
        {
            "repositories": [
                {
                    "name": "Application",
                    "url": "https://github.com/example/application.git",
                    "path": "application",
                    "primary": True,
                },
                {
                    "name": "Shared SDK",
                    "url": "https://github.com/example/shared-sdk.git",
                    "path": "dependencies/shared-sdk",
                    "primary": False,
                },
            ],
            "setup_steps": [
                {
                    "command": "pnpm install",
                    "working_directory": "application/frontend",
                },
                {
                    "command": "uv sync",
                    "working_directory": "dependencies/shared-sdk",
                },
            ],
        }
    )

    assert len(definition.repositories) == 2
    assert definition.repositories[0].primary is True
    assert definition.setup_steps[1].working_directory == "dependencies/shared-sdk"


@pytest.mark.parametrize(
    "repositories",
    [
        [
            {
                "name": "Application",
                "url": "https://github.com/example/application.git",
                "path": "source",
                "primary": True,
            },
            {
                "name": "Nested dependency",
                "url": "https://github.com/example/dependency.git",
                "path": "source/dependency",
                "primary": False,
            },
        ],
        [
            {
                "name": "Application",
                "url": "https://github.com/example/application.git",
                "path": "application",
                "primary": True,
            },
            {
                "name": "Application",
                "url": "https://github.com/example/other.git",
                "path": "other",
                "primary": False,
            },
        ],
    ],
)
def test_definition_rejects_ambiguous_repository_layouts(
    repositories: list[dict[str, object]],
) -> None:
    with pytest.raises(ValidationError):
        ExecutionEnvironmentDefinition.model_validate(
            {"repositories": repositories, "setup_steps": []}
        )


def test_definition_rejects_setup_steps_outside_repositories() -> None:
    with pytest.raises(ValidationError):
        ExecutionEnvironmentDefinition.model_validate(
            {
                "repositories": [
                    {
                        "name": "Application",
                        "url": "https://github.com/example/application.git",
                        "path": "application",
                        "primary": True,
                    }
                ],
                "setup_steps": [
                    {
                        "command": "pnpm install",
                        "working_directory": "unrelated",
                    }
                ],
            }
        )
