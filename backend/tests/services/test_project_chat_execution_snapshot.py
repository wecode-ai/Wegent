"""Durable execution reconciliation must survive a fresh database read."""

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import ProjectChatSubscribe
from app.schemas.runtime_execution_snapshot import RuntimeExecutionSnapshot
from app.services.project_chat.execution_snapshot import reconcile_execution_snapshot
from app.services.project_chat.service import project_chat_service
from tests.services.test_project_chat_service import create_project, make_device


@pytest.fixture
def run(test_db, test_user):
    project = create_project(test_db, test_user)
    make_device(test_db, test_user, "snapshot-device")
    task = LoopItem(
        id="SNAPSHOT-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Task",
        status="in_progress",
        created_by_user_id=test_user.id,
    )
    row = ProjectChatMessage(
        message_id="run-message",
        project_id=project.id,
        task_id=task.id,
        sender_type="agent",
        sender_id="12",
        sender_name="Agent",
        agent_id="12",
        status="streaming",
        runtime_device_id="snapshot-device",
        runtime_task_id="runtime-1",
        trigger_message_id="trigger-1",
        metadata_json={"run_id": "run-1", "run_status": "running"},
        created_at=datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=5),
    )
    task.metadata_json = {
        "ai_state": {
            "run_id": "run-1",
            "project_chat_message_id": row.message_id,
            "status": "running",
        }
    }
    test_db.add_all([task, row])
    test_db.commit()
    return project, task, row


def report(**overrides):
    data = dict(
        deviceId="snapshot-device",
        taskId="runtime-1",
        running=False,
        completeHistory=True,
        turns=[
            dict(
                id="turn-1",
                userMessageIds=["trigger-1"],
                status="done",
                completedAt=datetime.now(UTC).isoformat(),
            )
        ],
    )
    data.update(overrides)
    return RuntimeExecutionSnapshot.model_validate(data)


@pytest.mark.parametrize(
    "outcome,expected",
    [("done", "completed"), ("failed", "failed"), ("cancelled", "cancelled")],
)
def test_persists_terminal_without_advancing_business_workflow(
    test_db, test_user, run, outcome, expected
):
    project, task, row = run
    snapshot = report()
    snapshot.turns[0].status = outcome
    changed = reconcile_execution_snapshot(
        test_db, user_id=test_user.id, snapshot=snapshot
    )
    assert changed[0]["status"] == expected
    test_db.expire_all()
    messages = project_chat_service.subscribe(
        test_db,
        user_id=test_user.id,
        request=ProjectChatSubscribe(project_id=project.id, task_id=task.id),
    )
    assert messages[0].status == expected
    assert messages[0].metadata["run_status"] == expected
    assert test_db.get(LoopItem, task.id).status == "in_progress"
    assert (
        test_db.get(LoopItem, task.id).metadata_json["ai_state"]["status"] == expected
    )
    version = task.version
    assert (
        reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=snapshot)
        == []
    )
    assert task.version == version


def test_old_turn_does_not_overwrite_new_run(test_db, test_user, run):
    _, task, row = run
    new = ProjectChatMessage(
        message_id="new-run",
        project_id=row.project_id,
        task_id=task.id,
        sender_type="agent",
        sender_id="12",
        sender_name="Agent",
        agent_id="12",
        status="streaming",
        runtime_device_id=row.runtime_device_id,
        runtime_task_id=row.runtime_task_id,
        trigger_message_id="trigger-2",
        metadata_json={"run_id": "run-2", "run_status": "running"},
    )
    task.metadata_json = {
        "ai_state": {
            "run_id": "run-2",
            "project_chat_message_id": "new-run",
            "status": "running",
        }
    }
    test_db.add(new)
    test_db.commit()
    reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=report())
    test_db.expire_all()
    assert row.status == "completed"
    assert new.status == "streaming"
    assert task.metadata_json["ai_state"]["status"] == "running"
    assert task.metadata_json["ai_state"]["run_id"] == "run-2"


