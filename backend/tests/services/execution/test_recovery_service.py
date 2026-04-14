# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for executor recovery service edge cases."""

import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.recovery_service import ExecutorRecoveryService
from shared.models.execution import ExecutionRequest

recovery_module = importlib.import_module("app.services.execution.recovery_service")


@pytest.mark.asyncio
async def test_recover_raises_when_archive_is_expired():
    """Expired archives should hard-fail recovery."""
    service = ExecutorRecoveryService()
    db = MagicMock()
    subtask = SimpleNamespace(id=11, executor_name="old", executor_namespace="")
    task = SimpleNamespace(id=22)
    request = ExecutionRequest(task_id=22, subtask_id=11)

    with patch.object(
        recovery_module.archive_service,
        "check_archive_available",
        return_value=(False, None, "expired"),
    ):
        with pytest.raises(RuntimeError, match="has expired"):
            await service.recover(
                db=db,
                subtask=subtask,
                task=task,
                request=request,
            )


@pytest.mark.asyncio
async def test_recover_without_archive_uses_normal_clone():
    """Missing archives should recreate executor with git clone enabled."""
    service = ExecutorRecoveryService()
    db = MagicMock()
    subtask = SimpleNamespace(
        id=11,
        executor_name="old",
        executor_namespace="",
        executor_deleted_at=True,
    )
    task = SimpleNamespace(id=22)
    request = ExecutionRequest(
        task_id=22,
        subtask_id=11,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "Agno", "agent_config": {"model": "test"}}],
        executor_name="old",
    )
    prepared_executor = SimpleNamespace(
        container_name="new-executor",
        executor_namespace="wegent-pod",
    )
    observed = {}

    with (
        patch.object(
            recovery_module.archive_service,
            "check_archive_available",
            return_value=(False, None, None),
        ),
        patch.object(
            service,
            "_prepare_executor",
            AsyncMock(
                side_effect=lambda current_request, _skip_git_clone: (
                    observed.setdefault(
                        "before",
                        (
                            current_request.executor_name,
                            current_request.skip_git_clone,
                            current_request.bot,
                        ),
                    )
                    and (prepared_executor, None)
                )
            ),
        ) as prepare_executor_mock,
    ):
        result = await service.recover(
            db=db,
            subtask=subtask,
            task=task,
            request=request,
        )

    assert result == {
        "executor_name": "new-executor",
        "executor_namespace": "wegent-pod",
    }
    # Service no longer updates subtask - caller should update current subtask
    # Historical subtask should keep original values
    assert subtask.executor_name == "old"  # Unchanged
    assert subtask.executor_namespace == ""  # Unchanged
    assert subtask.executor_deleted_at is True  # Unchanged
    assert request.executor_name == "new-executor"
    assert request.executor_namespace == "wegent-pod"
    assert request.skip_git_clone is False
    assert observed["before"] == (
        None,
        False,
        [{"shell_type": "Agno", "agent_config": {"model": "test"}}],
    )
    prepare_executor_mock.assert_awaited_once_with(request, False)


@pytest.mark.asyncio
async def test_recover_with_archive_continues_when_restore_fails():
    """Restore failures should keep the recreated sandbox and proceed."""
    service = ExecutorRecoveryService()
    db = MagicMock()
    subtask = SimpleNamespace(
        id=11,
        executor_name="old",
        executor_namespace="",
        executor_deleted_at=True,
    )
    task = SimpleNamespace(id=22)
    request = ExecutionRequest(
        task_id=22,
        subtask_id=11,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode", "agent_config": {"model": "test"}}],
        executor_name="old",
    )
    prepared_executor = SimpleNamespace(
        container_name="new-executor",
        executor_namespace="wegent-pod",
    )
    observed = {}

    with (
        patch.object(
            recovery_module.archive_service,
            "check_archive_available",
            return_value=(True, "workspace-archives/22/archive.tar.gz", None),
        ),
        patch.object(
            service,
            "_prepare_executor",
            AsyncMock(
                side_effect=lambda current_request, _skip_git_clone: (
                    observed.setdefault(
                        "before",
                        (
                            current_request.executor_name,
                            current_request.skip_git_clone,
                        ),
                    )
                    and (prepared_executor, None)
                )
            ),
        ) as prepare_executor_mock,
        patch.object(
            recovery_module.archive_service,
            "restore_workspace",
            AsyncMock(return_value=False),
        ) as restore_mock,
    ):
        result = await service.recover(
            db=db,
            subtask=subtask,
            task=task,
            request=request,
        )

    assert result == {
        "executor_name": "new-executor",
        "executor_namespace": "wegent-pod",
    }
    # Service no longer updates subtask - caller should update current subtask
    # Historical subtask should keep original values
    assert subtask.executor_name == "old"  # Unchanged
    assert subtask.executor_namespace == ""  # Unchanged
    assert subtask.executor_deleted_at is True  # Unchanged
    assert request.executor_name == "new-executor"
    assert request.executor_namespace == "wegent-pod"
    assert request.skip_git_clone is True
    assert observed["before"] == (None, True)
    prepare_executor_mock.assert_awaited_once_with(request, True)
    restore_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_recover_with_archive_persists_prepare_failure_detail():
    """Prepare failures should be written back to task and subtask state."""
    service = ExecutorRecoveryService()
    db = MagicMock()
    subtask = SimpleNamespace(
        id=11,
        executor_name="old",
        executor_namespace="wb-plat-ide",
        executor_deleted_at=True,
        error_message="",
        status="PENDING",
        progress=0,
    )
    task = SimpleNamespace(
        id=22,
        json={
            "status": {
                "state": "Available",
                "status": "PENDING",
                "progress": 0,
                "errorMessage": "",
            }
        },
    )
    request = ExecutionRequest(task_id=22, subtask_id=11)

    with (
        patch.object(
            recovery_module.archive_service,
            "check_archive_available",
            return_value=(True, "workspace-archives/22/archive.tar.gz", None),
        ),
        patch.object(
            service,
            "_prepare_executor",
            AsyncMock(
                return_value=(
                    None,
                    "executor-manager prepare failed: "
                    "Kubernetes API error: webhook refused request_id=req-123",
                )
            ),
        ),
    ):
        result = await service.recover(
            db=db,
            subtask=subtask,
            task=task,
            request=request,
        )

    assert result is None  # Failed recovery returns None
    # Service still updates subtask on failure via _persist_prepare_failure
    assert (
        subtask.error_message
        == "executor-manager prepare failed: Kubernetes API error: webhook refused request_id=req-123"
    )
    assert subtask.status == "FAILED"
    assert subtask.progress == 100
    assert task.json["status"]["status"] == "FAILED"
    assert task.json["status"]["progress"] == 100
    assert (
        task.json["status"]["errorMessage"]
        == "executor-manager prepare failed: Kubernetes API error: webhook refused request_id=req-123"
    )
    db.commit.assert_called()
