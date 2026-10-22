"""Authorization, model matching, defaults, and Issue affinity contracts."""

import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.delivery import LoopItem
from app.models.kind import Kind
from app.models.user import User
from app.schemas.runner_routing import ExecutionPolicy, ModelPolicy, RunnerCatalog
from app.services.runner_routing import (
    bind_claimed_runner,
    claim_routing,
    issue_binding,
    resolve_routing,
)
from tests.services.test_loop_item_executions import _make_project
from tests.utils.collaboration import authorize_project_agent, authorize_resource


def _execution_stub(**kwargs):
    values = dict(
        agent_id="",
        team_id=None,
        execution_environment="local",
        execution_intent={},
        executor_owner_user_id=kwargs["assigner_user_id"],
        runtime_device_id="",
        execution_device_id="",
    )
    return SimpleNamespace(**{**values, **kwargs})


MODEL = {"runtime": "codex", "provider": "openai", "model_id": "model-x"}


@pytest.fixture
def routing_setup(test_db, monkeypatch):
    user = User(user_name="runner-owner", password_hash="test", preferences="{}")
    test_db.add(user)
    test_db.flush()
    project = _make_project(test_db, user, project_id="1000000000001")
    devices = []
    for name in ("first", "second"):
        device = Kind(
            kind="Device",
            name=name,
            namespace="default",
            user_id=user.id,
            is_active=True,
            json={
                "spec": {
                    "deviceType": "local",
                    "runnerCatalog": {
                        "models": [
                            {
                                **MODEL,
                                "label": "Model X",
                                "local_model_id": name + "-model",
                                "is_default": True,
                            }
                        ]
                    },
                }
            },
        )
        test_db.add(device)
        devices.append(device)
    issue = LoopItem(
        id="routing-issue", cloud_project_id=project.id, title="Route", metadata_json={}
    )
    test_db.add(issue)
    test_db.flush()
    for device in devices:
        authorize_resource(test_db, project, device)
    return user, devices, issue


@pytest.mark.parametrize(
    "value", [{"mode": "fixed"}, {"mode": "project_pool", "environment_id": "1"}]
)
def test_invalid_runner_policy(value):
    with pytest.raises(ValidationError):
        ExecutionPolicy.model_validate(value)


def test_fixed_model_requires_identity():
    with pytest.raises(ValidationError):
        ModelPolicy(mode="fixed")


def test_catalog_rejects_duplicate_model_identity():
    model = {**MODEL, "label": "X", "local_model_id": "x"}
    with pytest.raises(ValidationError):
        RunnerCatalog(models=[model, model])


def resolve(db, user, issue, mode="project_pool", selection=None, **kwargs):
    return resolve_routing(
        db,
        config={
            "runtime": "codex",
            "execution_policy": {"mode": mode},
            "model_policy": {"mode": "fixed", "model": MODEL},
        },
        user_id=user.id,
        project_id="1000000000001",
        issue_id=issue.id,
        selection=selection,
        **kwargs,
    )


def test_pool_filters_by_provider_and_model(test_db, routing_setup):
    user, devices, issue = routing_setup
    devices[1].json = {
        "spec": {
            "runnerCatalog": {
                "models": [
                    {
                        **MODEL,
                        "provider": "another-provider",
                        "label": "Model X",
                        "local_model_id": "x",
                    }
                ]
            }
        }
    }
    result = resolve(test_db, user, issue)
    assert result.candidates == [devices[0]]


def test_user_default_is_only_used_for_user_selection(test_db, routing_setup):
    user, devices, issue = routing_setup
    user.preferences = json.dumps({"default_execution_target": devices[0].name})
    assert resolve(test_db, user, issue, "user_select").candidates == [devices[0]]
    assert len(resolve(test_db, user, issue).candidates) == 2


def test_issue_binding_wins_over_changed_personal_default(test_db, routing_setup):
    user, devices, issue = routing_setup
    issue.metadata_json = {"runner_binding": {"environment_id": str(devices[0].id)}}
    user.preferences = json.dumps({"default_execution_target": devices[1].name})
    assert resolve(test_db, user, issue, "user_select").candidates == [devices[0]]