@pytest.mark.parametrize("turn_key", ["subtaskId", "subtask_id"])
def test_final_event_restores_content_after_outcome_only_snapshot(
    test_db, test_user, run, turn_key
):
    _, task, row = run
    row.content = "MODEL_CONT"
    test_db.commit()
    reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=report())

    with patch.object(project_chat_service, "_advance_task_to_review") as advance:
        projected = project_chat_service.project_runtime_event(
            test_db,
            device_id="snapshot-device",
            runtime_task_id="runtime-1",
            event_name="response.completed",
            payload={turn_key: "turn-1", "data": {"text": "MODEL_CONTINUATION_OK"}},
        )
        assert projected is not None
        assert projected[0].content == "MODEL_CONTINUATION_OK"
        assert projected[0].status == "completed"
        advance.assert_not_called()
    test_db.expire_all()
    assert row.content == "MODEL_CONTINUATION_OK"
    assert task.status == "in_progress"


def test_late_final_content_does_not_complete_another_turn(test_db, test_user, run):
    _, task, row = run
    reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=report())
    new = ProjectChatMessage(
        message_id="next-turn",
        project_id=row.project_id,
        task_id=task.id,
        sender_type="agent",
        sender_id="12",
        sender_name="Agent",
        agent_id="12",
        status="streaming",
        runtime_device_id=row.runtime_device_id,
        runtime_task_id=row.runtime_task_id,
        trigger_message_id="trigger-2",
        metadata_json={"run_id": "run-2", "run_status": "running"},
    )
    test_db.add(new)
    test_db.commit()

    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id="snapshot-device",
        runtime_task_id="runtime-1",
        event_name="response.completed",
        payload={"subtaskId": "turn-1", "data": {"text": "Final first turn"}},
    )

    assert projected[0].message_id == row.message_id
    assert row.content == "Final first turn"
    assert new.status == "streaming"
    assert new.content == ""


def test_final_content_requires_the_reconciled_turn_identity(test_db, test_user, run):
    _, _, row = run
    row.content = "Partial"
    test_db.commit()
    reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=report())

    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id="snapshot-device",
        runtime_task_id="runtime-1",
        event_name="response.completed",
        payload={"subtaskId": "another-turn", "data": {"text": "Wrong turn"}},
    )

    assert projected is None
    assert row.content == "Partial"


@pytest.mark.parametrize(
    "change",
    ["partial", "running", "empty", "unknown", "duplicate", "old", "bound_elsewhere"],
)
def test_ambiguous_legacy_history_does_not_change_database(
    test_db, test_user, run, change
):
    _, _, row = run
    snapshot = report()
    snapshot.turns[0].user_message_ids = []
    if change == "partial":
        snapshot.complete_history = False
    elif change == "running":
        snapshot.running = True
    elif change == "empty":
        snapshot.turns = []
    elif change == "unknown":
        snapshot.turns[0].status = "unknown"
    elif change == "duplicate":
        snapshot.turns.append(snapshot.turns[0].model_copy())
    elif change == "old":
        snapshot.turns[0].completed_at = "2000-01-01T00:00:00Z"
    elif change == "bound_elsewhere":
        row.metadata_json = {**row.metadata_json, "runtime_turn_id": "other-turn"}
        test_db.commit()
    assert (
        reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=snapshot)
        == []
    )
    test_db.expire_all()
    assert row.status == "streaming"


def test_legacy_single_turn_can_be_saved(test_db, test_user, run):
    snapshot = report()
    snapshot.turns[0].user_message_ids = []
    assert (
        reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=snapshot)[
            0
        ]["status"]
        == "completed"
    )


def test_unowned_device_rejected(test_db, test_user, run):
    with pytest.raises(HTTPException) as exc:
        reconcile_execution_snapshot(
            test_db,
            user_id=test_user.id,
            snapshot=report(deviceId="someone-elses-device"),
        )
    assert exc.value.status_code == 403
    assert run[2].status == "streaming"


def test_wrong_task_does_not_change_any_run(test_db, test_user, run):
    assert (
        reconcile_execution_snapshot(
            test_db, user_id=test_user.id, snapshot=report(taskId="another-task")
        )
        == []
    )
    assert run[2].status == "streaming"


