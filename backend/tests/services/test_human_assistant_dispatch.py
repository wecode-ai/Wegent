"""Durable dispatch contracts for the default personal assistant."""

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate, LoopItemTaskBind, LoopItemUpdate
from app.schemas.project_chat import LoopItemAssign
from app.services.human_assistant_dispatch import (
    current_dispatch,
    execution_current,
)
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.service import loop_item_service
from tests.services.test_loop_item_assignment import (
    _make_item,
    _make_member,
    _make_project,
)


@pytest.fixture
def dispatch_enabled(monkeypatch):
    monkeypatch.setattr(settings, "HUMAN_ASSIGNMENT_RECEIPTS_ENABLED", True)


@pytest.fixture(autouse=True)
def isolate_background_delivery():
    with (
        patch("app.core.async_utils.schedule_async_task") as schedule,
        patch("app.core.cache.cache_manager.mget_sync_or_raise", return_value={}),
    ):
        yield schedule


def _device(db, user):
    device = Kind(
        kind="Device",
        name="assistant-device",
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={
            "spec": {
                "personalAssistantDispatch": {
                    "version": 1,
                    "roles": [
                        {
                            "userId": user.id,
                            "id": "@primary",
                            "enabled": True,
                            "enabledSince": "2020-01-01T00:00:00Z",
                            "handlingPolicy": {"automatic": True},
                            "collaboration": {
                                "enabled": True,
                                "allProjects": True,
                                "projects": [],
                                "excludedProjects": [],
                                "tags": [],
                            },
                        }
                    ],
                }
            }
        },
    )
    db.add(device)
    db.commit()
    return device


def _assign(db, project, item, actor, owner):
    return loop_item_service.assign(
        db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=actor.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(owner.id),
            notify_assignee=False,
        ),
    )


def _bind(db, item, user, *, task="assistant-task", device="assistant-device"):
    binding = loop_item_service.response_values(db, item, user.id)["human_task_binding"]
    dispatch = current_dispatch(db, item)
    return loop_item_service.bind_task(
        db,
        item.id,
        LoopItemTaskBind(
            deviceId=device,
            taskId=task,
            **binding,
            humanAssistantDispatchId=dispatch["dispatchId"],
        ),
        user.id,
    )


def test_human_assignment_creates_a_durable_assistant_intent(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)

    _assign(test_db, project, item, test_user, test_user)
    first = current_dispatch(test_db, item)
    _assign(test_db, project, item, test_user, test_user)

    rows = test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).all()
    assert len(rows) == 1
    assert rows[0].executor_type == "human_assistant"
    assert rows[0].executor_owner_user_id == test_user.id
    assert rows[0].status == "waiting_runtime"
    assert first == current_dispatch(test_db, item)
    assert item.status == "inbox"


def test_flag_disabled_reproduces_notification_only_assignment(test_db, test_user):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    assert item.assignee_user_id == test_user.id
    assert current_dispatch(test_db, item) is None
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0


