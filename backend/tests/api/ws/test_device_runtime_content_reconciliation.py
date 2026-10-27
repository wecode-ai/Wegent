"""Runtime completion text survives outcome reports arriving first."""

from contextlib import nullcontext
from unittest.mock import AsyncMock, patch

import pytest

from app.api.ws import device_namespace
from app.models.project_chat_message import ProjectChatMessage
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.execution_snapshot import reconcile_execution_snapshot
from app.services.project_chat.service import project_chat_service
from tests.services.test_loop_item_executions import (
    _make_bot,
    _make_execution,
    _make_item,
    _make_project,
)
from tests.services.test_project_chat_execution_snapshot import report


@pytest.fixture(autouse=True)
def notification_delivery():
    with (
        patch(
            "app.services.wework_notifications.deliver_notification",
            new_callable=AsyncMock,
        ),
        patch(
            "app.services.wework_notifications.deliver_notification_payload",
            new_callable=AsyncMock,
        ),
    ):
        yield


@pytest.fixture
def managed_run(test_db, test_user):
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    task = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, task, bot, test_user)
    execution = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=execution.runtime_device_id,
        runtime_task_id=execution.runtime_task_id,
        event_name="response.created",
        payload={"eventSeq": 1, "subtaskId": "turn-1", "data": {}},
        owner_user_id=test_user.id,
    )
    activity = loop_item_execution_service._linked_activity(test_db, execution)
    activity.trigger_message_id = ""
    activity.content = "MODEL_CONT"
    test_db.commit()
    return task, execution, activity


def test_response_created_binds_runtime_turn_for_snapshot_reconciliation(
    test_db, test_user, managed_run
):
    _, execution, activity = managed_run
    assert activity.metadata_json["runtime_turn_id"] == "turn-1"
    snapshot = report(
        deviceId=execution.runtime_device_id,
        taskId=execution.runtime_task_id,
        completeHistory=False,
    )
    snapshot.turns[0].user_message_ids = []

    changed = reconcile_execution_snapshot(
        test_db, user_id=test_user.id, snapshot=snapshot
    )

    assert len(changed) == 1
    test_db.expire_all()
    assert execution.status == "completed"
    assert activity.status == "completed"
    assert activity.metadata_json["runtime_turn_id"] == "turn-1"


@pytest.mark.parametrize("order", ["snapshot_first", "event_first", "during_lock"])
def test_final_text_survives_managed_execution_outcome_race(
    test_db, test_user, managed_run, order
):
    task, execution, activity = managed_run
    device_id = execution.runtime_device_id
    runtime_task_id = execution.runtime_task_id

    def reconcile():
        previous_content = activity.content
        result = reconcile_execution_snapshot(
            test_db,
            user_id=test_user.id,
            snapshot=report(deviceId=device_id, taskId=runtime_task_id),
        )
        assert activity.content == previous_content
        return result

    lock_execution = loop_item_execution_service._lock_terminal_event_execution

    def lock_after_snapshot(*args, **kwargs):
        reconcile()
        return lock_execution(*args, **kwargs)

    if order == "snapshot_first":
        reconcile()
    lock = lock_after_snapshot if order == "during_lock" else lock_execution
    with (
        patch.object(
            device_namespace, "get_db_session", return_value=nullcontext(test_db)
        ),
        patch.object(device_namespace, "_publish_execution_item_change"),
        patch.object(
            loop_item_execution_service,
            "_lock_terminal_event_execution",
            side_effect=lock,
        ),
    ):
        device_namespace._project_chat_runtime_event_sync(
            device_id,
            {
                "event": "response.completed",
                "payload": {
                    "taskId": runtime_task_id,
                    "subtaskId": "turn-1",
                    "eventSeq": 2,
                    "data": {"text": "MODEL_CONTINUATION_OK"},
                },
            },
            user_id=test_user.id,
        )
    if order == "event_first":
        reconcile()

    test_db.expire_all()
    assert execution.status == "completed"
    assert activity.status == "completed"
    assert activity.content == "MODEL_CONTINUATION_OK"
    assert execution.last_event_seq == 2
    assert (
        loop_item_execution_service.execution_for_runtime(
            test_db,
            runtime_device_id=device_id,
            runtime_task_id=runtime_task_id,
            owner_user_id=test_user.id,
        )
        is None
    )
    completed_at = execution.completed_at
    task_version = task.version
    with (
        patch.object(
            device_namespace, "get_db_session", return_value=nullcontext(test_db)
        ),
        patch.object(project_chat_service, "_advance_task_to_review") as advance,
    ):
        for sequence in (1, 2):
            device_namespace._project_chat_runtime_event_sync(
                device_id,
                {
                    "event": "response.completed",
                    "payload": {
                        "taskId": runtime_task_id,
                        "subtaskId": "turn-1",
                        "eventSeq": sequence,
                        "data": {"text": "Duplicate must not replace the result"},
                    },
                },
                user_id=test_user.id,
            )
        advance.assert_not_called()
    test_db.expire_all()
    assert activity.content == "MODEL_CONTINUATION_OK"
    assert execution.completed_at == completed_at
    assert task.version == task_version


