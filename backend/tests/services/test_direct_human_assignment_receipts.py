"""Public receipts describe acceptance facts, never notification success."""

from copy import deepcopy
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import event

from app.core.cache import RedisCache
from app.core.config import settings
from app.models.delivery import Delivery
from app.models.loop_item_execution import LoopItemExecution
from app.services.collaboration_human_assignments import direct_human_assignment_id
from app.services.direct_human_assignment_receipts import current_receipts
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items.service import loop_item_service
from tests.services.test_human_assistant_dispatch import _assign, _bind, _device
from tests.services.test_loop_item_assignment import _make_item, _make_project


@pytest.fixture(autouse=True)
def receipt_environment(monkeypatch):
    monkeypatch.setattr(settings, "HUMAN_ASSIGNMENT_RECEIPTS_ENABLED", True)
    with (
        patch("app.core.async_utils.schedule_async_task"),
        patch(
            "app.core.cache.cache_manager.mget_sync_or_raise", return_value={}
        ) as presence,
    ):
        yield presence


def _receipt(db, item, user):
    values = loop_item_service.response_values(db, item, user.id)
    assert "human_assistant_dispatch" not in values
    return values["direct_human_assignment_receipt"]


def _setup(db, user):
    project = _make_project(db, user)
    item = _make_item(db, project, user)
    device = _device(db, user)
    _assign(db, project, item, user, user)
    execution = db.query(LoopItemExecution).filter_by(loop_item_id=item.id).one()
    return project, item, device, execution


def test_receipt_identity_and_offline_reason_are_stable_on_duplicate_assignment(
    test_db, test_user
):
    project, item, _, execution = _setup(test_db, test_user)
    first = _receipt(test_db, item, test_user)
    _assign(test_db, project, item, test_user, test_user)
    second = _receipt(test_db, item, test_user)

    assert first == second
    assert first["projectId"] == str(project.id)
    assert first["issueId"] == item.id
    assert first["ownerUserId"] == test_user.id
    assert first["humanAssignmentId"] == direct_human_assignment_id(
        issue_id=item.id, assignment_id=first["assignmentId"]
    )
    assert first["humanAssignmentId"] != first["assignmentId"]
    assert first["executionId"] == str(execution.id)
    assert first["state"] == "waiting_device"
    assert first["reasonCode"] == "waiting_device"
    assert first["runtimeTaskId"] is None
    assert first["deliveryId"] is None
    assert item.status == "inbox"


@pytest.mark.parametrize(
    "change, expected",
    [
        ({"enabled": False}, "assistant_disabled"),
        ({"collaboration": {"enabled": False}}, "assistant_disabled"),
        ({"collaboration": {"allProjects": False}}, "project_not_authorized"),
        ({"handlingPolicy": {"automatic": False}}, "automatic_disabled"),
        ({"collaboration": {"tags": ["triage"]}}, "tag_mismatch"),
    ],
)
def test_current_policy_denial_is_explicit_even_before_the_next_heartbeat(
    test_db, test_user, change, expected
):
    _, item, device, _ = _setup(test_db, test_user)
    document = deepcopy(device.json)
    role = document["spec"]["personalAssistantDispatch"]["roles"][0]
    for key, value in change.items():
        role[key] = {**role[key], **value} if isinstance(value, dict) else value
    device.json = document
    test_db.commit()

    receipt = _receipt(test_db, item, test_user)
    assert receipt["state"] == "blocked_policy"
    assert receipt["reasonCode"] == expected
    assert item.assignee_user_id == test_user.id


