"""Routing denials retain the exact device, grant, and group-member evidence."""

import json

import pytest
from fastapi import HTTPException

from app.models.delivery import ProjectChatAgent
from app.models.resource_member import ResourceMember
from app.schemas.runner_routing import ExecutionPolicy, ModelPolicy
from app.services.runner_routing import (
    _candidates,
    resolve_group_routing,
    validate_agent_policies,
)
from tests.services.test_runner_routing import MODEL, routing_setup  # noqa: F401
from tests.utils.collaboration import authorize_project_agent


def diagnostic_events(caplog):
    """Decode only the structured routing events captured by this suite."""
    return [
        json.loads(record.args[0])
        for record in caplog.records
        if record.name.startswith("app.services.runner_routing")
    ]


@pytest.mark.parametrize("scope", ["workspace", "project"])
@pytest.mark.parametrize("state", ["missing", "rejected", "viewer"])
def test_denial_records_raw_grant_failure(test_db, routing_setup, caplog, scope, state):
    """Retain the failing grant scope, role, and approval state without secrets."""
    user, devices, issue = routing_setup
    target = devices[0]
    grant = (
        test_db.query(ResourceMember)
        .filter_by(resource_type="Device", resource_id=target.id, entity_type=scope)
        .one()
    )
    grant_id = grant.id
    if state == "missing":
        test_db.delete(grant)
    elif state == "rejected":
        grant.status = "rejected"
    else:
        grant.role = "Viewer"
    target.json = {"spec": {"api_key": "DO-NOT-LOG-DEVICE-SECRETS"}}
    test_db.flush()

    with pytest.raises(HTTPException) as error:
        _candidates(
            test_db,
            ExecutionPolicy(mode="fixed", environment_id=str(target.id)),
            issue.cloud_project_id,
            user.id,
            "failing-agent",
        )

    assert error.value.status_code == 422
    assert error.value.detail["error_code"] == "RUNNER_ENVIRONMENT_UNAVAILABLE"
    event = diagnostic_events(caplog)[0]
    assert event["agent_id"] == "failing-agent"
    assert event["project_id"] == issue.cloud_project_id
    assert event["workspace_id"] is not None
    assert event["execution_policy"]["environment_id"] == str(target.id)
    assert event["authorized_environment_ids"] == [devices[1].id]
    failed_grants = [row for row in event["grants"] if row["id"] == grant_id]
    if state == "missing":
        assert failed_grants == []
    else:
        assert failed_grants[0]["scope"] == scope
        assert failed_grants[0]["device_id"] == target.id
        assert failed_grants[0]["role"] == (
            "Viewer" if state == "viewer" else "Developer"
        )
        assert failed_grants[0]["status"] == (
            "rejected" if state == "rejected" else "approved"
        )
    assert "DO-NOT-LOG-DEVICE-SECRETS" not in caplog.text


@pytest.mark.parametrize("state", ["missing", "inactive", "namespace", "kind"])
def test_denial_distinguishes_device_record_failure(
    test_db, routing_setup, caplog, state
):
    """Distinguish absent devices from inactive or incorrectly typed records."""
    user, devices, issue = routing_setup
    target = devices[0]
    target_id = target.id
    if state == "missing":
        test_db.delete(target)
    elif state == "inactive":
        target.is_active = False
    elif state == "namespace":
        target.namespace = "other"
    else:
        target.kind = "Bot"
    test_db.flush()

    with pytest.raises(HTTPException):
        _candidates(
            test_db,
            ExecutionPolicy(mode="fixed", environment_id=str(target_id)),
            issue.cloud_project_id,
            user.id,
        )

    event = diagnostic_events(caplog)[0]
    assert target_id in event["authorized_environment_ids"]
    records = [row for row in event["devices"] if row["id"] == target_id]
    if state == "missing":
        assert records == []
    elif state == "inactive":
        assert records[0]["is_active"] is False
    elif state == "namespace":
        assert records[0]["namespace"] == "other"
    else:
        assert records[0]["kind"] == "Bot"