def test_automation_cannot_read_personal_default(test_db, routing_setup):
    user, devices, issue = routing_setup
    user.preferences = json.dumps({"default_execution_target": devices[0].name})
    with pytest.raises(HTTPException) as error:
        resolve(test_db, user, issue, "user_select", automatic=True)
    assert error.value.detail["error_code"] == "AUTOMATION_RUNNER_REQUIRED"


def test_fixed_model_cannot_be_overridden(test_db, routing_setup):
    user, _, issue = routing_setup
    with pytest.raises(HTTPException) as error:
        resolve(
            test_db, user, issue, selection={"model": {**MODEL, "model_id": "other"}}
        )
    assert error.value.detail["error_code"] == "RUNNER_MODEL_FIXED"


def test_claim_checks_binding_and_model_again(test_db, routing_setup):
    user, devices, issue = routing_setup
    selection = {"runner_routing": resolve(test_db, user, issue).snapshot()}
    execution = _execution_stub(
        runtime_selection=selection,
        execution_intent={"runtime_selection": selection},
        loop_item_id=issue.id,
        cloud_project_id="1000000000001",
        assigner_user_id=user.id,
    )
    assert claim_routing(test_db, execution, devices[0])
    bind_claimed_runner(test_db, execution, devices[0])
    assert not claim_routing(test_db, execution, devices[1])
    persisted = json.loads(execution.execution_payload)["runtime_selection"]
    assert persisted["model"] == "first-model"
    assert persisted["model_type"] == "runtime"
    assert persisted["model_options"] == {"runnerModelProvider": "openai"}


@pytest.mark.parametrize("environment_mode", ["fixed", "project_pool", "user_select"])
@pytest.mark.parametrize("model_mode", ["fixed", "user_select"])
def test_six_policy_combinations(test_db, routing_setup, environment_mode, model_mode):
    user, devices, issue = routing_setup
    policy = {"mode": environment_mode}
    selection = {"model": MODEL} if model_mode == "user_select" else {}
    if environment_mode == "fixed":
        policy["environment_id"] = str(devices[0].id)
    elif environment_mode == "user_select":
        selection["execution_policy"] = {
            "mode": "fixed",
            "environment_id": str(devices[0].id),
        }
    result = resolve_routing(
        test_db,
        config={
            "runtime": "codex",
            "execution_policy": policy,
            "model_policy": (
                {"mode": "fixed", "model": MODEL}
                if model_mode == "fixed"
                else {"mode": "user_select"}
            ),
        },
        project_id="1000000000001",
        issue_id=issue.id,
        user_id=user.id,
        selection=selection,
    )
    assert result.model.model_id == MODEL["model_id"]
    assert result.candidates


def test_revoked_project_access_blocks_claim(test_db, routing_setup, monkeypatch):
    user, devices, issue = routing_setup
    snapshot = resolve(test_db, user, issue).snapshot()

    def revoked(*args):
        raise HTTPException(403, "Access revoked")

    monkeypatch.setattr(
        "app.services.runner_routing.require_cloud_project_role", revoked
    )
    execution = _execution_stub(
        runtime_selection={"runner_routing": snapshot},
        loop_item_id=issue.id,
        cloud_project_id="1000000000001",
        assigner_user_id=user.id,
    )
    assert not claim_routing(test_db, execution, devices[0])
    assert not (issue.metadata_json or {}).get("runner_binding")


def test_model_removal_blocks_claim_without_binding_issue(test_db, routing_setup):
    user, devices, issue = routing_setup
    snapshot = resolve(test_db, user, issue).snapshot()
    devices[0].json = {"spec": {"runnerCatalog": {"models": []}}}
    execution = _execution_stub(
        runtime_selection={"runner_routing": snapshot},
        loop_item_id=issue.id,
        cloud_project_id="1000000000001",
        assigner_user_id=user.id,
    )
    assert not claim_routing(test_db, execution, devices[0])
    assert not (issue.metadata_json or {}).get("runner_binding")


def test_environment_model_never_resolves_user_credentials(mocker):
    from app.services.runtime_work_service import _runtime_model_override_values

    db = mocker.Mock()
    config, _, _ = _runtime_model_override_values(
        db=db,
        user_id=7,
        runtime="codex",
        model_id="native-id",
        model_type="runtime",
        model_options={"runnerModelProvider": "provider-a"},
    )
    assert config == {"model_id": "native-id", "model_provider": "provider-a"}
    db.query.assert_not_called()


