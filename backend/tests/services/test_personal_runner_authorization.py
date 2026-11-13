"""Manual owner consent never becomes shared or automatic execution authority."""

import json

import pytest
from fastapi import HTTPException

from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.schemas.runner_routing import ExecutionPolicy, ModelPolicy
from app.services.collaboration_revocation import execution_authorized
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.runner_routing import (
    _candidates,
    execution_device_authorized,
    explicit_project_environment_ids,
    resolve_routing,
    validate_agent_policies,
)
from tests.services.test_runner_routing import (  # noqa: F401
    MODEL,
    resolve,
    routing_setup,
)


def remove_device_sharing(db, devices):
    db.query(ResourceMember).filter(
        ResourceMember.resource_type == "Device",
        ResourceMember.resource_id.in_([device.id for device in devices]),
    ).delete(synchronize_session=False)
    db.flush()


def owner_route(db, user, issue, device, *, automatic=False):
    return resolve_routing(
        db,
        config={
            "runtime": "codex",
            "execution_policy": {"mode": "fixed", "environment_id": str(device.id)},
            "model_policy": {"mode": "fixed", "model": MODEL},
        },
        project_id=issue.cloud_project_id,
        issue_id=issue.id,
        user_id=user.id,
        selection=None,
        automatic=automatic,
    )


@pytest.mark.parametrize(
    "source", ["execution_selection", "personal_default", "issue_binding"]
)
def test_cp12_user_selection_resolves_owner_consent_without_sharing(
    test_db, routing_setup, source
):
    user, devices, issue = routing_setup
    remove_device_sharing(test_db, devices)
    target = str(devices[0].id)
    selection = None
    if source == "execution_selection":
        selection = {"execution_policy": {"mode": "fixed", "environment_id": target}}
    elif source == "personal_default":
        user.preferences = json.dumps({"default_execution_target": devices[0].name})
    else:
        issue.metadata_json = {"runner_binding": {"environment_id": target}}
    route = resolve(test_db, user, issue, "user_select", selection=selection)
    assert route.candidates == [devices[0]]
    assert route.source == source


def test_cp12_workspace_registration_account_is_not_personal_device_ownership(
    test_db, routing_setup
):
    user, devices, issue = routing_setup
    remove_device_sharing(test_db, devices)
    devices[0].json = {"spec": {**devices[0].json["spec"], "workspaceOwnerId": 9}}
    test_db.flush()
    with pytest.raises(HTTPException) as error:
        owner_route(test_db, user, issue, devices[0])
    assert error.value.detail["error_code"] == "RUNNER_ENVIRONMENT_UNAVAILABLE"


def test_cp11_cp12_cp15_manual_owner_can_configure_and_claim_without_sharing(
    test_db, routing_setup
):
    user, devices, issue = routing_setup
    remove_device_sharing(test_db, devices)
    device = devices[0]
    policy = ExecutionPolicy(mode="fixed", environment_id=str(device.id))
    validate_agent_policies(
        test_db,
        user_id=user.id,
        project_id=issue.cloud_project_id,
        policy=policy,
        model_policy=ModelPolicy(mode="fixed", model=MODEL),
        runtime="codex",
    )
    route = owner_route(test_db, user, issue, device)
    execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=issue.cloud_project_id,
        assigner_user_id=user.id,
        executor_owner_user_id=user.id,
        execution_environment="local",
        status="queued",
        execution_payload=json.dumps(
            {"runtime_selection": {"runner_routing": route.snapshot()}}
        ),
    )
    test_db.add(execution)
    test_db.flush()

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=user.id,
        execution_device_id=device.name,
        environment="local",
        runtime_instance_id="personal-runtime",
    )

    assert claimed is not None
    assert claimed.id == execution.id
    assert claimed.executor_owner_user_id == user.id
    assert execution_authorized(test_db, claimed)
    assert explicit_project_environment_ids(test_db, issue.cloud_project_id) == set()
    assert claimed.runtime_selection["model"] == "first-model"
    device.is_active = False
    test_db.flush()
    assert not execution_authorized(test_db, claimed)


@pytest.mark.parametrize("automatic", [False, True])
@pytest.mark.parametrize("mode", ["fixed", "project_pool"])
def test_cp12_owner_consent_is_only_for_manual_fixed_selection(
    test_db, routing_setup, automatic, mode
):
    user, devices, issue = routing_setup
    remove_device_sharing(test_db, devices)
    policy = ExecutionPolicy(
        mode=mode, **({"environment_id": str(devices[0].id)} if mode == "fixed" else {})
    )
    if mode == "fixed" and not automatic:
        assert _candidates(test_db, policy, issue.cloud_project_id, user.id) == [
            devices[0]
        ]
    else:
        with pytest.raises(HTTPException) as error:
            _candidates(
                test_db, policy, issue.cloud_project_id, user.id, automatic=automatic
            )
        assert error.value.detail["error_code"] == "RUNNER_ENVIRONMENT_UNAVAILABLE"


def test_cp15_device_ownership_is_rechecked_and_not_inferred_from_the_snapshot(
    test_db, test_admin_user, routing_setup
):
    user, devices, issue = routing_setup
    remove_device_sharing(test_db, devices)
    device = devices[0]
    route = owner_route(test_db, user, issue, device)
    execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=issue.cloud_project_id,
        assigner_user_id=user.id,
        executor_owner_user_id=user.id,
        execution_environment="local",
        status="queued",
        execution_payload=json.dumps(
            {"runtime_selection": {"runner_routing": route.snapshot()}}
        ),
    )
    assert execution_device_authorized(test_db, execution, device)
    device.user_id = test_admin_user.id
    test_db.flush()
    assert not execution_device_authorized(test_db, execution, device)
    with pytest.raises(HTTPException) as error:
        owner_route(test_db, user, issue, device)
    assert error.value.detail["error_code"] == "RUNNER_ENVIRONMENT_UNAVAILABLE"


@pytest.mark.parametrize("automation", ["column", "context"])
def test_cp11_cp12_automation_cannot_reuse_a_manual_owner_snapshot(
    test_db, routing_setup, automation
):
    user, devices, issue = routing_setup
    remove_device_sharing(test_db, devices)
    route = owner_route(test_db, user, issue, devices[0])
    execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=issue.cloud_project_id,
        assigner_user_id=user.id,
        executor_owner_user_id=user.id,
        execution_device_id=devices[0].name,
        execution_payload=json.dumps(
            {
                "runtime_selection": {"runner_routing": route.snapshot()},
                "origin_context": (
                    {"run_id": "automatic-run"} if automation == "context" else {}
                ),
            }
        ),
        automation_run_id="automatic-run" if automation == "column" else None,
    )
    assert not execution_device_authorized(test_db, execution, devices[0])


def test_cp12_cp15_claimed_unrouted_execution_keeps_shared_authority(
    test_db, routing_setup
):
    user, devices, issue = routing_setup
    execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=issue.cloud_project_id,
        assigner_user_id=user.id,
        executor_owner_user_id=user.id,
        execution_environment="local",
        status="queued",
        execution_payload=json.dumps({"runtime_selection": {}}),
    )
    test_db.add(execution)
    test_db.flush()
    assert not execution.execution_device_id

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=user.id,
        execution_device_id=devices[0].name,
        environment="local",
        runtime_instance_id="shared-runtime",
    )

    assert claimed is not None
    assert claimed.id == execution.id
    assert claimed.execution_device_id == devices[0].name
    remove_device_sharing(test_db, devices)
    assert not execution_authorized(test_db, claimed)