@pytest.mark.parametrize("missing_grant", [True, False])
def test_group_denial_identifies_member_or_disjoint_devices(
    test_db, routing_setup, caplog, missing_grant
):
    """Identify the failed group member or the incompatible candidate sets."""
    user, devices, issue = routing_setup
    agents = []
    for index, device in enumerate(devices):
        agent = ProjectChatAgent(
            id=f"diagnostic-member-{index}",
            cloud_project_id=issue.cloud_project_id,
            name=f"Member {index}",
            status="active",
            created_by_user_id=user.id,
            metadata_json={
                "runtime": "codex",
                "execution_policy": {"mode": "fixed", "environment_id": str(device.id)},
                "model_policy": {"mode": "fixed", "model": MODEL},
            },
        )
        authorize_project_agent(test_db, agent)
        agents.append(agent)
    if missing_grant:
        grant = (
            test_db.query(ResourceMember)
            .filter_by(
                resource_type="Device",
                resource_id=devices[1].id,
                entity_type="project",
                entity_id=issue.cloud_project_id,
            )
            .one()
        )
        test_db.delete(grant)
    test_db.flush()

    with pytest.raises(HTTPException) as error:
        resolve_group_routing(
            test_db,
            group={
                "id": "diagnostic-group",
                "leader": {"kind": "agent", "id": agents[0].id},
                "members": [{"kind": "agent", "id": agents[1].id}],
            },
            project_id=issue.cloud_project_id,
            issue_id=issue.id,
            user_id=user.id,
            selection=None,
        )

    events = diagnostic_events(caplog)
    group_event = events[-1]
    assert group_event["group_id"] == "diagnostic-group"
    assert group_event["issue_id"] == issue.id
    if missing_grant:
        assert error.value.detail["error_code"] == "RUNNER_ENVIRONMENT_UNAVAILABLE"
        assert group_event["event"] == "group_member_routing_denied"
        assert group_event["agent_id"] == agents[1].id
        assert group_event["agent_name"] == agents[1].name
        assert group_event["execution_policy"]["environment_id"] == str(devices[1].id)
        assert events[0]["agent_id"] == agents[1].id
    else:
        assert error.value.detail["error_code"] == "ISSUE_RUNNER_CONFLICT"
        assert group_event["event"] == "group_runner_intersection_empty"
        assert group_event["member_candidate_environment_ids"] == {
            agent.id: [device.id] for agent, device in zip(agents, devices)
        }


def test_successful_routing_does_not_log_diagnostics(test_db, routing_setup, caplog):
    """Keep successful candidate resolution free of denial diagnostics."""
    user, devices, issue = routing_setup
    result = _candidates(
        test_db,
        ExecutionPolicy(mode="fixed", environment_id=str(devices[0].id)),
        issue.cloud_project_id,
        user.id,
    )
    assert result == [devices[0]]
    assert diagnostic_events(caplog) == []


def test_creation_validation_records_denied_environment(test_db, routing_setup, caplog):
    """Identify configuration validation separately from execution rejection."""
    user, devices, issue = routing_setup
    with pytest.raises(HTTPException) as error:
        validate_agent_policies(
            test_db,
            user_id=user.id,
            project_id=issue.cloud_project_id,
            policy=ExecutionPolicy(mode="fixed", environment_id="999999999"),
            model_policy=ModelPolicy(mode="fixed", model=MODEL),
            runtime="codex",
        )

    assert error.value.detail["error_code"] == "RUNNER_ENVIRONMENT_UNAVAILABLE"
    event = diagnostic_events(caplog)[0]
    assert event["phase"] == "configuration_validation"
    assert event["execution_policy"]["environment_id"] == "999999999"
    assert event["authorized_environment_ids"] == sorted(
        device.id for device in devices
    )
    assert event["agent_id"] is None


@pytest.mark.parametrize("payload", [{"spec": None}, {"spec": "invalid"}, ["invalid"]])
def test_malformed_device_evidence_preserves_routing_denial(
    test_db, routing_setup, caplog, payload
):
    """Malformed device payloads must not replace the original routing error."""
    user, devices, issue = routing_setup
    target = devices[0]
    target.is_active = False
    target.json = payload
    test_db.flush()

    with pytest.raises(HTTPException) as error:
        _candidates(
            test_db,
            ExecutionPolicy(mode="fixed", environment_id=str(target.id)),
            issue.cloud_project_id,
            user.id,
        )

    assert error.value.status_code == 422
    assert error.value.detail["error_code"] == "RUNNER_ENVIRONMENT_UNAVAILABLE"
    device = next(
        row for row in diagnostic_events(caplog)[0]["devices"] if row["id"] == target.id
    )
    assert device["name"] == target.name
    assert device["is_active"] is False
    assert device["device_key"] is None