@pytest.mark.parametrize("prepared_workspace", [True, False])
def test_cross_owner_claim_compiles_native_payload(
    test_db, test_user, test_admin_user, monkeypatch, prepared_workspace
):
    from app.services.loop_item_executions.service import loop_item_execution_service
    from app.services.runner_routing import save_catalog
    from tests.services.test_loop_item_executions import (
        _ensure_device,
        _make_bot,
        _make_item,
        _make_project,
    )

    project = _make_project(test_db, test_user)
    agent = _make_bot(test_db, project, test_user)
    issue = _make_item(test_db, project, test_user)
    runner = _ensure_device(test_db, test_admin_user, "shared-runner", "local")
    authorize_resource(test_db, project, runner)
    save_catalog(
        test_db,
        runner,
        RunnerCatalog(models=[{**MODEL, "label": "X", "local_model_id": "native-x"}]),
    )
    agent.device_id = ""
    agent.metadata_json = {
        **agent.metadata_json,
        "execution_policy": {"mode": "project_pool"},
        "model_policy": {"mode": "fixed", "model": MODEL},
    }
    project.metadata_json = (
        {
            "execution_environment": {
                "workspace_policy": "project",
                "devices": {
                    "shared-runner": {
                        "status": "ready",
                        "workspace_path": "/workspace/project",
                    }
                },
            }
        }
        if prepared_workspace
        else {}
    )
    test_db.flush()
    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=issue.id,
        cloud_project_id=str(project.id),
        agent=agent,
        assigner_user_id=test_user.id,
        environment="local",
        execution_device_id=None,
        priority="medium",
    )
    assert execution.status == "queued"
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id=runner.name,
        owner_user_id=runner.user_id,
        environment="local",
        runtime_instance_id="shared-instance",
    )
    assert claimed is not None
    assert claimed.executor_owner_user_id == test_admin_user.id
    assert issue_binding(test_db, issue.id) == str(runner.id)
    payload = loop_item_execution_service.build_executor_runtime_payload(
        test_db,
        execution=claimed,
        execution_target_id=runner.name,
        executor_device_id=runner.name,
    )
    assert payload["executionRequest"]["model_config"] == {
        "model_id": "native-x",
        "model_provider": "openai",
    }
    if prepared_workspace:
        assert payload["workspacePath"] == "/workspace/project"
        assert payload["standaloneChatWorkspace"] is False
        assert (
            payload["execution"]["environment"]["workspacePath"] == "/workspace/project"
        )
    else:
        assert payload["standaloneChatWorkspace"] is True
        assert payload.get("workspacePath") in (None, "")
        assert payload.get("execution") is None
        assert claimed.runtime_request.get("projectId") is None
    assert payload["modelType"] == "runtime"
    assert payload["executionRequest"]["user"]["id"] == test_user.id

    # A lost pull acknowledgement must not bypass a later authorization revocation.
    from app.models.resource_member import ResourceMember
    from app.services.loop_item_executions.service import (
        WeworkRuntimeConfigurationError,
    )

    source = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Device",
            resource_id=runner.id,
            entity_type="workspace",
            entity_id=str(project.workspace_id),
        )
        .one()
    )
    source.status = "rejected"
    test_db.flush()
    with pytest.raises(
        WeworkRuntimeConfigurationError, match="RUNNER_CONFIGURATION_CONFLICT"
    ):
        loop_item_execution_service.build_executor_runtime_payload(
            test_db,
            execution=claimed,
            execution_target_id=runner.name,
            executor_device_id=runner.name,
        )