def test_legacy_completion_respects_mysql_session_timezone(test_db, test_user, run):
    from datetime import timedelta, timezone

    row = run[2]
    row.created_at = datetime(2026, 9, 16, 23, 20, 24)
    test_db.commit()
    snapshot = report()
    snapshot.turns[0].user_message_ids = []
    snapshot.turns[0].completed_at = "2026-09-16T15:21:24.984Z"
    with patch(
        "app.services.project_chat.execution_snapshot.database_datetime_timezone",
        return_value=timezone(timedelta(hours=8)),
    ):
        result = reconcile_execution_snapshot(
            test_db, user_id=test_user.id, snapshot=snapshot
        )
    assert result[0]["status"] == "completed"


@pytest.mark.parametrize(
    "root_status", ["running", "failed", "queued", "pending_approval"]
)
def test_managed_execution_root_remains_authoritative(
    test_db, test_user, run, root_status
):
    from app.models.loop_item_execution import LoopItemExecution

    project, task, row = run
    execution = LoopItemExecution(
        loop_item_id=task.id,
        cloud_project_id=project.id,
        executor_owner_user_id=test_user.id,
        agent_id="12",
        assigner_user_id=test_user.id,
        execution_environment="cloud",
        execution_device_id="snapshot-device",
        runtime_device_id="snapshot-device",
        runtime_task_id="runtime-1",
        status=root_status,
    )
    test_db.add(execution)
    test_db.flush()
    row.metadata_json = {**row.metadata_json, "execution_id": str(execution.id)}
    test_db.commit()
    original_metadata = dict(row.metadata_json)
    changed = reconcile_execution_snapshot(
        test_db, user_id=test_user.id, snapshot=report()
    )
    test_db.expire_all()
    if root_status == "running":
        assert execution.status == "completed"
        assert row.status == "completed"
        assert changed[0]["status"] == "completed"
    else:
        assert execution.status == root_status
        assert row.status == "streaming"
        assert row.metadata_json == original_metadata
        assert changed == []


@pytest.mark.parametrize(
    "mismatch", [None, "turn", "execution", "failed", "cancelled", "sequence"]
)
def test_device_final_content_after_managed_snapshot(
    test_db, test_user, run, monkeypatch, mismatch
):
    from app.api.ws.device_namespace import _project_chat_runtime_event_sync
    from app.models.loop_item_execution import LoopItemExecution

    project, task, row = run
    execution = LoopItemExecution(
        loop_item_id=task.id,
        cloud_project_id=project.id,
        executor_owner_user_id=test_user.id,
        agent_id="12",
        execution_environment="cloud",
        execution_device_id="snapshot-device",
        runtime_device_id="snapshot-device",
        runtime_task_id="runtime-1",
        status="running",
        last_event_seq=10,
    )
    test_db.add(execution)
    test_db.flush()
    row.metadata_json = {**row.metadata_json, "execution_id": execution.id}
    test_db.commit()
    from app.services.loop_item_executions.service import loop_item_execution_service

    original_handle = loop_item_execution_service.handle_runtime_event
    reconciled = {}

    def reconcile_before_event(db, **kwargs):
        reconcile_execution_snapshot(db, user_id=test_user.id, snapshot=report())
        if mismatch in {"failed", "cancelled"}:
            execution.status = mismatch
        elif mismatch == "execution":
            row.metadata_json = {**row.metadata_json, "execution_id": execution.id + 1}
        db.commit()
        advance.reset_mock()
        reconciled.update(
            version=execution.version, task_version=task.version, content=row.content
        )
        return original_handle(db, **kwargs)

    monkeypatch.setattr(
        loop_item_execution_service, "handle_runtime_event", reconcile_before_event
    )

    @contextmanager
    def same_session():
        yield test_db

    monkeypatch.setattr("app.api.ws.device_namespace.get_db_session", same_session)
    with patch.object(project_chat_service, "_advance_task_to_review") as advance:
        projected = _project_chat_runtime_event_sync(
            "snapshot-device",
            {
                "event": "response.completed",
                "payload": {
                    "taskId": "runtime-1",
                    "subtaskId": "wrong-turn" if mismatch == "turn" else "turn-1",
                    "eventSeq": 10 if mismatch == "sequence" else 11,
                    "data": {"text": "Actual final response"},
                },
            },
            test_user.id,
        )
        advance.assert_not_called()
    test_db.expire_all()
    assert execution.version == reconciled["version"]
    assert task.version == reconciled["task_version"]
    if mismatch is None:
        assert projected["message"]["content"] == "Actual final response"
        assert projected["workflow_continuation"] is None
        assert row.content == "Actual final response"
        assert execution.status == "completed"
    else:
        assert projected is None
        assert row.content == reconciled["content"]


