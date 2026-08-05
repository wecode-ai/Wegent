# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from executor_manager.models.sandbox import Sandbox, SandboxStatus
from executor_manager.routers import sandbox as sandbox_router


@pytest.mark.asyncio
async def test_create_sandbox_response_includes_runtime_metadata(mocker):
    """Create responses should expose enough runtime data for Backend restore."""
    created = Sandbox.create(
        shell_type="ClaudeCode",
        user_id=7,
        user_name="user7",
        timeout=1800,
        metadata={"task_id": 1385, "skip_git_clone": True},
    )
    created.status = SandboxStatus.RUNNING
    created.container_name = "sandbox-pod-1385"
    created.executor_namespace = "sandbox-ns"
    created.base_url = "http://sandbox.local:8000"

    manager = SimpleNamespace(
        create_sandbox=mocker.AsyncMock(return_value=(created, None))
    )
    mocker.patch.object(sandbox_router, "get_sandbox_manager", return_value=manager)

    response = await sandbox_router.create_sandbox(
        sandbox_router.CreateSandboxRequest(
            shell_type="ClaudeCode",
            user_id=7,
            user_name="user7",
            metadata={"task_id": 1385, "skip_git_clone": True},
        ),
        SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
    )

    assert response.base_url == "http://sandbox.local:8000"
    assert response.metadata == {"task_id": 1385, "skip_git_clone": True}