def test_two_concurrent_first_claims_bind_only_one_environment(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app.db.base import Base

    engine = create_engine(
        f"sqlite:///{tmp_path / 'claims.sqlite'}", connect_args={"timeout": 10}
    )
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        owner = User(user_name="concurrent-owner", password_hash="test")
        db.add(owner)
        db.flush()
        runners = [
            Kind(
                kind="Device",
                name=f"runner-{index}",
                namespace="default",
                user_id=owner.id,
                is_active=True,
                json={
                    "spec": {
                        "runnerCatalog": {
                            "models": [{**MODEL, "label": "X", "local_model_id": "x"}]
                        }
                    }
                },
            )
            for index in range(2)
        ]
        db.add_all(runners)
        project = _make_project(db, owner, project_id="1000000000001")
        issue = LoopItem(
            id="concurrent-issue",
            cloud_project_id=project.id,
            title="Issue",
            metadata_json={},
        )
        db.add(issue)
        db.flush()
        for runner in runners:
            authorize_resource(db, project, runner)
        ids, owner_id = [runner.id for runner in runners], owner.id
        db.commit()
    monkeypatch.setattr(
        "app.services.runner_routing.project_environment_ids", lambda *_: set(ids)
    )
    barrier = Barrier(2)

    def claim(device_id):
        with Session(engine) as db:
            runner = db.get(Kind, device_id)
            execution = _execution_stub(
                loop_item_id="concurrent-issue",
                cloud_project_id="1000000000001",
                assigner_user_id=owner_id,
                runtime_selection={
                    "runner_routing": {
                        "execution_policy": {"mode": "project_pool"},
                        "model": MODEL,
                    }
                },
            )
            barrier.wait(timeout=5)
            accepted = claim_routing(db, execution, runner)
            db.commit()
            return accepted

    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(claim, ids))
    assert result.count(True) == 1
    with Session(engine) as db:
        assert issue_binding(db, "concurrent-issue") in {str(id) for id in ids}
    engine.dispose()


def test_group_routes_require_one_runner_for_every_member(test_db, routing_setup):
    from app.models.delivery import ProjectChatAgent
    from app.services.runner_routing import eligible_runner, resolve_group_routing

    user, devices, issue = routing_setup
    other_model = {**MODEL, "model_id": "model-y"}
    devices[1].json = {
        "spec": {
            "runnerCatalog": {
                "models": [
                    {**model, "label": "Model", "local_model_id": model["model_id"]}
                    for model in [MODEL, other_model]
                ]
            }
        }
    }
    agents = []
    for index, model in enumerate([MODEL, other_model]):
        agent = ProjectChatAgent(
            id=f"group-member-{index}",
            cloud_project_id="1000000000001",
            name=f"Member {index}",
            status="active",
            created_by_user_id=user.id,
            metadata_json={
                "runtime": "codex",
                "execution_policy": {"mode": "project_pool"},
                "model_policy": {"mode": "fixed", "model": model},
            },
        )
        authorize_project_agent(test_db, agent)
        agents.append(agent)
        test_db.add(agent)
    test_db.flush()
    group = {
        "leader": {"kind": "agent", "id": agents[0].id},
        "members": [{"kind": "agent", "id": agents[1].id}],
    }
    routes = resolve_group_routing(
        test_db,
        group=group,
        project_id="1000000000001",
        issue_id=issue.id,
        user_id=user.id,
        selection=None,
        automatic=True,
    )
    run = _execution_stub(
        runtime_selection={
            "runner_routing": routes[agents[0].id],
            "group_runner_requirements": routes,
        },
        loop_item_id=issue.id,
        cloud_project_id="1000000000001",
        assigner_user_id=user.id,
    )
    assert not eligible_runner(test_db, run, devices[0])
    assert eligible_runner(test_db, run, devices[1])
    issue.metadata_json = {"runner_binding": {"environment_id": str(devices[0].id)}}
    with pytest.raises(HTTPException) as error:
        resolve_group_routing(
            test_db,
            group=group,
            project_id="1000000000001",
            issue_id=issue.id,
            user_id=user.id,
            selection=None,
        )
    assert error.value.detail["error_code"] == "RUNNER_MODEL_UNAVAILABLE"


