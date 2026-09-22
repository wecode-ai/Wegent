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
from app.services.device.runtime_route import (
    normalize_execution_device_id,
    runtime_device_route_id,
)
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
    assert result["workspace_path"] == "/workspace/environment-project-1"
    assert isinstance(result["prepared_at"], str)
    assert result["prepared_at"].endswith("+00:00")
    assert result["error"] == ""
    fingerprint = (
        execution_environment_initialization.execution_environment_fingerprint(
            definition
        )
    )
    command = execute.await_args.kwargs
    assert command["command_key"] == "environment_prepare"
    assert command["device_id"] == "device-kind-name"
    assert command["allow_internal"] is True
    payload = json.loads(command["args"][0])
    assert payload == {
        "environmentId": f"project-1-{fingerprint[:12]}",
        "repositories": definition["repositories"],
        "setupSteps": definition["setup_steps"],
        "fingerprint": fingerprint,
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

    assert result == {
        "status": "error",
        "workspace_path": "",
        "prepared_at": None,
        "error": "setup failed",
    }


@pytest.mark.asyncio
async def test_initialization_prepares_definition_without_repositories(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": {"workspacePath": "/workspace/environment-workspace-1"},
        }
    )
    sync = AsyncMock()
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        execute,
    )
    monkeypatch.setattr(
        execution_environment_initialization,
        "_sync_device_git_credentials",
        sync,
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
                "repositories": [],
                "setup_steps": [
                    {"command": "corepack enable", "working_directory": ""}
                ],
            },
        )
    )

    assert result["status"] == "ready"
    assert result["workspace_path"] == "/workspace/environment-workspace-1"
    sync.assert_not_awaited()
    payload = json.loads(execute.await_args.kwargs["args"][0])
    assert payload["repositories"] == []
    assert payload["setupSteps"] == [
        {"command": "corepack enable", "working_directory": ""}
    ]


@pytest.mark.asyncio
async def test_initialization_rejects_nonempty_definition_without_primary_repository(
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
            definition={"repositories": [{**PRIMARY_REPOSITORY, "primary": False}]},
        )

    assert excinfo.value.status_code == 422
    execute.assert_not_called()


@pytest.mark.asyncio
async def test_initialization_routes_app_device_by_unique_record_id(
    monkeypatch: pytest.MonkeyPatch,
    initialization_lock: _InMemoryLock,
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
    # The lock key carries the same record route the caller persists the
    # device entry under.
    assert initialization_lock.names == [
        "execution-environment-init:project-1:app-record-42"
    ]


@pytest.mark.asyncio
async def test_app_installations_sharing_one_logical_id_prepare_distinct_identities(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    assert [entry["status"] for entry in prepared] == ["ready", "ready"]
    device_keys = [runtime_device_route_id(device) for device in devices]
    assert device_keys == [
        f"app-record-{devices[0].id}",
        f"app-record-{devices[1].id}",
    ]
    assert [call.kwargs["device_id"] for call in execute.await_args_list] == (
        device_keys
    )
    # The merge key must be the identity queue rows carry, otherwise the
    # prepared worktree can never be matched back to its installation.
    for device_key in device_keys:
        assert (
            normalize_execution_device_id(
                test_db,
                user_id=test_user.id,
                submitted_device_id=device_key,
            )
            == device_key
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


def test_device_state_merge_keeps_other_devices_and_drops_legacy_state() -> None:
    preparing = execution_environment_initialization.preparing_execution_environment(
        {"repositories": [PRIMARY_REPOSITORY], "setup_steps": []}
    )
    assert "status" not in preparing
    assert preparing["devices"] == {}
    assert len(preparing["fingerprint"]) == 64

    ready = {
        "status": "ready",
        "workspace_path": "/workspace/device-a",
        "prepared_at": "2026-09-16T00:00:00+00:00",
        "error": "",
    }
    failed = {
        "status": "error",
        "workspace_path": "",
        "prepared_at": None,
        "error": "boom",
    }
    merged = (
        execution_environment_initialization.merge_execution_environment_device_state(
            preparing, device_key="device-a", device_state=ready
        )
    )
    merged = (
        execution_environment_initialization.merge_execution_environment_device_state(
            merged, device_key="device-b", device_state=failed
        )
    )

    assert merged["repositories"] == [PRIMARY_REPOSITORY]
    assert merged["devices"] == {"device-a": ready, "device-b": failed}

    # Rows persisted before per-device state lose their single-slot fields on
    # the next write instead of lingering beside the devices map.
    legacy = {
        "repositories": [],
        "status": "ready",
        "prepared_device_id": "old-device",
        "prepared_workspace_path": "/workspace/old",
        "prepared_at": None,
        "error": "",
    }
    merged = (
        execution_environment_initialization.merge_execution_environment_device_state(
            legacy, device_key="device-a", device_state=ready
        )
    )
    assert merged == {"repositories": [], "devices": {"device-a": ready}}


def test_saving_environment_keeps_device_states_only_for_matching_config() -> None:
    definition = {"repositories": [PRIMARY_REPOSITORY], "setup_steps": []}
    prepared = execution_environment_initialization.preparing_execution_environment(
        definition
    )
    ready = {
        "status": "ready",
        "workspace_path": "/workspace/remote",
        "prepared_at": "2026-09-16T00:00:00+00:00",
        "error": "",
    }
    prepared["devices"]["remote-device"] = ready

    unchanged = execution_environment_initialization.preparing_execution_environment(
        definition, prepared
    )
    assert unchanged["devices"] == {"remote-device": ready}
    assert unchanged["devices"] is not prepared["devices"]

    changed = execution_environment_initialization.preparing_execution_environment(
        {
            **definition,
            "setup_steps": [{"command": "pnpm install", "working_directory": "wegent"}],
        },
        prepared,
    )
    assert changed["devices"] == {}


@pytest.mark.asyncio
async def test_initialization_explains_missing_legacy_executor_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        execution_environment_initialization,
        "sync_git_accounts_to_device",
        AsyncMock(),
    )
    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        AsyncMock(
            return_value={
                "success": False,
                "exit_code": None,
                "stderr": "",
                "error": "No such file or directory (os error 2)",
            }
        ),
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
    assert "Upgrade or repair the Executor" in result["error"]


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


def test_definition_accepts_setup_steps_without_repositories() -> None:
    definition = ExecutionEnvironmentDefinition.model_validate(
        {
            "repositories": [],
            "setup_steps": [
                {"command": "mkdir -p generated", "working_directory": ""},
                {"command": "touch output.txt", "working_directory": "generated"},
            ],
        }
    )

    assert definition.repositories == []
    assert definition.setup_steps[1].working_directory == "generated"


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
