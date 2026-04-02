# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for executor recovery service edge cases."""

import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.recovery_service import ExecutorRecoveryService

recovery_module = importlib.import_module("app.services.execution.recovery_service")


@pytest.mark.asyncio
async def test_recover_raises_when_archive_is_expired():
    """Expired archives should hard-fail recovery."""
    service = ExecutorRecoveryService()
    db = MagicMock()
    subtask = SimpleNamespace(id=11, executor_name="old", executor_namespace="")
    task = SimpleNamespace(id=22)

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
                user_id=7,
                user_name="yunpeng7",
            )


@pytest.mark.asyncio
async def test_recover_without_archive_uses_normal_clone():
    """Missing archives should recreate sandbox with git clone enabled."""
    service = ExecutorRecoveryService()
    db = MagicMock()
    subtask = SimpleNamespace(
        id=11,
        executor_name="old",
        executor_namespace="",
        executor_deleted_at=True,
    )
    task = SimpleNamespace(id=22)
    sandbox = SimpleNamespace(container_name="new-executor")

    with (
        patch.object(
            recovery_module.archive_service,
            "check_archive_available",
            return_value=(False, None, None),
        ),
        patch.object(
            service,
            "_create_sandbox",
            AsyncMock(return_value=(sandbox, None)),
        ) as create_sandbox_mock,
    ):
        result = await service.recover(
            db=db,
            subtask=subtask,
            task=task,
            user_id=7,
            user_name="yunpeng7",
        )

    assert result is True
    assert subtask.executor_name == "new-executor"
    assert subtask.executor_namespace == "default"
    assert subtask.executor_deleted_at is False
    assert create_sandbox_mock.await_args.kwargs["skip_git_clone"] is False


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
    sandbox = SimpleNamespace(container_name="new-executor")

    with (
        patch.object(
            recovery_module.archive_service,
            "check_archive_available",
            return_value=(True, "workspace-archives/22/archive.tar.gz", None),
        ),
        patch.object(
            service,
            "_create_sandbox",
            AsyncMock(return_value=(sandbox, None)),
        ) as create_sandbox_mock,
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
            user_id=7,
            user_name="yunpeng7",
        )

    assert result is True
    assert subtask.executor_name == "new-executor"
    assert subtask.executor_namespace == "default"
    assert subtask.executor_deleted_at is False
    assert create_sandbox_mock.await_args.kwargs["skip_git_clone"] is True
    restore_mock.assert_awaited_once()