def test_routed_approval_preserves_deferred_claim(test_db, test_user, monkeypatch):
    from app.services.loop_item_executions.service import loop_item_execution_service
    from app.services.runner_routing import save_catalog
    from tests.services.test_loop_item_executions import (
        _ensure_device,
        _make_bot,
        _make_item,
        _make_project,
    )

    project = _make_project(test_db, test_user)
    agent = _make_bot(test_db, project, test_user, mode="manual_approval")
    issue = _make_item(test_db, project, test_user)
    runner = _ensure_device(test_db, test_user, "approval-runner", "local")
    authorize_resource(test_db, project, runner)
    save_catalog(
        test_db,
        runner,
        RunnerCatalog(models=[{**MODEL, "label": "Model", "local_model_id": "native"}]),
    )
    agent.metadata_json = {
        **agent.metadata_json,
        "execution_policy": {"mode": "project_pool"},
        "model_policy": {"mode": "fixed", "model": MODEL},
    }
    monkeypatch.setattr(
        "app.services.runner_routing.project_environment_ids", lambda *_: {runner.id}
    )
    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=issue.id,
        cloud_project_id=str(project.id),
        agent=agent,
        assigner_user_id=test_user.id,
        environment="local",
        execution_device_id=None,
        priority="medium",
    )
    assert execution.status == "pending_approval"
    approved = loop_item_execution_service.approve(
        test_db, execution_id=execution.id, user_id=test_user.id
    )
    assert approved.status == "queued"
    assert not (issue.metadata_json or {}).get("runner_binding")


def test_group_automation_keeps_run_identity_and_assignment_snapshot(
    test_db, test_user, monkeypatch
):
    from app.services.collaboration_group_execution import (
        collaboration_group_snapshot_for_dispatch,
        dispatch_collaboration_group_assignment,
    )
    from app.services.loop_item_executions.service import loop_item_execution_service
    from app.services.runner_routing import save_catalog
    from tests.services.test_loop_item_executions import (
        _ensure_device,
        _make_bot,
        _make_item,
        _make_project,
    )

    project = _make_project(test_db, test_user)
    agent = _make_bot(test_db, project, test_user)
    issue = _make_item(test_db, project, test_user)
    runner = _ensure_device(test_db, test_user, "group-runner", "local")
    authorize_resource(test_db, project, runner)
    save_catalog(
        test_db,
        runner,
        RunnerCatalog(models=[{**MODEL, "label": "Model", "local_model_id": "native"}]),
    )
    agent.metadata_json = {
        **agent.metadata_json,
        "execution_policy": {"mode": "project_pool"},
        "model_policy": {"mode": "fixed", "model": MODEL},
    }
    group = {
        "id": "group",
        "name": "Group",
        "leader": {"kind": "agent", "id": agent.id},
        "members": [],
    }
    from app.models.resource_member import ResourceMember

    record = Kind(
        kind="CollaborationGroup",
        name="Group",
        namespace=f"projects/{project.id}",
        user_id=test_user.id,
        is_active=True,
        json={"spec": group},
    )
    test_db.add(record)
    test_db.flush()
    group["id"] = str(record.id)
    test_db.add(
        ResourceMember.create(
            resource_type="CollaborationGroup",
            resource_id=record.id,
            entity_type="project",
            entity_id=str(project.id),
            role="Developer",
            status="approved",
        )
    )
    test_db.flush()
    issue.metadata_json = {
        "collaboration_group": group,
        "collaboration_group_assignment_key": "assignment",
    }
    monkeypatch.setattr(
        "app.services.runner_routing.project_environment_ids", lambda *_: {runner.id}
    )
    execution = dispatch_collaboration_group_assignment(
        test_db,
        item=issue,
        user_id=test_user.id,
        group=group,
        automatic=True,
        automation_context={"run_id": "automation-run"},
    )
    assert execution.automation_run_id == "automation-run"
    assert (
        collaboration_group_snapshot_for_dispatch(item=issue, execution=execution)
        == group
    )
    assert (
        execution.runtime_selection["group_runner_requirements"][agent.id]["model"]
        == MODEL
    )
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id=runner.name,
        environment="local",
        runtime_instance_id="instance",
        owner_user_id=test_user.id,
    )
    assert claimed.id == execution.id


