# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from app.models.kind import Kind
from app.schemas.workspace import ExecutionEnvironmentDefinition
from app.services import execution_environment_initialization


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
                "repositories": [],
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
            definition={"repositories": [], "setup_steps": []},
        )
    )

    assert execute.await_args.kwargs["device_id"] == "app-record-42"
    assert result["status"] == "ready"
    assert result["prepared_device_id"] == "shared-app-device-name"


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
