# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the executor runtime HTTP client."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.execution import get_executor_runtime_client
from shared.models.execution import ExecutionRequest


@pytest.mark.asyncio
async def test_create_sandbox_uses_plural_sandboxes_endpoint():
    """Sandbox creation should call the plural sandboxes endpoint."""
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "sandbox_id": "1385",
        "container_name": "wegent-task-test",
        "base_url": "http://127.0.0.1:10001",
    }

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.post.return_value = response

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
    ):
        sandbox, error = await get_executor_runtime_client().create_sandbox(
            shell_type="ClaudeCode",
            user_id=2,
            user_name="user7",
        )

    assert error is None
    assert sandbox.sandbox_id == "1385"
    client.post.assert_awaited_once()
    assert (
        client.post.await_args.args[0]
        == "http://localhost:8001/executor-manager/sandboxes"
    )


@pytest.mark.asyncio
async def test_create_sandbox_restores_archived_task_workspace():
    """Sandbox creation should restore task archives when available."""
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "sandbox_id": "1385",
        "container_name": "wegent-task-test",
        "executor_namespace": "sandbox-ns",
        "base_url": "http://127.0.0.1:10001",
        "metadata": {"task_id": 1385, "skip_git_clone": True},
    }

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.post.return_value = response

    db = MagicMock()
    restore_task = SimpleNamespace(id=1385)

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
        patch("app.services.execution.SessionLocal", return_value=db),
        patch(
            "app.services.execution.sandbox_workspace_archive_service.prepare_restore_metadata",
            return_value=({"task_id": 1385, "skip_git_clone": True}, restore_task),
        ) as prepare_mock,
        patch(
            "app.services.execution.sandbox_workspace_archive_service.restore_sandbox_after_create",
            AsyncMock(return_value=True),
        ) as restore_mock,
    ):
        sandbox, error = await get_executor_runtime_client().create_sandbox(
            shell_type="ClaudeCode",
            user_id=2,
            user_name="user7",
            metadata={"task_id": 1385},
        )

    assert error is None
    assert sandbox.metadata == {"task_id": 1385, "skip_git_clone": True}
    prepare_mock.assert_called_once_with(db, {"task_id": 1385})
    restore_mock.assert_awaited_once_with(db, restore_task, sandbox)
    client.post.assert_awaited_once()
    assert client.post.await_args.kwargs["json"]["metadata"] == {
        "task_id": 1385,
        "skip_git_clone": True,
    }
    db.close.assert_called_once()


@pytest.mark.asyncio
async def test_create_sandbox_continues_when_restore_raises():
    """Unexpected restore failures should not fail sandbox creation."""
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "sandbox_id": "1385",
        "container_name": "wegent-task-test",
        "executor_namespace": "sandbox-ns",
        "base_url": "http://127.0.0.1:10001",
        "metadata": {"task_id": 1385, "skip_git_clone": True},
    }

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.post.return_value = response

    db = MagicMock()
    restore_task = SimpleNamespace(id=1385)

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
        patch("app.services.execution.SessionLocal", return_value=db),
        patch(
            "app.services.execution.sandbox_workspace_archive_service.prepare_restore_metadata",
            return_value=({"task_id": 1385, "skip_git_clone": True}, restore_task),
        ),
        patch(
            "app.services.execution.sandbox_workspace_archive_service.restore_sandbox_after_create",
            AsyncMock(side_effect=RuntimeError("restore failed")),
        ),
    ):
        sandbox, error = await get_executor_runtime_client().create_sandbox(
            shell_type="ClaudeCode",
            user_id=2,
            user_name="user7",
            metadata={"task_id": 1385},
        )

    assert error is None
    assert sandbox.sandbox_id == "1385"
    db.close.assert_called_once()


@pytest.mark.asyncio
async def test_prepare_executor_uses_prepare_endpoint():
    """Executor preparation should call the dedicated prepare endpoint."""
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "executor_name": "wegent-task-test",
        "executor_namespace": "wegent-pod",
    }

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.post.return_value = response

    request = ExecutionRequest(
        task_id=22,
        subtask_id=11,
        user={"id": 2, "name": "user7"},
        user_id=2,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
    )

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
    ):
        executor, error = await get_executor_runtime_client().prepare_executor(request)

    assert error is None
    assert executor.container_name == "wegent-task-test"
    assert executor.executor_namespace == "wegent-pod"
    client.post.assert_awaited_once()
    assert (
        client.post.await_args.args[0]
        == "http://localhost:8001/executor-manager/executors/prepare"
    )


@pytest.mark.asyncio
async def test_prepare_executor_returns_error_detail_from_http_response():
    """Executor preparation should preserve structured failure details."""
    request = ExecutionRequest(
        task_id=22,
        subtask_id=11,
        user={"id": 2, "name": "user7"},
        user_id=2,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
    )
    response = MagicMock()
    response.status_code = 500
    response.headers = {"X-Request-ID": "req-123"}
    response.json.return_value = {
        "detail": "Kubernetes API error: webhook refused",
    }
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "boom",
        request=MagicMock(),
        response=response,
    )

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.post.return_value = response

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
    ):
        executor, error = await get_executor_runtime_client().prepare_executor(request)

    assert executor is None
    assert error is not None
    assert "Kubernetes API error: webhook refused" in error
    assert "request_id=req-123" in error


@pytest.mark.asyncio
async def test_delete_sandbox_uses_task_scoped_endpoint():
    """Sandbox termination should call the sandbox delete endpoint."""
    response = MagicMock()
    response.raise_for_status.return_value = None

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.delete.return_value = response

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
        patch(
            "app.services.execution.sandbox_workspace_archive_service.archive_sandbox_before_delete",
            AsyncMock(return_value=None),
        ),
    ):
        success, error = await get_executor_runtime_client().delete_sandbox("1385")

    assert success is True
    assert error is None
    client.delete.assert_awaited_once()
    assert (
        client.delete.await_args.args[0]
        == "http://localhost:8001/executor-manager/sandboxes/1385"
    )


@pytest.mark.asyncio
async def test_delete_sandbox_archives_workspace_before_delete():
    """Sandbox termination should attempt workspace archive before deletion."""
    response = MagicMock()
    response.raise_for_status.return_value = None

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.delete.return_value = response

    db = MagicMock()

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
        patch("app.services.execution.SessionLocal", return_value=db),
        patch(
            "app.services.execution.sandbox_workspace_archive_service.archive_sandbox_before_delete",
            AsyncMock(return_value=SimpleNamespace(storageKey="archive")),
        ) as archive_mock,
    ):
        success, error = await get_executor_runtime_client().delete_sandbox("1385")

    assert success is True
    assert error is None
    archive_mock.assert_awaited_once_with(db, "1385")
    client.delete.assert_awaited_once()
    db.close.assert_called_once()


@pytest.mark.asyncio
async def test_get_sandbox_returns_none_on_not_found():
    """Sandbox lookup should treat 404 as no sandbox instead of an error."""
    response = MagicMock()
    response.status_code = 404

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.get.return_value = response

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
    ):
        payload, error = await get_executor_runtime_client().get_sandbox("1385")

    assert payload is None
    assert error is None
    client.get.assert_awaited_once()
    assert (
        client.get.await_args.args[0]
        == "http://localhost:8001/executor-manager/sandboxes/1385"
    )
