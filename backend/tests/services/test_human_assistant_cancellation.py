"""Cancellation identities remain scoped when an Issue reuses a private Task."""

import json
from unittest.mock import MagicMock, patch

from app.models.loop_item_execution import LoopItemExecution
from app.tasks.robot_queue_tasks import emit_runtime_cancels


def test_two_assignment_executions_at_one_task_have_distinct_cancel_requests():
    executions = [
        LoopItemExecution(
            id=execution_id,
            executor_owner_user_id=7,
            execution_device_id="owner-device",
            runtime_device_id="owner-device",
            runtime_task_id="reused-private-task",
            execution_payload=json.dumps(
                {"runtime_selection": {"executor_kind": "human_assistant"}}
            ),
            status="cancel_requested",
        )
        for execution_id in (41, 42)
    ]
    client = MagicMock()
    client.__enter__.return_value = client
    client.post.return_value.status_code = 200
    client.post.return_value.json.return_value = {"accepted": True}

    with patch("httpx.Client", return_value=client):
        accepted = emit_runtime_cancels(executions)

    assert client.post.call_count == 2
    payloads = [call.kwargs["json"]["payload"] for call in client.post.call_args_list]
    assert [payload["executionId"] for payload in payloads] == ["41", "42"]
    assert all(payload["taskId"] == "reused-private-task" for payload in payloads)
    assert accepted == {41, 42}
    assert all(execution.status == "cancel_requested" for execution in executions)