@pytest.mark.parametrize(
    "payload_change",
    [
        "duplicate",
        "reordered",
        "missing_sequence",
        "boolean_sequence",
        "missing_content",
    ],
)
def test_old_completed_turn_cannot_finish_a_new_continuation(
    test_db, test_user, managed_run, payload_change
):
    task, execution, activity = managed_run
    reconcile_execution_snapshot(
        test_db,
        user_id=test_user.id,
        snapshot=report(
            deviceId=execution.runtime_device_id, taskId=execution.runtime_task_id
        ),
    )
    payload = {
        "taskId": execution.runtime_task_id,
        "subtaskId": "turn-1",
        "eventSeq": 2,
        "data": {"text": "MODEL_CONTINUATION_OK"},
    }
    with patch.object(
        device_namespace, "get_db_session", return_value=nullcontext(test_db)
    ):
        device_namespace._project_chat_runtime_event_sync(
            execution.runtime_device_id,
            {"event": "response.completed", "payload": payload},
            user_id=test_user.id,
        )
    next_activity = ProjectChatMessage(
        message_id="new-turn",
        project_id=activity.project_id,
        task_id=activity.task_id,
        sender_type="agent",
        sender_id=activity.sender_id,
        sender_name=activity.sender_name,
        agent_id=activity.agent_id,
        status="streaming",
        content="New turn is still running",
        runtime_device_id=execution.runtime_device_id,
        runtime_task_id=execution.runtime_task_id,
        trigger_message_id="new-trigger",
        metadata_json={"run_id": "new-run", "run_status": "running"},
    )
    task.metadata_json = {
        **task.metadata_json,
        "ai_state": {
            "run_id": "new-run",
            "status": "running",
            "project_chat_message_id": "new-turn",
        },
    }
    test_db.add(next_activity)
    test_db.commit()
    task_version = task.version
    payload["data"] = {"text": "Old turn must not replace a new turn"}
    if payload_change == "reordered":
        payload["eventSeq"] = 1
    elif payload_change == "missing_sequence":
        del payload["eventSeq"]
    elif payload_change == "boolean_sequence":
        payload["eventSeq"] = True
    elif payload_change == "missing_content":
        payload["eventSeq"] = 3
        payload["data"] = {}
    with (
        patch.object(
            device_namespace, "get_db_session", return_value=nullcontext(test_db)
        ),
        patch.object(project_chat_service, "_advance_task_to_review") as advance,
    ):
        projected = device_namespace._project_chat_runtime_event_sync(
            execution.runtime_device_id,
            {"event": "response.completed", "payload": payload},
            user_id=test_user.id,
        )
        assert projected["message"] is None
        advance.assert_not_called()
    test_db.expire_all()
    assert activity.content == "MODEL_CONTINUATION_OK"
    assert next_activity.content == "New turn is still running"
    assert next_activity.status == "streaming"
    assert execution.status == "completed"
    assert execution.last_event_seq == 2
    assert task.version == task_version


def test_final_event_between_snapshot_commits_keeps_its_turn_identity(
    test_db, test_user, managed_run
):
    _, execution, activity = managed_run
    reconcile = loop_item_execution_service.reconcile_runtime_snapshot

    def reconcile_then_receive_final(*args, **kwargs):
        result = reconcile(*args, **kwargs)
        with patch.object(
            device_namespace, "get_db_session", return_value=nullcontext(test_db)
        ):
            device_namespace._project_chat_runtime_event_sync(
                execution.runtime_device_id,
                {
                    "event": "response.completed",
                    "payload": {
                        "taskId": execution.runtime_task_id,
                        "subtaskId": "turn-1",
                        "eventSeq": 2,
                        "data": {"text": "MODEL_CONTINUATION_OK"},
                    },
                },
                user_id=test_user.id,
            )
        return result

    with patch.object(
        loop_item_execution_service,
        "reconcile_runtime_snapshot",
        side_effect=reconcile_then_receive_final,
    ):
        reconcile_execution_snapshot(
            test_db,
            user_id=test_user.id,
            snapshot=report(
                deviceId=execution.runtime_device_id, taskId=execution.runtime_task_id
            ),
        )
    test_db.expire_all()
    assert activity.content == "MODEL_CONTINUATION_OK"
    assert execution.last_event_seq == 2