def test_project_policy_replaces_global_policy_and_matching_tags_allow_queue(
    test_db, test_user, receipt_environment
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    item.metadata_json = {"tags": ["triage"]}
    device = _device(test_db, test_user)
    document = deepcopy(device.json)
    role = document["spec"]["personalAssistantDispatch"]["roles"][0]
    role["collaboration"].update(
        tags=["triage"],
        policy={"automatic": False},
        projectPolicies=[
            {"id": str(project.id), "store": "cloud", "policy": {"automatic": True}}
        ],
    )
    device.json = document
    test_db.commit()
    receipt_environment.side_effect = lambda keys: {
        key: {"status": "online"} for key in keys
    }

    _assign(test_db, project, item, test_user, test_user)
    receipt = _receipt(test_db, item, test_user)
    assert receipt["state"] == "queued"
    assert receipt["reasonCode"] is None
    assert receipt["runtimeTaskId"] is None
    assert item.status == "inbox"


def test_presence_unknown_is_distinct_from_offline_and_does_not_remove_assignment(
    test_db, test_user, receipt_environment
):
    _, item, _, _ = _setup(test_db, test_user)
    receipt_environment.side_effect = ConnectionError("presence unavailable")

    receipt = _receipt(test_db, item, test_user)
    assert receipt["state"] == "waiting_device"
    assert receipt["reasonCode"] == "device_state_unavailable"
    assert item.assignee_user_id == test_user.id


def test_pending_receipts_batch_presence_and_reject_wrong_runtime_installation(
    test_db, test_user, receipt_environment
):
    project, first, device, execution = _setup(test_db, test_user)
    second = _make_item(test_db, project, test_user)
    _assign(test_db, project, second, test_user, test_user)
    executions = {
        str(row.id): row
        for row in test_db.query(LoopItemExecution).filter_by(
            cloud_project_id=str(project.id)
        )
    }
    assignments = issue_assignment_service.active_for_issues(
        test_db, [first.id, second.id]
    )
    device.json = {
        **device.json,
        "spec": {**device.json["spec"], "runtimeInstanceId": "current"},
    }
    test_db.commit()
    receipt_environment.side_effect = lambda keys: {
        key: {"status": "online", "runtime_instance_id": "old"} for key in keys
    }
    receipt_environment.reset_mock()
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    # Load expired fixture objects before measuring the request's batch work.
    for value in [first, second, *executions.values()]:
        test_db.refresh(value)
    for events in assignments.values():
        for assignment in events:
            test_db.refresh(assignment.comment)
    event.listen(test_db.get_bind(), "before_cursor_execute", record)
    try:
        receipts = current_receipts(
            test_db, [first, second], assignments=assignments, executions=executions
        )
    finally:
        event.remove(test_db.get_bind(), "before_cursor_execute", record)

    assert len(receipts) == 2
    assert {value["state"] for value in receipts.values()} == {"waiting_device"}
    receipt_environment.assert_called_once()
    assert len(receipt_environment.call_args.args[0]) == 1
    assert len(statements) == 1
    assert execution.runtime_task_id == ""


@pytest.mark.parametrize(
    "status, observed, expected",
    [
        ("claimed", "unconfirmed", "running"),
        ("running", "running", "running"),
        ("running", "requires_action", "waiting_user"),
        ("pending_approval", "unconfirmed", "waiting_user"),
        ("cancel_requested", "running", "cancelling"),
        ("cancelled", "cancelled", "cancelled"),
        ("completed", "completed", "completed"),
        ("failed", "failed", "failed"),
    ],
)
def test_receipt_uses_real_runtime_state_without_advancing_issue(
    test_db, test_user, status, observed, expected
):
    _, item, _, execution = _setup(test_db, test_user)
    _bind(test_db, item, test_user)
    execution.status = status
    execution.observed_state = observed
    execution.termination_reason = "runtime_succeeded" if status == "completed" else ""
    test_db.commit()

    receipt = _receipt(test_db, item, test_user)
    assert receipt["state"] == expected
    assert receipt["runtimeTaskId"] == "assistant-task"
    assert receipt["deliveryId"] is None
    if status == "completed":
        assert receipt["reasonCode"] is None
    assert item.status == "inbox"


@pytest.mark.parametrize(
    "mismatch",
    [
        None,
        "humanAssignmentId",
        "assignmentId",
        "userId",
        "issueId",
        "missing_snapshot",
        "cancelling",
    ],
)
def test_delivery_requires_real_current_assignment_snapshot_and_cancel_ack(
    test_db, test_user, mismatch
):
    project, item, _, execution = _setup(test_db, test_user)
    binding = _bind(test_db, item, test_user)
    before = _receipt(test_db, item, test_user)
    snapshot = {
        "humanAssignmentId": before["humanAssignmentId"],
        "assignmentId": before["assignmentId"],
        "userId": test_user.id,
    }
    if mismatch in snapshot:
        snapshot[mismatch] = "old-attempt"
    if mismatch == "missing_snapshot":
        snapshot = {}
    other = _make_item(test_db, project, test_user) if mismatch == "issueId" else item
    delivery = Delivery(
        loop_item_id=other.id,
        cloud_project_id=project.id,
        source_task_binding_id=binding.id,
        source_task_snapshot=snapshot,
        status="delivered",
        delivered_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    test_db.add(delivery)
    if mismatch == "cancelling":
        execution.status = "cancel_requested"
    test_db.commit()

    receipt = _receipt(test_db, item, test_user)
    if mismatch is None:
        assert receipt["deliveryId"] == str(delivery.id)
        assert receipt["state"] == "completed"
    else:
        assert receipt["deliveryId"] is None
        assert receipt["state"] == (
            "cancelling" if mismatch == "cancelling" else "running"
        )
    assert item.status == "inbox"


def test_ordinary_issues_and_disabled_feature_do_not_read_presence(
    test_db, test_user, receipt_environment, monkeypatch
):
    monkeypatch.setattr(settings, "HUMAN_ASSIGNMENT_RECEIPTS_ENABLED", False)
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _assign(test_db, project, item, test_user, test_user)
    receipt_environment.reset_mock()

    assert _receipt(test_db, item, test_user) is None
    receipt_environment.assert_not_called()


def test_presence_batch_decodes_json_and_propagates_connection_errors():
    cache = RedisCache("redis://unused")
    client = MagicMock()
    cache._sync_client = client
    client.mget.return_value = [b'{"status":"online"}', None, b"plain"]
    assert cache.mget_sync_or_raise(["online", "missing", "raw"]) == {
        "online": {"status": "online"},
        "raw": b"plain",
    }
    client.mget.assert_called_once_with(["online", "missing", "raw"])
    client.mget.side_effect = ConnectionError("unavailable")
    with pytest.raises(ConnectionError):
        cache.mget_sync_or_raise(["online"])
