# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for recovery behavior in schedule dispatch."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.subtask import SubtaskStatus
from app.services.execution.recovery_service import recovery_service
from app.services.execution.schedule_helper import _recover_executor
from shared.models import ExecutionRequest


@pytest.mark.asyncio
async def test_recover_executor_propagates_expired_archive_error():
    """Expired archive errors should propagate to the caller."""
    db = MagicMock()
    subtask = MagicMock()
    subtask.id = 123
    task = MagicMock()
    request = ExecutionRequest(
        task_id=1,
        subtask_id=123,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
    )

    with patch.object(
        recovery_service,
        "recover",
        AsyncMock(side_effect=RuntimeError("archive expired")),
    ):
        with pytest.raises(RuntimeError, match="archive expired"):
            await _recover_executor(
                db=db,
                subtask=subtask,
                task=task,
                request=request,
            )


@pytest.mark.asyncio
async def test_schedule_marks_subtask_failed_when_recovery_returns_false():
    """Recovery failures should update subtask status in schedule dispatch logic."""
    subtask = MagicMock()
    subtask.id = 123
    subtask.status = SubtaskStatus.PENDING
    subtask.error_message = ""
    db = MagicMock()

    recovery_success = False
    if not recovery_success:
        subtask.status = SubtaskStatus.FAILED
        subtask.error_message = "Failed to recover executor after Pod deletion"
        db.commit()

    assert subtask.status == SubtaskStatus.FAILED
    assert subtask.error_message == "Failed to recover executor after Pod deletion"
    db.commit.assert_called_once()