@pytest.mark.parametrize(
    "mismatch",
    [None, "turn", "execution", "failed", "cancelled", "sequence", "missing_turn"],
)
def test_final_content_after_runtime_status_reconciliation(
    test_db, test_user, run, monkeypatch, mismatch
):
    from app.api.ws.device_namespace import _project_chat_runtime_event_sync
    from app.models.delivery import ProjectChatAgent
    from app.models.loop_item_execution import LoopItemExecution
    from app.services.loop_item_executions.service import loop_item_execution_service

    project, task, row = run
    test_db.get(ProjectChatAgent, "12").created_by_user_id = test_user.id
    monkeypatch.setattr(
        "app.services.loop_item_executions.service.notify_execution_lifecycle",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.project_chat.push.push_project_chat_message",
        lambda *args, **kwargs: None,
    )
    execution = LoopItemExecution(
        loop_item_id=task.id,
        cloud_project_id=project.id,
        executor_owner_user_id=test_user.id,
        agent_id="12",
        execution_environment="cloud",
        execution_device_id="snapshot-device",
        runtime_device_id="snapshot-device",
        runtime_task_id="runtime-1",
        status="running",
        last_event_seq=10,
    )
    test_db.add(execution)
    test_db.flush()
    row.metadata_json = {
        **row.metadata_json,
        "execution_id": execution.id,
        **({"runtime_turn_id": "turn-1"} if mismatch != "missing_turn" else {}),
    }
    test_db.commit()
    loop_item_execution_service.reconcile_runtime_snapshot(
        test_db, execution_id=execution.id, runtime_status="completed", running=False
    )
    if mismatch in {"failed", "cancelled"}:
        execution.status = mismatch
    elif mismatch == "execution":
        row.metadata_json = {**row.metadata_json, "execution_id": execution.id + 1}
    test_db.commit()
    previous = (execution.version, task.version, row.content)

    @contextmanager
    def same_session():
        yield test_db

    monkeypatch.setattr("app.api.ws.device_namespace.get_db_session", same_session)
    with patch.object(project_chat_service, "_advance_task_to_review") as advance:
        projected = _project_chat_runtime_event_sync(
            "snapshot-device",
            {
                "event": "response.completed",
                "payload": {
                    "taskId": "runtime-1",
                    "subtaskId": "wrong-turn" if mismatch == "turn" else "turn-1",
                    "eventSeq": 10 if mismatch == "sequence" else 12,
                    "data": {"value": "Complete answer from the real Runtime"},
                },
            },
            user_id=test_user.id,
        )
        advance.assert_not_called()
    test_db.expire_all()
    assert (execution.version, task.version) == previous[:2]
    if mismatch is None:
        assert (
            projected["message"]["content"] == "Complete answer from the real Runtime"
        )
        assert row.content == "Complete answer from the real Runtime"
        assert execution.status == row.status == "completed"
        assert execution.last_event_seq == 12
    else:
        assert projected is None or projected["message"] is None
        assert row.content == previous[2]
        assert execution.last_event_seq == 10


def test_conflicting_terminal_report_cannot_replace_durable_outcome(
    test_db, test_user, run
):
    first = report()
    first.turns[0].status = "cancelled"
    reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=first)
    assert (
        reconcile_execution_snapshot(test_db, user_id=test_user.id, snapshot=report())
        == []
    )
    test_db.expire_all()
    assert run[2].status == "cancelled"


