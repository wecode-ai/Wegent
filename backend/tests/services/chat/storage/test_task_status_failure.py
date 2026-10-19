"""Tests for terminal status persistence failure propagation."""

from unittest.mock import MagicMock, patch

import pytest

from app.models.subtask import SubtaskStatus
from app.models.task import TaskResource
from app.services.chat.storage.db import DatabaseHandler


def test_task_status_failure_propagates_from_subtask_update():
    """Task persistence failures reach the terminal status emitter."""
    handler = DatabaseHandler()
    task = TaskResource(
        id=20,
        user_id=30,
        kind="Task",
        name="task-20",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": "task-20", "namespace": "default"},
            "spec": {
                "title": "Existing task",
                "prompt": "Previous prompt",
                "teamRef": {"name": "quickstart", "namespace": "default"},
                "workspaceRef": {"name": "workspace-20", "namespace": "default"},
                "is_group_chat": False,
            },
            "status": {
                "state": "Available",
                "status": "RUNNING",
                "progress": 50,
            },
        },
        is_active=True,
        is_group_chat=False,
    )
    subtask = MagicMock(
        id=10,
        task_id=20,
        status=SubtaskStatus.RUNNING,
        result=None,
        error_message=None,
        executor_name="",
    )

    class Context:
        """Provide a fresh mocked database session for each sync phase."""

        def __enter__(self):
            """Enter the mocked database session."""
            return MagicMock()

        def __exit__(self, *args):
            """Leave the mocked database session without suppressing errors."""
            return False

    with (
        patch(
            "app.services.chat.storage.db._db_session",
            return_value=Context(),
        ),
        patch(
            "app.services.chat.storage.db.task_stores.subtask_store.get_by_id",
            return_value=subtask,
        ),
        patch("app.services.chat.storage.db.task_stores.subtask_store.update_fields"),
        patch(
            "app.services.chat.storage.db.task_stores.task_store.get_task_by_states",
            return_value=task,
        ),
        patch(
            "app.services.chat.storage.db.task_stores.subtask_store.list_assistant_by_task",
            return_value=[subtask],
        ),
        patch(
            "app.services.adapters.collaboration_strategy."
            "CollaborationStrategyFactory.get_strategy_for_task",
        ) as strategy_factory,
        patch(
            "app.services.chat.storage.db.task_stores.task_store.update_json",
            side_effect=RuntimeError("task status failed"),
        ),
    ):
        strategy = MagicMock()
        strategy.get_task_status_on_subtask_complete.return_value = ("COMPLETED", 100)
        strategy.get_auto_advance_info.return_value = None
        strategy_factory.return_value = strategy

        with pytest.raises(RuntimeError, match="task status failed"):
            handler._update_subtask_sync(
                subtask_id=10,
                status="COMPLETED",
                result={"value": "done"},
            )