@pytest.mark.asyncio
async def test_queue_explains_offline_capacity_and_revoked_model(
    test_db, routing_setup, monkeypatch
):
    from app.models.loop_item_execution import LoopItemExecution
    from app.services.runner_catalog import annotate_queue

    user, devices, issue = routing_setup
    snapshot = resolve(test_db, user, issue).snapshot()
    run = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id="1000000000001",
        assigner_user_id=user.id,
        executor_owner_user_id=user.id,
        status="queued",
        execution_payload=json.dumps(
            {"runtime_selection": {"runner_routing": snapshot}}
        ),
    )
    test_db.add(run)
    test_db.flush()

    async def offline(devices):
        return {device.id: "offline" for device in devices}

    monkeypatch.setattr(
        "app.services.runner_catalog.execution_environment_statuses", offline
    )
    rows = [{"id": run.id}]
    await annotate_queue(test_db, rows)
    assert rows[0]["waiting_runtime_reason"].startswith("RUNNER_OFFLINE:")

    async def online(devices):
        return {device.id: "online" for device in devices}

    monkeypatch.setattr(
        "app.services.runner_catalog.execution_environment_statuses", online
    )
    rows = [{"id": run.id}]
    await annotate_queue(test_db, rows)
    assert rows[0]["waiting_runtime_reason"].startswith("RUNNER_BUSY:")
    for device in devices:
        device.json = {"spec": {"runnerCatalog": {"models": []}}}
    rows = [{"id": run.id}]
    await annotate_queue(test_db, rows)
    assert rows[0]["error_message"].startswith("RUNNER_CONFIGURATION_CONFLICT:")


def test_role_downgrade_prevents_queued_execution_claim(
    test_db, test_admin_user, routing_setup, monkeypatch
):
    from app.models.resource_member import ResourceMember
    from app.schemas.base_role import BaseRole
    from app.services.cloud_projects.access import require_cloud_project_role
    from tests.services.test_loop_item_executions import _make_project

    user, devices, issue = routing_setup
    project = _make_project(test_db, test_admin_user)
    issue.cloud_project_id = project.id
    for device in devices:
        authorize_resource(test_db, project, device)
    grant = ResourceMember(
        resource_type="CloudProject",
        resource_id=project.id,
        entity_type="user",
        entity_id=str(user.id),
        role=BaseRole.Developer.value,
        status="approved",
    )
    test_db.add(grant)
    test_db.flush()
    monkeypatch.setattr(
        "app.services.runner_routing.require_cloud_project_role",
        require_cloud_project_role,
    )
    kwargs = dict(
        config={
            "runtime": "codex",
            "execution_policy": {"mode": "project_pool"},
            "model_policy": {"mode": "fixed", "model": MODEL},
        },
        project_id=str(project.id),
        issue_id=issue.id,
        user_id=user.id,
        selection=None,
    )
    route = resolve_routing(test_db, **kwargs)
    grant.role = BaseRole.Viewer.value
    test_db.flush()
    with pytest.raises(HTTPException) as error:
        resolve_routing(test_db, **kwargs)
    assert error.value.detail["error_code"] == "RUNNER_PROJECT_ACCESS_REVOKED"
    execution = _execution_stub(
        runtime_selection={"runner_routing": route.snapshot()},
        loop_item_id=issue.id,
        cloud_project_id=str(project.id),
        assigner_user_id=user.id,
    )
    assert not claim_routing(test_db, execution, devices[0])
    assert not (issue.metadata_json or {}).get("runner_binding")


@pytest.mark.parametrize(
    "metadata",
    [None, {"tags": ["keep"], "content_revision": 7}, {"runner_binding": None}],
)
def test_claim_writes_binding_to_metadata_and_rollback_discards_it(
    test_db, routing_setup, metadata
):
    user, devices, issue = routing_setup
    issue.metadata_json = metadata
    test_db.commit()
    snapshot = resolve(test_db, user, issue).snapshot()
    execution = _execution_stub(
        loop_item_id=issue.id,
        cloud_project_id="1000000000001",
        assigner_user_id=user.id,
        runtime_selection={"runner_routing": snapshot},
    )

    assert claim_routing(test_db, execution, devices[0])
    assert issue.metadata_json == {
        **(metadata or {}),
        "runner_binding": {"environment_id": str(devices[0].id)},
    }
    test_db.rollback()
    test_db.refresh(issue)
    assert issue.metadata_json == metadata


def test_historical_aliases_resolve_without_rewriting_the_issue(test_db, routing_setup):
    from app.models.delivery import LoopItemTaskBinding
    from app.models.loop_item_execution import LoopItemExecution

    user, devices, issue = routing_setup
    alias = devices[0].name
    test_db.add(
        LoopItemExecution(
            loop_item_id=issue.id,
            executor_owner_user_id=user.id,
            runtime_device_id=alias,
            status="completed",
        )
    )
    test_db.add(
        LoopItemTaskBinding(
            loop_item_id=issue.id,
            device_id=alias,
            task_user_id=user.id,
            task_id="historical-session",
        )
    )
    test_db.flush()
    original = dict(issue.metadata_json)

    assert issue_binding(test_db, issue.id) == str(devices[0].id)
    assert issue.metadata_json == original
    user.preferences = json.dumps({"default_execution_target": devices[1].name})
    assert resolve(test_db, user, issue, "user_select").candidates == [devices[0]]