@pytest.mark.parametrize("race_window", ["terminal_commit", "execution_lookup"])
def test_managed_final_event_restores_content_during_outcome_snapshot(
    test_db, test_user, run, monkeypatch, race_window
):
    from app.api.ws.device_namespace import _project_chat_runtime_event_sync
    from app.models.loop_item_execution import LoopItemExecution
    from app.services.loop_item_executions.service import loop_item_execution_service

    project, task, row = run
    execution = LoopItemExecution(
        loop_item_id=task.id,
        cloud_project_id=project.id,
        executor_owner_user_id=test_user.id,
        agent_id="12",
        assigner_user_id=test_user.id,
        execution_environment="cloud",
        execution_device_id="snapshot-device",
        runtime_device_id="snapshot-device",
        runtime_task_id="runtime-1",
        status="running",
        last_event_seq=10,
    )
    test_db.add(execution)
    test_db.flush()
    row.content = "Partial answer"
    row.metadata_json = {**row.metadata_json, "execution_id": str(execution.id)}
    test_db.commit()

    @contextmanager
    def same_session():
        yield test_db

    monkeypatch.setattr("app.api.ws.device_namespace.get_db_session", same_session)
    event = {
        "event": "response.completed",
        "payload": {
            "taskId": "runtime-1",
            "subtaskId": "turn-1",
            "eventSeq": 12,
            "data": {"text": "Complete answer from the real Runtime"},
        },
    }
    projected = None

    def deliver_final():
        nonlocal projected
        test_db.refresh(row)
        assert row.content == "Partial answer"
        with patch.object(project_chat_service, "_advance_task_to_review") as advance:
            projected = _project_chat_runtime_event_sync(
                "snapshot-device", event, user_id=test_user.id
            )
            advance.assert_not_called()

    if race_window == "terminal_commit":
        # The terminal root/activity commit used to precede the turn binding.
        # Deliver the real event at that boundary, before reconciliation returns.
        with patch.object(
            loop_item_execution_service,
            "_push_activity_after_commit",
            side_effect=lambda *_: deliver_final(),
        ):
            reconcile_execution_snapshot(
                test_db, user_id=test_user.id, snapshot=report()
            )
    else:
        original = loop_item_execution_service.handle_runtime_event

        def settle_before_second_lookup(*args, **kwargs):
            reconcile_execution_snapshot(
                test_db, user_id=test_user.id, snapshot=report()
            )
            return original(*args, **kwargs)

        with patch.object(
            loop_item_execution_service,
            "handle_runtime_event",
            side_effect=settle_before_second_lookup,
        ):
            projected = _project_chat_runtime_event_sync(
                "snapshot-device", event, user_id=test_user.id
            )
    assert projected is not None
    assert projected["message"]["content"] == "Complete answer from the real Runtime"
    test_db.expire_all()
    assert row.content == "Complete answer from the real Runtime"
    assert row.status == execution.status == "completed"
    assert execution.last_event_seq == 12
    assert row.metadata_json["runtime_turn_id"] == "turn-1"


@pytest.mark.parametrize(
    "mismatch",
    [
        "failed",
        "cancelled",
        "turn",
        "execution",
        "sequence",
        "missing_sequence",
        "no_snapshot",
    ],
)
def test_reconciled_content_rejects_conflicting_execution_evidence(
    test_db, test_user, run, mismatch
):
    from app.models.loop_item_execution import LoopItemExecution
    from app.services.project_chat.execution_snapshot import (
        can_restore_reconciled_completion,
    )

    project, task, row = run
    execution = LoopItemExecution(
        loop_item_id=task.id,
        cloud_project_id=project.id,
        executor_owner_user_id=test_user.id,
        agent_id="12",
        runtime_device_id="snapshot-device",
        runtime_task_id="runtime-1",
        status=mismatch if mismatch in {"failed", "cancelled"} else "completed",
        last_event_seq=10,
    )
    test_db.add(execution)
    test_db.flush()
    row.status = "completed"
    row.content = "Preserved answer"
    row.metadata_json = {
        **row.metadata_json,
        "execution_id": str(execution.id) if mismatch != "execution" else "another",
        "runtime_turn_id": "turn-1",
        "runtime_completed_at": datetime.now(UTC).isoformat(),
    }
    if mismatch == "no_snapshot":
        row.metadata_json = {
            key: value
            for key, value in row.metadata_json.items()
            if key != "runtime_completed_at"
        }
    test_db.commit()
    event = {
        "subtaskId": "another-turn" if mismatch == "turn" else "turn-1",
        "eventSeq": 10 if mismatch == "sequence" else 11,
        "data": {"text": "Unmatched final answer"},
    }
    if mismatch == "missing_sequence":
        event.pop("eventSeq")
    assert (
        can_restore_reconciled_completion(
            test_db,
            execution=execution,
            event_name="response.completed",
            payload=event,
        )
        is False
    )
    test_db.expire_all()
    assert row.content == "Preserved answer"
