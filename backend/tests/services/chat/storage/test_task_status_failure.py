"""Tests for terminal status persistence failure propagation."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.models.subtask import SubtaskStatus
from app.services.chat.storage.db import DatabaseHandler


def test_task_status_failure_propagates_from_subtask_update():
    handler = DatabaseHandler()
    subtask = SimpleNamespace(
        id=10,
        task_id=20,
        status=SubtaskStatus.RUNNING,
        result=None,
        executor_name="",
    )

    class Context:
        def __enter__(self):
            return MagicMock()

        def __exit__(self, *args):
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
        patch(
            "app.services.chat.storage.db.task_stores.subtask_store.update_fields"
        ),
        patch.object(
            handler,
            "_update_task_status_sync",
            side_effect=RuntimeError("task status failed"),
        ),
    ):
        with pytest.raises(RuntimeError, match="task status failed"):
            handler._update_subtask_sync(
                subtask_id=10,
                status="COMPLETED",
                result={"value": "done"},
            )
