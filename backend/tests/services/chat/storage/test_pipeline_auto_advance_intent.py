# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for routing automatic pipeline advancement through the shared send path."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.chat.storage.db import DatabaseHandler


def test_task_status_update_returns_auto_advance_intent_without_creating_subtasks() -> (
    None
):
    handler = DatabaseHandler()
    task = SimpleNamespace(id=123, user_id=5, json={})
    completed_subtask = SimpleNamespace(
        id=9,
        status=SimpleNamespace(value="COMPLETED"),
        result={"value": "Done"},
    )
    task_status = SimpleNamespace(status="PENDING", progress=0, updatedAt=None)
    task_crd = MagicMock()
    task_crd.status = task_status
    task_crd.model_dump.return_value = {"status": {"status": "COMPLETED"}}

    strategy = MagicMock()
    strategy.get_task_status_on_subtask_complete.return_value = ("COMPLETED", 100)
    strategy.get_auto_advance_info.return_value = {
        "next_stage_index": 1,
        "next_bot_id": 20,
        "next_bot_name": "reviewer-bot",
        "context_passing": "previous_bot",
    }

    with patch("app.services.chat.storage.db._db_session") as db_session:
        db = db_session.return_value.__enter__.return_value
        with patch("app.services.chat.storage.db.task_stores.task_store") as task_store:
            task_store.get_task_by_states.return_value = task
            with patch(
                "app.services.chat.storage.db.task_stores.subtask_store"
            ) as subtask_store:
                subtask_store.list_assistant_by_task.return_value = [completed_subtask]
                with patch(
                    "app.schemas.kind.Task.model_validate", return_value=task_crd
                ):
                    with patch(
                        "app.services.adapters.collaboration_strategy."
                        "CollaborationStrategyFactory.get_strategy_for_task",
                        return_value=strategy,
                    ):
                        result = handler._update_task_status_sync(task.id)

    assert not hasattr(handler, "_auto_advance_pipeline")
    assert result is not None
    assert result.auto_advance is not None
    assert result.auto_advance.task_id == task.id
    assert result.auto_advance.user_id == task.user_id
    assert result.auto_advance.completed_subtask_id == completed_subtask.id
    assert result.auto_advance.advance_info["context_passing"] == "previous_bot"
    assert task_status.status == "PENDING"
    assert task_status.progress == 0
