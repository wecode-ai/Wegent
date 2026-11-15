"""Only explicit recovery of a failed assignment can replace a runner binding."""

import pytest
from fastapi import HTTPException
from sqlalchemy import update

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.services.runner_routing import claim_routing, resolve_routing
from tests.services.test_runner_routing import routing_setup  # noqa: F401
from tests.services.test_runner_routing import MODEL, _execution_stub


def prepare(db, setup, selection=None, automatic=False):
    user, devices, issue = setup
    return resolve_routing(
        db,
        config={
            "runtime": "codex",
            "execution_policy": {"mode": "fixed", "environment_id": str(devices[1].id)},
            "model_policy": {"mode": "fixed", "model": MODEL},
        },
        project_id=issue.cloud_project_id,
        issue_id=issue.id,
        user_id=user.id,
        selection=selection,
        automatic=automatic,
    )


def run_for(setup, snapshot, **values):
    user, _, issue = setup
    return _execution_stub(
        loop_item_id=issue.id,
        cloud_project_id=issue.cloud_project_id,
        assigner_user_id=user.id,
        runtime_selection={"runner_routing": snapshot},
        **values,
    )


@pytest.mark.parametrize("previous_status", ["completed", "failed"])
def test_conflict_requires_explicit_recovery_and_preserves_history(
    test_db, routing_setup, previous_status
):
    user, devices, issue = routing_setup
    issue.metadata_json = {
        "runner_binding": {"environment_id": str(devices[0].id)},
        "tags": ["keep"],
    }
    previous = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=issue.cloud_project_id,
        executor_owner_user_id=user.id,
        runtime_device_id=devices[0].name,
        runtime_task_id="original-session",
        status=previous_status,
    )
    test_db.add(previous)
    test_db.flush()
    with pytest.raises(HTTPException) as error:
        prepare(test_db, routing_setup)
    assert error.value.detail["error_code"] == "ISSUE_RUNNER_CONFLICT"
    request = error.value.detail["runner_selection_request"]
    assert request["recovery_from_environment_id"] == str(devices[0].id)
    assert issue.metadata_json["runner_binding"]["environment_id"] == str(devices[0].id)
    result = prepare(
        test_db,
        routing_setup,
        {"recovery_from_environment_id": request["recovery_from_environment_id"]},
    )
    assert result.candidates == [devices[1]]
    assert claim_routing(test_db, run_for(routing_setup, result.snapshot()), devices[1])
    assert issue.metadata_json == {
        "runner_binding": {"environment_id": str(devices[1].id)},
        "tags": ["keep"],
    }
    assert previous.runtime_device_id == devices[0].name
    assert previous.runtime_task_id == "original-session"
    assert previous.status == previous_status


@pytest.mark.parametrize(
    "state", ["queued", "pending_approval", "claimed", "running", "cancel_requested"]
)
def test_live_work_never_offers_or_accepts_recovery(test_db, routing_setup, state):
    _, devices, issue = routing_setup
    issue.metadata_json = {"runner_binding": {"environment_id": str(devices[0].id)}}
    test_db.add(
        LoopItemExecution(loop_item_id=issue.id, status=state, execution_payload="{}")
    )
    test_db.flush()
    with pytest.raises(HTTPException) as error:
        prepare(
            test_db, routing_setup, {"recovery_from_environment_id": str(devices[0].id)}
        )
    assert error.value.detail["error_code"] == "ISSUE_RUNNER_CONFLICT"
    assert "runner_selection_request" not in error.value.detail
    assert issue.metadata_json["runner_binding"]["environment_id"] == str(devices[0].id)


@pytest.mark.parametrize("stale", [False, True])
def test_claim_rechecks_occupancy_and_expected_binding(test_db, routing_setup, stale):
    _, devices, issue = routing_setup
    original = str(devices[0].id)
    issue.metadata_json = {"runner_binding": {"environment_id": original}}
    test_db.flush()
    result = prepare(test_db, routing_setup, {"recovery_from_environment_id": original})
    if stale:
        test_db.execute(
            update(LoopItem.__table__)
            .where(LoopItem.id == issue.id)
            .values(metadata={"runner_binding": {"environment_id": "999"}})
        )
        test_db.refresh(issue)
    else:
        test_db.add(
            LoopItemExecution(
                loop_item_id=issue.id, status="running", execution_payload="{}"
            )
        )
    test_db.flush()
    assert not claim_routing(
        test_db, run_for(routing_setup, result.snapshot()), devices[1]
    )
    assert issue.metadata_json["runner_binding"]["environment_id"] == (
        "999" if stale else original
    )


def test_automation_cannot_recover_a_binding(test_db, routing_setup):
    _, devices, issue = routing_setup
    issue.metadata_json = {"runner_binding": {"environment_id": str(devices[0].id)}}
    with pytest.raises(HTTPException) as error:
        prepare(
            test_db,
            routing_setup,
            {"recovery_from_environment_id": str(devices[0].id)},
            automatic=True,
        )
    assert error.value.detail["error_code"] == "ISSUE_RUNNER_CONFLICT"
    assert "runner_selection_request" not in error.value.detail


def test_recovery_does_not_grant_access_to_another_users_device(
    test_db, test_admin_user, routing_setup
):
    _, devices, issue = routing_setup
    issue.metadata_json = {"runner_binding": {"environment_id": str(devices[0].id)}}
    devices[1].user_id = test_admin_user.id
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Device", resource_id=devices[1].id, entity_type="project"
        )
        .one()
    )
    grant.status = "rejected"
    test_db.flush()
    with pytest.raises(HTTPException) as error:
        prepare(
            test_db, routing_setup, {"recovery_from_environment_id": str(devices[0].id)}
        )
    assert error.value.detail["error_code"] == "RUNNER_ENVIRONMENT_UNAVAILABLE"
    assert "runner_selection_request" not in error.value.detail


def test_old_session_reply_does_not_restore_the_old_issue_binding(
    test_db, routing_setup
):
    _, devices, issue = routing_setup
    issue.metadata_json = {"runner_binding": {"environment_id": str(devices[1].id)}}
    test_db.flush()
    snapshot = {
        "execution_policy": {"mode": "fixed", "environment_id": str(devices[0].id)},
        "model": MODEL,
    }
    execution = run_for(
        routing_setup,
        snapshot,
        runtime_device_id=devices[0].name,
        runtime_request={"newSession": False},
    )
    execution.runtime_selection["resolved_environment_id"] = str(devices[0].id)
    assert claim_routing(test_db, execution, devices[0])
    assert issue.metadata_json["runner_binding"]["environment_id"] == str(devices[1].id)


@pytest.mark.parametrize(
    "run_id,allowed",
    [("collaboration-group:assignment", True), ("scheduled-run", False)],
)
def test_manual_group_dispatch_identity_is_not_an_automation(
    test_db, routing_setup, run_id, allowed
):
    from app.services.runner_recovery import permits_runner_recovery

    _, devices, issue = routing_setup
    issue.metadata_json = {"runner_binding": {"environment_id": str(devices[0].id)}}
    test_db.flush()
    result = prepare(
        test_db, routing_setup, {"recovery_from_environment_id": str(devices[0].id)}
    )
    execution = run_for(
        routing_setup,
        result.snapshot(),
        automation_run_id=run_id,
        runtime_origin_context={
            "dispatch_kind": "collaboration_group",
            "assignment_key": "assignment",
            "run_id": run_id,
        },
    )
    assert permits_runner_recovery(test_db, execution, str(devices[0].id)) is allowed
