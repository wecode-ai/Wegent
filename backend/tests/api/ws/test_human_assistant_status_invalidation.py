"""Assistant lifecycle updates invalidate the Issue without advancing its status."""

from types import SimpleNamespace
from unittest.mock import Mock

from app.api.ws import device_namespace


def test_personal_lifecycle_invalidates_even_when_issue_version_does_not_change():
    from unittest.mock import patch

    item = SimpleNamespace(id="issue", version=4)
    execution = SimpleNamespace(
        loop_item_id="issue", executor_type="human_assistant", executor_owner_user_id=7
    )
    db = Mock()
    db.get.return_value = item
    with patch.object(device_namespace, "publish_loop_item_changed") as publish:
        device_namespace._publish_execution_item_change(
            db, execution=execution, previous_version=4, execution_status_changed=True
        )
        publish.assert_called_once_with(
            db, item=item, reason="runtime_execution_status", actor_user_id=7
        )

        publish.reset_mock()
        device_namespace._publish_execution_item_change(
            db, execution=execution, previous_version=4, execution_status_changed=False
        )
        publish.assert_not_called()

        execution.executor_type = "project_robot"
        device_namespace._publish_execution_item_change(
            db, execution=execution, previous_version=4, execution_status_changed=True
        )
        publish.assert_not_called()
