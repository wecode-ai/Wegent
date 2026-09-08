# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for stuck-cancellation recovery in chat cancel operations."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.chat.operations import cancel as cancel_ops
from app.services.chat.operations.cancel import (
    finalize_stuck_cancellation,
    is_stream_alive,
)


def _task_json(status: str) -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": "task-1", "namespace": "default"},
        "spec": {
            "title": "t",
            "prompt": "p",
            "teamRef": {"name": "team", "namespace": "default"},
            "workspaceRef": {"name": "ws", "namespace": "default"},
        },
        "status": {"status": status, "progress": 0},
    }


def _streaming_status(subtask_id: int, last_activity_at: datetime) -> dict:
    return {
        "subtask_id": subtask_id,
        "user_id": 7,
        "username": "u",
        "started_at": last_activity_at.isoformat(),
        "last_activity_at": last_activity_at.isoformat(),
    }


class TestIsStreamAlive:
    @pytest.mark.asyncio
    async def test_dead_when_no_streaming_key(self):
        fake_manager = SimpleNamespace(
            get_task_streaming_status=AsyncMock(return_value=None)
        )
        with patch("app.services.chat.storage.session_manager", fake_manager):
            assert await is_stream_alive(1, 100) is False

    @pytest.mark.asyncio
    async def test_dead_when_key_belongs_to_other_subtask(self):
        fake_manager = SimpleNamespace(
            get_task_streaming_status=AsyncMock(
                return_value=_streaming_status(999, datetime.now(timezone.utc))
            )
        )
        with patch("app.services.chat.storage.session_manager", fake_manager):
            assert await is_stream_alive(1, 100) is False

    @pytest.mark.asyncio
    async def test_dead_when_activity_stale(self):
        stale = datetime.now(timezone.utc) - timedelta(seconds=7200)
        fake_manager = SimpleNamespace(
            get_task_streaming_status=AsyncMock(
                return_value=_streaming_status(100, stale)
            )
        )
        with patch("app.services.chat.storage.session_manager", fake_manager):
            assert await is_stream_alive(1, 100) is False

    @pytest.mark.asyncio
    async def test_alive_when_activity_fresh(self):
        fresh = datetime.now(timezone.utc) - timedelta(seconds=5)
        fake_manager = SimpleNamespace(
            get_task_streaming_status=AsyncMock(
                return_value=_streaming_status(100, fresh)
            )
        )
        with patch("app.services.chat.storage.session_manager", fake_manager):
            assert await is_stream_alive(1, 100) is True


class TestFinalizeStuckCancellation:
    def _patched_stores(self, task, subtasks):
        task_store = SimpleNamespace(
            get_regular_active_task=MagicMock(return_value=task),
            update_json=MagicMock(),
        )
        subtask_store = SimpleNamespace(
            list_by_task_statuses=MagicMock(return_value=subtasks),
            update_fields=MagicMock(),
        )
        return task_store, subtask_store

    def test_finalizes_running_assistant_and_task(self):
        task = SimpleNamespace(id=1, user_id=7, json=_task_json("CANCELLING"))
        assistant = SimpleNamespace(
            id=100, role=SubtaskRole.ASSISTANT, status=SubtaskStatus.RUNNING
        )
        user_subtask = SimpleNamespace(
            id=99, role=SubtaskRole.USER, status=SubtaskStatus.RUNNING
        )
        task_store, subtask_store = self._patched_stores(
            task, [user_subtask, assistant]
        )

        with (
            patch.object(cancel_ops, "task_store", task_store),
            patch.object(cancel_ops, "subtask_store", subtask_store),
        ):
            db = MagicMock()
            finalized = finalize_stuck_cancellation(db, task_id=1)

        assert finalized == [100]
        # Only the assistant subtask is cancelled
        assert subtask_store.update_fields.call_count == 1
        kwargs = subtask_store.update_fields.call_args.kwargs
        assert kwargs["subtask"] is assistant
        assert kwargs["status"] == SubtaskStatus.CANCELLED
        # Task is written as CANCELLED
        payload = task_store.update_json.call_args.kwargs["payload"]
        assert payload["status"]["status"] == "CANCELLED"
        db.commit.assert_called_once()

    def test_noop_when_task_already_final(self):
        task = SimpleNamespace(id=1, user_id=7, json=_task_json("CANCELLED"))
        task_store, subtask_store = self._patched_stores(task, [])

        with (
            patch.object(cancel_ops, "task_store", task_store),
            patch.object(cancel_ops, "subtask_store", subtask_store),
        ):
            db = MagicMock()
            finalized = finalize_stuck_cancellation(db, task_id=1)

        assert finalized == []
        subtask_store.list_by_task_statuses.assert_not_called()
        task_store.update_json.assert_not_called()
        db.commit.assert_not_called()

    def test_noop_when_task_missing(self):
        task_store, subtask_store = self._patched_stores(None, [])

        with (
            patch.object(cancel_ops, "task_store", task_store),
            patch.object(cancel_ops, "subtask_store", subtask_store),
        ):
            db = MagicMock()
            finalized = finalize_stuck_cancellation(db, task_id=1)

        assert finalized == []
        task_store.update_json.assert_not_called()


class TestRestCancelStuckRecovery:
    """REST cancel_task must finalize tasks stuck in CANCELLING."""

    def _make_service(self):
        from app.services.adapters.task_kinds.operations import TaskOperationsMixin

        return object.__new__(TaskOperationsMixin)

    @pytest.mark.asyncio
    async def test_stuck_cancelling_is_finalized(self):
        svc = self._make_service()
        old = datetime.now() - timedelta(seconds=3600)
        svc.get_task_detail = MagicMock(
            return_value={"status": "CANCELLING", "updated_at": old}
        )

        with (
            patch.object(
                cancel_ops, "finalize_stuck_cancellation", MagicMock(return_value=[100])
            ) as mock_finalize,
            patch.object(
                cancel_ops, "publish_task_cancelled_events", AsyncMock()
            ) as mock_publish,
        ):
            result = await svc.cancel_task(db=MagicMock(), task_id=1, user_id=7)

        assert result["status"] == "CANCELLED"
        mock_finalize.assert_called_once()
        mock_publish.assert_awaited_once_with(1, [100], 7)

    @pytest.mark.asyncio
    async def test_fresh_cancelling_returns_early(self):
        svc = self._make_service()
        svc.get_task_detail = MagicMock(
            return_value={"status": "CANCELLING", "updated_at": datetime.now()}
        )

        with patch.object(
            cancel_ops, "finalize_stuck_cancellation", MagicMock()
        ) as mock_finalize:
            result = await svc.cancel_task(db=MagicMock(), task_id=1, user_id=7)

        assert result["status"] == "CANCELLING"
        mock_finalize.assert_not_called()