@pytest.mark.parametrize("aliases", [("first", "second"), ("missing-runner",)])
def test_conflicting_or_unresolved_history_requires_configuration(
    test_db, routing_setup, aliases
):
    from app.models.loop_item_execution import LoopItemExecution

    user, devices, issue = routing_setup
    for alias in aliases:
        test_db.add(
            LoopItemExecution(
                loop_item_id=issue.id,
                executor_owner_user_id=user.id,
                runtime_device_id=alias,
                status="completed",
            )
        )
    test_db.flush()
    user.preferences = json.dumps({"default_execution_target": devices[0].name})
    with pytest.raises(HTTPException) as error:
        resolve(test_db, user, issue, "user_select")
    assert error.value.detail["error_code"] == "ISSUE_RUNNER_CONFIGURATION_REQUIRED"
    assert not issue.metadata_json.get("runner_binding")


def test_stale_content_writer_preserves_committed_binding(tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app.db.base import Base

    engine = create_engine(f"sqlite:///{tmp_path / 'metadata.sqlite'}")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(
            LoopItem(
                id="stale-issue", title="Issue", metadata_json={"tags": ["original"]}
            )
        )
        db.commit()
    with Session(engine) as content_db, Session(engine) as claim_db:
        stale = content_db.get(LoopItem, "stale-issue")
        bound = claim_db.get(LoopItem, "stale-issue")
        bound.metadata_json = {
            **bound.metadata_json,
            "runner_binding": {"environment_id": "42"},
        }
        claim_db.commit()
        stale.metadata_json = {**stale.metadata_json, "tags": ["edited"]}
        content_db.commit()
    with Session(engine) as db:
        assert db.get(LoopItem, "stale-issue").metadata_json == {
            "tags": ["edited"],
            "runner_binding": {"environment_id": "42"},
        }
    engine.dispose()


@pytest.mark.parametrize("mode", ["fixed", "project_pool", "user_select"])
def test_cp12_all_routing_policies_require_current_project_resource_grants(
    test_db, routing_setup, mode
):
    from app.models.resource_member import ResourceMember

    user, devices, issue = routing_setup
    test_db.query(ResourceMember).filter_by(
        resource_type="Device", entity_type="workspace"
    ).delete()
    test_db.flush()
    policy = {"mode": mode}
    selection = None
    if mode == "fixed":
        policy["environment_id"] = str(devices[0].id)
    elif mode == "user_select":
        selection = {
            "execution_policy": {"mode": "fixed", "environment_id": str(devices[0].id)}
        }
    with pytest.raises(HTTPException):
        resolve_routing(
            test_db,
            config={
                "runtime": "codex",
                "execution_policy": policy,
                "model_policy": {"mode": "fixed", "model": MODEL},
            },
            user_id=user.id,
            project_id=issue.cloud_project_id,
            issue_id=issue.id,
            selection=selection,
        )


def test_catalog_report_preserves_device_config_updated_after_loading(
    test_db, routing_setup
):
    from app.services.runner_routing import save_catalog

    user, devices, _ = routing_setup
    device = devices[0]
    cloud_config = {"sandboxId": "managed-sandbox", "deviceId": device.name}
    latest = {
        **device.json,
        "spec": {**device.json["spec"], "cloudConfig": cloud_config},
    }
    test_db.query(Kind).filter(
        Kind.id == device.id,
        Kind.user_id == user.id,
        Kind.namespace == "default",
    ).update({Kind.json: latest}, synchronize_session=False)
    assert "cloudConfig" not in device.json["spec"]

    report = RunnerCatalog(
        models=[{**MODEL, "label": "Updated model", "local_model_id": "updated-native"}]
    )
    save_catalog(test_db, device, report)
    test_db.expire(device, ["json"])

    assert device.json["spec"]["cloudConfig"] == cloud_config
    assert device.json["spec"]["runnerCatalog"] == report.model_dump()
