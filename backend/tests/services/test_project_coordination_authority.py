"""Real persistence checks for binding revocation across independent sessions."""

import json
from contextlib import contextmanager
from copy import deepcopy
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.db.session as database_sessions
from app.db.base import Base
from app.models.delivery import CloudProject, LoopItem
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.collaboration_revocation import (
    execution_permission,
    revoke_unauthorized_project_work,
)
from app.services.loop_item_executions.runtime_identity import execution_actor_options
from app.services.project_coordination_authority import (
    binding_matches,
    coordination_scope,
)
from tests.utils.collaboration import authorize_project


@pytest.fixture
def coordination(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'coordination.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    @contextmanager
    def current_session():
        with factory() as session:
            yield session

    monkeypatch.setattr(database_sessions, "get_db_session", current_session)
    with factory() as db:
        owner = User(
            user_name="owner",
            email="owner@example.com",
            password_hash="test",
            is_active=True,
        )
        actor = User(
            user_name="member",
            email="member@example.com",
            password_hash="test",
            is_active=True,
        )
        db.add_all([owner, actor])
        db.flush()
        project = CloudProject(
            id="1001",
            name="Coordination",
            created_by_user_id=owner.id,
            status="active",
            metadata_json={},
        )
        db.add(project)
        db.flush()
        authorize_project(db, project)
        db.add(
            ResourceMember.create(
                resource_type="CloudProject",
                resource_id=1001,
                entity_type="user",
                entity_id=str(actor.id),
                role="Developer",
                status="approved",
            )
        )
        device = Kind(
            kind="Device",
            name="coordinator-device",
            namespace="default",
            user_id=actor.id,
            is_active=True,
            json={"spec": {"deviceType": "local", "deviceId": "coordinator-device"}},
        )
        db.add(device)
        binding = {
            "enabled": True,
            "userId": actor.id,
            "deviceId": "coordinator-device",
            "generation": "generation-one",
        }
        scope = {**binding, "projectId": "1001", "groupId": "101"}
        project.metadata_json = {
            **project.metadata_json,
            "projectCoordination": {"101": binding},
        }
        issue = LoopItem(
            id="ISSUE-1",
            cloud_project_id="1001",
            title="Shared work",
            created_by_user_id=actor.id,
            status="inbox",
            metadata_json={},
        )
        db.add(issue)
        row = LoopItemExecution(
            loop_item_id=issue.id,
            cloud_project_id="1001",
            executor_owner_user_id=actor.id,
            assigner_user_id=actor.id,
            agent_id="",
            team_id=0,
            status="queued",
            execution_scope="coordination:test",
            runtime_task_id="coordinator-work",
            execution_payload=json.dumps(
                {
                    "runtime_selection": {
                        "executor_kind": "collaboration_group_dispatch"
                    },
                    "origin_context": {"project_coordination": scope},
                }
            ),
        )
        db.add(row)
        db.commit()
        fixture = SimpleNamespace(
            factory=factory,
            actor=actor.id,
            owner=owner.id,
            execution=row.id,
            scope=scope,
            binding=binding,
            device=device.id,
        )
    try:
        yield fixture
    finally:
        engine.dispose()


def replace_binding(fixture, **changes):
    with fixture.factory() as db:
        project = db.get(CloudProject, "1001")
        metadata = deepcopy(project.metadata_json)
        metadata["projectCoordination"]["101"].update(changes)
        project.metadata_json = metadata
        db.commit()


@pytest.mark.parametrize(
    "changes",
    [
        {"enabled": False},
        {"generation": "taken-over"},
        {"userId": 999},
        {"deviceId": "other-device"},
    ],
)
def test_committed_revocation_is_seen_without_refreshing_the_callers_project(
    coordination, changes
):
    with coordination.factory() as caller:
        cached = caller.get(CloudProject, "1001")
        execution = caller.get(LoopItemExecution, coordination.execution)
        assert execution_permission(caller, execution).allowed
        replace_binding(coordination, **changes)
        assert not execution_permission(caller, execution).allowed
        assert (
            cached.metadata_json["projectCoordination"]["101"] == coordination.binding
        )
        assert caller.in_transaction()


def test_permission_read_does_not_commit_or_rollback_pending_caller_writes(
    coordination,
):
    replace_binding(coordination, generation="taken-over")
    with coordination.factory() as caller:
        execution = caller.get(LoopItemExecution, coordination.execution)
        issue = caller.get(LoopItem, "ISSUE-1")
        issue.title = "Uncommitted caller change"
        caller.flush()
        assert not execution_permission(caller, execution).allowed
        assert caller.in_transaction()
        assert issue.title == "Uncommitted caller change"
        with coordination.factory() as observer:
            assert observer.get(LoopItem, "ISSUE-1").title == "Shared work"
        caller.rollback()


@pytest.mark.parametrize("change", ["viewer", "device_revoked"])
def test_current_member_and_device_ownership_remain_required(coordination, change):
    with coordination.factory() as writer:
        if change == "viewer":
            grant = (
                writer.query(ResourceMember)
                .filter_by(
                    resource_type="CloudProject",
                    resource_id=1001,
                    entity_type="user",
                    entity_id=str(coordination.actor),
                )
                .one()
            )
            grant.role = "Viewer"
        else:
            writer.get(Kind, coordination.device).is_active = False
        writer.commit()
    with coordination.factory() as caller:
        assert not execution_permission(
            caller, caller.get(LoopItemExecution, coordination.execution)
        ).allowed


def test_member_continuations_inherit_the_original_dispatch_binding(coordination):
    with coordination.factory() as caller:
        parent = caller.get(LoopItemExecution, coordination.execution)
        child = LoopItemExecution(
            loop_item_id=parent.loop_item_id,
            cloud_project_id=parent.cloud_project_id,
            assigner_user_id=parent.assigner_user_id,
            execution_payload=json.dumps(
                {"origin_context": {"collaboration_dispatch_execution_id": parent.id}}
            ),
        )
        assert coordination_scope(caller, child) == coordination.scope
        replace_binding(coordination, generation="taken-over")
        assert not execution_permission(caller, child).allowed


def test_revocation_requests_running_cancellation_without_inventing_termination(
    coordination,
):
    with coordination.factory() as writer:
        writer.get(LoopItemExecution, coordination.execution).status = "running"
        writer.commit()
    replace_binding(coordination, enabled=False)
    with coordination.factory() as caller:
        pending = revoke_unauthorized_project_work(caller, "1001")
        assert [row.id for row in pending] == [coordination.execution]
        assert pending[0].status == "cancel_requested"
        caller.commit()
    with coordination.factory() as observer:
        assert (
            observer.get(LoopItemExecution, coordination.execution).status
            == "cancel_requested"
        )


def test_malformed_and_foreign_binding_fields_never_match():
    scope = {"userId": 7, "deviceId": "device", "generation": "generation"}
    binding = {**scope, "enabled": True}
    assert binding_matches(binding, scope, 7)
    for change in [
        {"userId": True},
        {"generation": ""},
        {"deviceId": None},
        {"enabled": "true"},
    ]:
        assert not binding_matches({**binding, **change}, scope, 7)
    assert not binding_matches(binding, scope, 8)


@pytest.mark.parametrize(
    "routed,coordination,expected",
    [
        (False, False, {}),
        (True, False, {"execution_user_id": 7}),
        (False, True, {"execution_user_id": 7}),
        (True, True, {"execution_user_id": 7}),
    ],
)
def test_runtime_actor_remains_separate_from_device_and_definition_owner(
    routed, coordination, expected
):
    row = SimpleNamespace(
        uses_runner_routing=routed,
        assigner_user_id=7,
        executor_owner_user_id=8,
        runtime_origin_context={"project_coordination": {}} if coordination else {},
    )
    assert execution_actor_options(row) == expected
    assert row.executor_owner_user_id == 8