@pytest.mark.parametrize(
    "declaration",
    [
        '{"version":1,"roles":[]}',
        None,
        [],
        {"version": 1, "roles": None},
        {"version": 1, "roles": "invalid"},
        {"version": 1, "roles": [None]},
    ],
)
def test_malformed_declaration_preserves_assignment_without_assistant_authority(
    test_db, test_user, dispatch_enabled, declaration
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    device = _device(test_db, test_user)
    device.json = {"spec": {"personalAssistantDispatch": declaration}}
    test_db.commit()

    _assign(test_db, project, item, test_user, test_user)

    receipt = loop_item_service.response_values(test_db, item, test_user.id)[
        "direct_human_assignment_receipt"
    ]
    assert item.assignee_user_id == test_user.id
    assert receipt["state"] == "blocked_policy"
    assert receipt["reasonCode"] == "no_authorized_assistant"
    assert receipt["executionId"] is None
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0


@pytest.mark.parametrize("workspace_owner", [7, "0", None, 0])
def test_workspace_devices_do_not_inherit_personal_assistant_consent(
    test_db, test_user, dispatch_enabled, workspace_owner
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    device = _device(test_db, test_user)
    device.json = {
        **device.json,
        "spec": {**device.json["spec"], "workspaceOwnerId": workspace_owner},
    }
    test_db.commit()

    _assign(test_db, project, item, test_user, test_user)

    dispatch = current_dispatch(test_db, item)
    assert item.assignee_user_id == test_user.id
    if workspace_owner:
        assert dispatch["reasonCode"] == "no_authorized_assistant"
        assert dispatch["executionId"] is None
        assert (
            test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count()
            == 0
        )
    else:
        assert dispatch["executionId"]


def test_personal_assistant_claim_rechecks_workspace_device_ownership(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    device = _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    device.json = {
        **device.json,
        "spec": {**device.json["spec"], "workspaceOwnerId": "workspace-7"},
    }
    test_db.commit()

    with pytest.raises(HTTPException, match="403"):
        _bind(test_db, item, test_user)


def test_assigning_closed_issue_preserves_status_without_an_active_dispatch(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    item.status = "completed"
    test_db.commit()
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    assert item.status == "completed"
    assert current_dispatch(test_db, item) is None
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0


def test_create_with_explicit_human_owner_dispatches_without_notification(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    _device(test_db, test_user)
    item = loop_item_service.create(
        test_db,
        int(project.id),
        test_user.id,
        LoopItemCreate(
            title="Explicit owner", assignee_user_id=test_user.id, notify_assignee=False
        ),
    )
    assert current_dispatch(test_db, item)["executionId"]


def test_missing_authorization_remains_visible_and_manual_task_is_allowed(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _assign(test_db, project, item, test_user, test_user)
    dispatch = current_dispatch(test_db, item)
    assert dispatch["reasonCode"] == "no_authorized_assistant"
    assert dispatch["executionId"] is None
    manual = loop_item_service.bind_task(
        test_db,
        item.id,
        LoopItemTaskBind(
            deviceId="manual",
            taskId="manual",
            **loop_item_service.response_values(test_db, item, test_user.id)[
                "human_task_binding"
            ],
        ),
        test_user.id,
    )
    assert manual.execution_id is None


def test_only_one_owned_endpoint_can_claim_and_retries_reuse_execution(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    with pytest.raises(HTTPException, match="403"):
        _bind(test_db, item, test_user, device="foreign-device")
    test_db.rollback()
    first = _bind(test_db, item, test_user)
    retry = _bind(test_db, item, test_user)
    assert first.id == retry.id
    assert first.execution_id
    with pytest.raises(HTTPException, match="409"):
        _bind(test_db, item, test_user, task="duplicate-task")
    test_db.rollback()
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 1


def test_reassignment_cancels_old_run_and_rejects_late_binding(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "next-owner", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    old = current_dispatch(test_db, item)
    old_binding = loop_item_service.response_values(test_db, item, test_user.id)[
        "human_task_binding"
    ]
    _assign(test_db, project, item, test_user, member)
    execution = test_db.get(LoopItemExecution, old["executionId"])
    assert execution.status == "cancelled"
    with pytest.raises(HTTPException, match="409"):
        loop_item_service.bind_task(
            test_db,
            item.id,
            LoopItemTaskBind(
                deviceId="assistant-device",
                taskId="late",
                **old_binding,
                humanAssistantDispatchId=old["dispatchId"],
            ),
            test_user.id,
        )


def test_final_result_has_user_provenance_without_advancing_issue(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    binding = _bind(test_db, item, test_user)
    execution = test_db.get(LoopItemExecution, binding.execution_id)
    assert (
        loop_item_execution_service.open_execution_activity(
            test_db, execution=execution
        )
        is None
    )
    assert test_db.query(ProjectChatMessage).filter_by(task_id=item.id).count() == 0
    with patch(
        "app.services.loop_item_executions.service.LoopItemExecutionService._push_activity_after_commit"
    ):
        loop_item_execution_service.complete(
            test_db, execution_id=execution.id, content="Summary with evidence"
        )
    result = test_db.query(ProjectChatMessage).filter_by(task_id=item.id).one()
    assert result.sender_type == "user"
    assert result.sender_id == str(test_user.id)
    assert result.metadata_json["provenance"]["origin"] == "ai_generated"
    assert result.metadata_json["provenance"]["confirmation_status"] == "unconfirmed"
    assert item.status == "inbox"


def test_closing_issue_cancels_queued_assistant(test_db, test_user, dispatch_enabled):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    dispatch = current_dispatch(test_db, item)
    loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, status="completed"),
    )
    assert test_db.get(LoopItemExecution, dispatch["executionId"]).status == "cancelled"


def test_project_policy_disables_default_automatic_handling(
    test_db, test_user, dispatch_enabled
):
    import copy

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    device = _device(test_db, test_user)
    payload = copy.deepcopy(device.json)
    payload["spec"]["personalAssistantDispatch"]["roles"][0]["collaboration"][
        "projectPolicies"
    ] = [{"id": str(project.id), "store": "cloud", "policy": {"automatic": False}}]
    device.json = payload
    test_db.commit()
    _assign(test_db, project, item, test_user, test_user)
    assert current_dispatch(test_db, item)["reasonCode"] == "automatic_disabled"
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0


def test_flag_rollback_blocks_new_claim_but_preserves_existing_claim_retry(
    test_db, test_user, dispatch_enabled, monkeypatch
):
    project = _make_project(test_db, test_user)
    first = _make_item(test_db, project, test_user)
    second = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, first, test_user, test_user)
    _assign(test_db, project, second, test_user, test_user)
    binding = _bind(test_db, first, test_user)
    monkeypatch.setattr(settings, "HUMAN_ASSIGNMENT_RECEIPTS_ENABLED", False)
    with pytest.raises(HTTPException, match="disabled"):
        _bind(test_db, second, test_user, task="second")
    test_db.rollback()
    assert _bind(test_db, first, test_user).execution_id == binding.execution_id


def test_running_reassignment_waits_for_runtime_and_late_result_is_private(
    test_db, test_user, dispatch_enabled, isolate_background_delivery
):
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "next-running-owner", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    binding = _bind(test_db, item, test_user)
    execution = test_db.get(LoopItemExecution, binding.execution_id)
    execution.status = "running"
    test_db.commit()
    _assign(test_db, project, item, test_user, member)
    test_db.refresh(execution)
    assert execution.status == "cancel_requested"
    assert not execution_current(test_db, execution)
    assert any(
        call.args[0].__name__ == "_send_cancellations"
        for call in isolate_background_delivery.call_args_list
    )
    with patch(
        "app.services.loop_item_executions.service.LoopItemExecutionService._push_activity_after_commit"
    ):
        loop_item_execution_service.complete(
            test_db, execution_id=execution.id, content="Obsolete result"
        )
    assert item.assignee_user_id == member.id
    assert item.status == "inbox"
    assert test_db.query(ProjectChatMessage).filter_by(task_id=item.id).count() == 0


def test_preflight_failure_is_persisted_without_a_second_execution(
    test_db, test_user, dispatch_enabled
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    dispatch = current_dispatch(test_db, item)
    with patch(
        "app.services.loop_item_executions.service.LoopItemExecutionService._push_activity_after_commit"
    ):
        failed = loop_item_execution_service.fail_runtime_preflight(
            test_db,
            execution_id=int(dispatch["executionId"]),
            error="Workspace unavailable",
        )
    assert failed.status == "failed"
    assert current_dispatch(test_db, item)["dispatchState"] == "failed"
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 1


def test_assignment_invalidation_waits_for_commit(
    test_db, test_user, dispatch_enabled, isolate_background_delivery
):
    from app.services.issue_assignments import issue_assignment_service

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    isolate_background_delivery.reset_mock()
    issue_assignment_service.record(
        test_db,
        project_id=project.id,
        issue_id=item.id,
        member_type="human",
        member_id=str(test_user.id),
        assigned_by_user_id=test_user.id,
        workflow_step=None,
        notify=False,
        trigger="manual",
    )
    isolate_background_delivery.assert_not_called()
    test_db.commit()
    assert any(
        call.args[0].__name__ == "_publish_pending_changes"
        for call in isolate_background_delivery.call_args_list
    )
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 1


def test_stale_active_assignment_cannot_publish_after_owner_is_assigned_again(
    test_db, test_user, dispatch_enabled
):
    from app.services.issue_assignments import issue_assignment_service

    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "temporary-owner", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    binding = _bind(test_db, item, test_user)
    old = issue_assignment_service.active_for_issue(test_db, item.id)[0]
    execution = test_db.get(LoopItemExecution, binding.execution_id)
    _assign(test_db, project, item, test_user, member)
    _assign(test_db, project, item, test_user, test_user)
    with patch.object(issue_assignment_service, "active", return_value=old):
        assert not execution_current(test_db, execution)
