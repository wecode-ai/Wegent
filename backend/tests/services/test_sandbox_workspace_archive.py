# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for applying workspace archives to task-backed sandboxes."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.sandbox_workspace_archive import SandboxWorkspaceArchiveService


@pytest.mark.asyncio
async def test_archive_sandbox_before_delete_uses_running_sandbox_runtime():
    """A running task-backed sandbox should be archived before deletion."""
    runtime_client = SimpleNamespace(
        get_sandbox=AsyncMock(
            return_value=(
                {
                    "status": "running",
                    "container_name": "sandbox-pod-22",
                    "executor_namespace": "sandbox-ns",
                },
                None,
            )
        )
    )
    service = SandboxWorkspaceArchiveService(runtime_client=runtime_client)
    db = MagicMock()
    task = SimpleNamespace(id=22)
    subtask = SimpleNamespace(id=11, task_id=22)
    archive_info = SimpleNamespace(storageKey="workspace-archives/22/archive.tar.gz")

    with (
        patch.object(service, "_load_task", return_value=task),
        patch.object(service, "_load_latest_subtask", return_value=subtask),
        patch(
            "app.services.sandbox_workspace_archive.archive_service.archive_workspace",
            AsyncMock(return_value=archive_info),
        ) as archive_mock,
    ):
        result = await service.archive_sandbox_before_delete(db, "22")

    assert result is archive_info
    runtime_client.get_sandbox.assert_awaited_once_with("22")
    archive_mock.assert_awaited_once_with(
        db=db,
        subtask=subtask,
        task=task,
        executor_name="sandbox-pod-22",
        executor_namespace="sandbox-ns",
    )
    db.commit.assert_called_once()


@pytest.mark.asyncio
async def test_prepare_restore_metadata_sets_skip_git_clone_when_archive_available():
    """Sandbox creation metadata should request clone skipping when archive exists."""
    service = SandboxWorkspaceArchiveService()
    db = MagicMock()
    task = SimpleNamespace(id=22)

    with (
        patch.object(service, "_load_task", return_value=task),
        patch(
            "app.services.sandbox_workspace_archive.archive_service.check_archive_available",
            return_value=(True, "workspace-archives/22/archive.tar.gz", None),
        ),
    ):
        metadata, restore_task = service.prepare_restore_metadata(
            db,
            {"task_id": 22, "source": "chat_shell"},
        )

    assert metadata == {
        "task_id": 22,
        "source": "chat_shell",
        "skip_git_clone": True,
    }
    assert restore_task is task


@pytest.mark.asyncio
async def test_restore_sandbox_after_create_restores_into_new_runtime():
    """A restored sandbox should extract the archived workspace into its new Pod."""
    service = SandboxWorkspaceArchiveService()
    db = MagicMock()
    task = SimpleNamespace(id=22)
    sandbox = SimpleNamespace(
        container_name="sandbox-pod-22-new",
        executor_namespace="sandbox-ns",
    )

    with patch(
        "app.services.sandbox_workspace_archive.archive_service.restore_workspace",
        AsyncMock(return_value=True),
    ) as restore_mock:
        result = await service.restore_sandbox_after_create(db, task, sandbox)

    assert result is True
    restore_mock.assert_awaited_once_with(
        db=db,
        task=task,
        executor_name="sandbox-pod-22-new",
        executor_namespace="sandbox-ns",
    )
