# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Roster writes share the project control plane without widening source access."""

import uuid
from copy import deepcopy

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, ProjectChatAgent
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.cloud_project import (
    CloudProjectBoardConfig,
    CloudProjectMemberCreate,
    CloudProjectMemberUpdate,
    CloudProjectUpdate,
)
from app.schemas.project_chat import ProjectChatAgentCreate, ProjectChatAgentUpdate
from app.services.cloud_projects.service import cloud_project_service
from app.services.project_chat.service import project_chat_service
from tests.utils.collaboration import authorize_project, authorize_project_agent


@pytest.fixture
def roster_project(test_db: Session, test_user: User) -> CloudProject:
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key=f"ROSTER{uuid.uuid4().hex[:5].upper()}",
        name="Project roster",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{uuid.uuid4()}",
        metadata_json={"task_provider": "local"},
    )
    authorize_project(test_db, project)
    test_db.commit()
    return project


def _user(db: Session, name: str) -> User:
    user = User(user_name=name, password_hash="unused", is_active=True)
    db.add(user)
    db.commit()
    return user


def _agent(
    db: Session, project: CloudProject, user: User, **metadata
) -> ProjectChatAgent:
    agent = ProjectChatAgent(
        id=uuid.uuid4().hex,
        cloud_project_id=project.id,
        name="Assistant",
        title="Assistant",
        description="Development",
        status="active",
        created_by_user_id=user.id,
        metadata_json={
            "runtime": "codex",
            "system_prompt": "private prompt",
            "mcp_servers": {"private": {"token": "private token"}},
            "memory": "private memory",
            "transcript": "private transcript",
            "workspace_binding": {"type": "standalone", "status": "ready"},
            **metadata,
        },
    )
    authorize_project_agent(db, agent)
    db.commit()
    return agent


def _update(db, project, user, **values):
    result = cloud_project_service.update(
        db,
        int(project.id),
        user.id,
        CloudProjectUpdate(version=project.version, **values),
    )
    return cloud_project_service.admin_result(result)


def _configuration(db, project, user):
    return cloud_project_service.admin_config(db, int(project.id), user.id)[
        "configuration"
    ]


def test_member_preview_rolls_back_grants_and_does_not_audit(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    target = _user(test_db, "preview-member")
    before = deepcopy(roster_project.metadata_json)
    version = roster_project.version

    result = _update(
        test_db,
        roster_project,
        test_user,
        dry_run=True,
        member_changes=[
            {
                "operation": "add",
                "user_id": target.id,
                "permission_role": "Viewer",
                "capability_description": "QA",
            }
        ],
    )

    assert result["dryRun"] is True
    assert result["auditId"] is None
    assert any(member["user_id"] == target.id for member in result["after"]["members"])
    assert not any(
        member["user_id"] == target.id
        for member in _configuration(test_db, roster_project, test_user)["members"]
    )
    assert roster_project.metadata_json == before
    assert roster_project.version == version


def test_member_roles_responsibilities_and_retry_use_one_project_audit(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    target = _user(test_db, "permitted-member")
    request = CloudProjectUpdate(
        version=roster_project.version,
        operation_id="add-member",
        member_changes=[
            {
                "operation": "add",
                "user_id": target.id,
                "permission_role": "Viewer",
                "capability_description": "Release owner",
            }
        ],
    )
    updated = cloud_project_service.update(
        test_db, int(roster_project.id), test_user.id, request
    )
    receipt = cloud_project_service.admin_result(updated)
    replay = cloud_project_service.update(
        test_db, int(roster_project.id), test_user.id, request
    )

    assert cloud_project_service.admin_result(replay) == receipt
    member = next(
        value for value in receipt["after"]["members"] if value["user_id"] == target.id
    )
    assert member["permission_role"] == member["direct_role"] == "Viewer"
    assert member["capability_description"] == "Release owner"
    assert "email" not in member
    assert len(roster_project.metadata_json["project_admin_operations"]) == 1
    with pytest.raises(HTTPException) as failure:
        _update(test_db, roster_project, target, name="Cannot configure")
    assert failure.value.status_code == 403


def test_legacy_member_entry_points_share_project_versions_and_atomic_audit(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    target = _user(test_db, "legacy-page-member")
    version = roster_project.version

    added = cloud_project_service.add_member(
        test_db,
        int(roster_project.id),
        test_user.id,
        CloudProjectMemberCreate(
            user_id=target.id,
            role="Developer",
            capability_description="Development",
        ),
    )
    assert added["role"] == "Developer"
    assert added["capability_description"] == "Development"
    assert roster_project.version == version + 1
    assert len(roster_project.metadata_json["project_admin_operations"]) == 1

    changed = cloud_project_service.update_member(
        test_db,
        int(roster_project.id),
        target.id,
        test_user.id,
        CloudProjectMemberUpdate(role="Viewer", capability_description="QA"),
    )
    assert changed["role"] == "Viewer"
    assert changed["capability_description"] == "QA"
    assert roster_project.version == version + 2
    assert len(roster_project.metadata_json["project_admin_operations"]) == 2

    result = cloud_project_service.remove_member(
        test_db,
        int(roster_project.id),
        target.id,
        test_user.id,
    )
    assert result is None
    assert roster_project.version == version + 3
    journal = roster_project.metadata_json["project_admin_operations"]
    assert len(journal) == 3
    for operation_id, operation in journal.items():
        receipt = operation["result"]
        assert receipt["auditId"]
        assert receipt["operationId"] == operation_id
        assert receipt["actor"]["userId"] == test_user.id
        assert "members" in {change["path"] for change in receipt["diff"]}


def test_legacy_member_failure_does_not_write_project_version_or_audit(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    before = deepcopy(roster_project.metadata_json)
    version = roster_project.version

    with pytest.raises(HTTPException) as failure:
        cloud_project_service.add_member(
            test_db,
            int(roster_project.id),
            test_user.id,
            CloudProjectMemberCreate(user_id=test_user.id + 10000, role="Developer"),
        )

    assert failure.value.status_code == 404
    assert roster_project.version == version
    assert roster_project.metadata_json == before


def test_legacy_agent_update_preserves_source_contract_and_sanitizes_audit(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    agent = _agent(test_db, roster_project, test_user)
    project_version, agent_version = roster_project.version, agent.version

    response = project_chat_service.update_agent(
        test_db,
        user_id=test_user.id,
        project_id=str(roster_project.id),
        agent_id=agent.id,
        request=ProjectChatAgentUpdate(
            version=agent_version,
            capability_description="Release",
            system_prompt="new private prompt",
        ),
    )

    assert response.id == agent.id
    assert response.system_prompt == "new private prompt"
    assert response.capability_description == "Release"
    assert response.version == agent_version + 1
    assert roster_project.version == project_version + 1
    journal = roster_project.metadata_json["project_admin_operations"]
    assert len(journal) == 1
    receipt = next(iter(journal.values()))["result"]
    assert receipt["auditId"]
    assert "assistant_roster" in {change["path"] for change in receipt["diff"]}
    assert "private prompt" not in str(journal)
    assert "private token" not in str(journal)
    assert "private memory" not in str(journal)
    assert "private transcript" not in str(journal)


def test_legacy_agent_creation_adds_one_version_and_safe_audit_receipt(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    version = roster_project.version

    response = project_chat_service.create_agent(
        test_db,
        user_id=test_user.id,
        project_id=str(roster_project.id),
        request=ProjectChatAgentCreate(
            name="Private project assistant",
            visibility="private",
            system_prompt="private source prompt",
            mcp_servers={"source": {"token": "private source token"}},
        ),
    )

    assert response.version == 1
    assert response.visibility == "private"
    assert response.can_edit is True
    assert response.system_prompt == "private source prompt"
    assert roster_project.version == version + 1
    journal = roster_project.metadata_json["project_admin_operations"]
    assert len(journal) == 1
    receipt = next(iter(journal.values()))["result"]
    assert receipt["auditId"]
    assert receipt["before"]["assistant_roster"] == []
    assert receipt["after"]["assistant_roster"][0]["agent_id"] == response.id
    assert "private source prompt" not in str(journal)
    assert "private source token" not in str(journal)


def test_legacy_agent_creation_rolls_back_definition_and_grant_on_audit_failure(
    test_db: Session,
    test_user: User,
    roster_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    version = roster_project.version
    commits = []

    def fail_result(*_args, **_kwargs):
        raise RuntimeError("Audit result unavailable")

    def before_commit(_session):
        commits.append(True)

    monkeypatch.setattr("app.services.cloud_projects.admin._result", fail_result)
    event.listen(test_db, "before_commit", before_commit)
    try:
        with pytest.raises(RuntimeError, match="Audit result unavailable"):
            project_chat_service.create_agent(
                test_db,
                user_id=test_user.id,
                project_id=str(roster_project.id),
                request=ProjectChatAgentCreate(name="Rolled back assistant"),
            )
    finally:
        event.remove(test_db, "before_commit", before_commit)

    assert commits == []
    assert roster_project.version == version
    assert "project_admin_operations" not in roster_project.metadata_json
    assert (
        test_db.query(ProjectChatAgent)
        .filter_by(cloud_project_id=roster_project.id)
        .count()
        == 0
    )
    assert (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            resource_id=roster_project.workspace_id,
            entity_type="project_agent",
        )
        .count()
        == 0
    )


def test_legacy_agent_source_denial_leaves_definition_version_and_audit_unchanged(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    creator = _user(test_db, "legacy-source-owner")
    agent = _agent(test_db, roster_project, creator, wegent_team_id=999)
    metadata = deepcopy(agent.metadata_json)
    project_version, agent_version = roster_project.version, agent.version

    with pytest.raises(HTTPException) as failure:
        project_chat_service.update_agent(
            test_db,
            user_id=test_user.id,
            project_id=str(roster_project.id),
            agent_id=agent.id,
            request=ProjectChatAgentUpdate(
                version=agent_version, system_prompt="forbidden"
            ),
        )

    assert failure.value.status_code == 403
    assert failure.value.detail["reason_code"] == "permission_denied"
    assert "Only the Agent creator" in failure.value.detail["message"]
    assert roster_project.version == project_version
    assert agent.version == agent_version
    assert agent.metadata_json == metadata
    assert "project_admin_operations" not in roster_project.metadata_json


@pytest.mark.parametrize("mutation_kind", ["member", "assistant"])
def test_legacy_mutation_rolls_back_when_audit_result_cannot_be_built(
    test_db: Session,
    test_user: User,
    roster_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
    mutation_kind: str,
) -> None:
    target = _user(test_db, "audit-rollback-target")
    agent = _agent(test_db, roster_project, test_user)
    metadata = deepcopy(agent.metadata_json)
    project_version, agent_version = roster_project.version, agent.version
    commits = []

    def fail_result(*_args, **_kwargs):
        raise RuntimeError("Audit result unavailable")

    def before_commit(_session):
        commits.append(True)

    monkeypatch.setattr("app.services.cloud_projects.admin._result", fail_result)
    event.listen(test_db, "before_commit", before_commit)
    try:
        with pytest.raises(RuntimeError, match="Audit result unavailable"):
            if mutation_kind == "member":
                cloud_project_service.add_member(
                    test_db,
                    int(roster_project.id),
                    test_user.id,
                    CloudProjectMemberCreate(user_id=target.id, role="Developer"),
                )
            else:
                project_chat_service.update_agent(
                    test_db,
                    user_id=test_user.id,
                    project_id=str(roster_project.id),
                    agent_id=agent.id,
                    request=ProjectChatAgentUpdate(
                        version=agent_version, system_prompt="new private prompt"
                    ),
                )
    finally:
        event.remove(test_db, "before_commit", before_commit)

    assert commits == []
    assert roster_project.version == project_version
    assert "project_admin_operations" not in roster_project.metadata_json
    assert agent.version == agent_version
    assert agent.metadata_json == metadata
    assert (
        cloud_project_service._direct_member(test_db, int(roster_project.id), target.id)
        is None
    )


def test_later_invalid_roster_change_rolls_back_the_whole_batch(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    target = _user(test_db, "atomic-member")
    before = deepcopy(roster_project.metadata_json)
    version = roster_project.version

    with pytest.raises(HTTPException):
        _update(
            test_db,
            roster_project,
            test_user,
            member_changes=[
                {
                    "operation": "add",
                    "user_id": target.id,
                    "permission_role": "Developer",
                },
                {
                    "operation": "add",
                    "user_id": target.id + 10000,
                    "permission_role": "Viewer",
                },
            ],
        )

    assert roster_project.version == version
    assert roster_project.metadata_json == before
    assert not any(
        value["user_id"] == target.id
        for value in _configuration(test_db, roster_project, test_user)["members"]
    )


@pytest.mark.parametrize("dry_run", [True, False])
def test_member_batch_retains_prepared_tag_reference_cleanup(
    test_db: Session,
    test_user: User,
    roster_project: CloudProject,
    dry_run: bool,
) -> None:
    target = _user(test_db, "tag-batch-member")
    board_config = CloudProjectBoardConfig().model_dump()
    board_config["schedule_view"]["tag_filter"] = "design"
    roster_project.metadata_json = {
        **roster_project.metadata_json,
        "tags": ["design", "review"],
        "board_config": board_config,
        "board_views": {
            "schema_version": 1,
            "views": [
                {
                    "id": "delivery",
                    "name": "Delivery",
                    "columns": [
                        {"id": "design", "type": "tag", "value": "design"},
                        {"id": "remaining", "type": "unmatched", "value": "Other"},
                    ],
                    "filter": {"tags": ["design", "review"]},
                }
            ],
        },
    }
    test_db.commit()
    before = deepcopy(roster_project.metadata_json)

    receipt = _update(
        test_db,
        roster_project,
        test_user,
        dry_run=dry_run,
        tag_change={"source": "design", "target": None},
        member_changes=[
            {
                "operation": "add",
                "user_id": target.id,
                "permission_role": "Developer",
            }
        ],
    )

    assert receipt["after"]["tags"] == ["review"]
    view = receipt["after"]["board_views"]["views"][0]
    assert view["columns"] == [
        {"id": "remaining", "type": "unmatched", "value": "Other"}
    ]
    assert view["filter"]["tags"] == ["review"]
    assert receipt["after"]["board_config"]["schedule_view"]["tag_filter"] is None
    if dry_run:
        assert roster_project.metadata_json == before
        assert receipt["auditId"] is None
    else:
        test_db.refresh(roster_project)
        assert roster_project.metadata_json["project_removed_tags"] == ["design"]
        assert roster_project.metadata_json["board_views"]["views"][0] == view


def test_remove_direct_preserves_workspace_inheritance(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    target = _user(test_db, "inherited-member")
    test_db.add(
        ResourceMember.create(
            resource_type="Workspace",
            resource_id=roster_project.workspace_id,
            entity_id=str(target.id),
            role="Viewer",
            status="approved",
        )
    )
    test_db.commit()
    _update(
        test_db,
        roster_project,
        test_user,
        member_changes=[
            {"operation": "add", "user_id": target.id, "permission_role": "Developer"},
        ],
    )

    receipt = _update(
        test_db,
        roster_project,
        test_user,
        member_changes=[
            {"operation": "remove_direct", "user_id": target.id},
        ],
    )

    member = next(
        value for value in receipt["after"]["members"] if value["user_id"] == target.id
    )
    assert member["permission_role"] == member["inherited_role"] == "Viewer"
    assert member["direct_role"] is None


def test_self_removal_returns_audit_receipt_and_revokes_subsequent_read(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    actor = _user(test_db, "departing-maintainer")
    _update(
        test_db,
        roster_project,
        test_user,
        member_changes=[
            {"operation": "add", "user_id": actor.id, "permission_role": "Maintainer"},
        ],
    )

    receipt = _update(
        test_db,
        roster_project,
        actor,
        member_changes=[
            {"operation": "remove_direct", "user_id": actor.id},
        ],
    )

    assert receipt["auditId"]
    assert not any(
        member["user_id"] == actor.id for member in receipt["after"]["members"]
    )
    with pytest.raises(HTTPException) as failure:
        _configuration(test_db, roster_project, actor)
    assert failure.value.status_code == 404


@pytest.mark.parametrize("actor_first", [True, False])
@pytest.mark.parametrize("actor_operation", ["remove_direct", "update"])
def test_actor_access_change_is_independent_of_member_batch_order(
    test_db: Session,
    test_user: User,
    roster_project: CloudProject,
    actor_first: bool,
    actor_operation: str,
) -> None:
    actor = _user(test_db, "batch-maintainer")
    target = _user(test_db, "batch-member")
    _update(
        test_db,
        roster_project,
        test_user,
        member_changes=[
            {
                "operation": "add",
                "user_id": actor.id,
                "permission_role": "Maintainer",
            }
        ],
    )
    actor_change = {"operation": actor_operation, "user_id": actor.id}
    if actor_operation == "update":
        actor_change["permission_role"] = "Viewer"
    other_change = {
        "operation": "add",
        "user_id": target.id,
        "permission_role": "Developer",
        "capability_description": "QA",
    }
    changes = (
        [actor_change, other_change] if actor_first else [other_change, actor_change]
    )
    version = roster_project.version

    receipt = _update(test_db, roster_project, actor, member_changes=changes)

    assert receipt["projectVersion"] == version + 1
    assert receipt["auditId"]
    members = {member["user_id"]: member for member in receipt["after"]["members"]}
    assert members[target.id]["permission_role"] == "Developer"
    assert members[target.id]["capability_description"] == "QA"
    if actor_operation == "update":
        assert members[actor.id]["permission_role"] == "Viewer"
    else:
        assert actor.id not in members


@pytest.mark.parametrize("dry_run", [True, False])
@pytest.mark.parametrize("actor_operation", ["remove_direct", "update"])
def test_actor_access_change_and_assistant_update_share_one_atomic_preview_or_write(
    test_db: Session,
    test_user: User,
    roster_project: CloudProject,
    dry_run: bool,
    actor_operation: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor = _user(test_db, "mixed-batch-maintainer")
    _update(
        test_db,
        roster_project,
        test_user,
        member_changes=[
            {
                "operation": "add",
                "user_id": actor.id,
                "permission_role": "Maintainer",
            }
        ],
    )
    agent = _agent(test_db, roster_project, actor)
    actor_change = {"operation": actor_operation, "user_id": actor.id}
    if actor_operation == "update":
        actor_change["permission_role"] = "Viewer"
    before = deepcopy(roster_project.metadata_json)
    agent_metadata = deepcopy(agent.metadata_json)
    project_version, agent_version = roster_project.version, agent.version
    cancellations = []
    monkeypatch.setattr(
        "app.services.loop_item_executions.cancellation.request_execution_cancellations",
        lambda pending: cancellations.append(pending),
    )

    receipt = _update(
        test_db,
        roster_project,
        actor,
        dry_run=dry_run,
        member_changes=[actor_change],
        assistant_roster_changes=[
            {
                "agent_id": agent.id,
                "agent_version": agent_version,
                "capability_description": "QA",
            }
        ],
    )

    assert receipt["after"]["assistant_roster"][0]["capability_description"] == "QA"
    assert {change["path"] for change in receipt["diff"]} >= {
        "members",
        "assistant_roster",
    }
    test_db.refresh(agent)
    for key, value in agent_metadata.items():
        if key != "workspace_binding":
            assert agent.metadata_json[key] == value
    assert agent.description == ("Development" if dry_run else "QA")
    assert agent.version == agent_version + (0 if dry_run else 1)
    assert roster_project.version == project_version + (0 if dry_run else 1)
    if dry_run:
        assert receipt["auditId"] is None
        assert agent.metadata_json == agent_metadata
        assert roster_project.metadata_json == before
        assert cancellations == []
        members = _configuration(test_db, roster_project, actor)["members"]
        assert (
            next(member for member in members if member["user_id"] == actor.id)[
                "permission_role"
            ]
            == "Maintainer"
        )
    else:
        assert receipt["auditId"]
        assert len(cancellations) == 1
        assert (
            len(roster_project.metadata_json["project_admin_operations"])
            == len(before["project_admin_operations"]) + 1
        )


def test_assistant_preview_preserves_private_content_and_agent_version(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    agent = _agent(test_db, roster_project, test_user)
    version = agent.version
    before = deepcopy(agent.metadata_json)

    receipt = _update(
        test_db,
        roster_project,
        test_user,
        dry_run=True,
        assistant_roster_changes=[
            {
                "agent_id": agent.id,
                "agent_version": version,
                "status": "archived",
                "capability_description": "QA",
            }
        ],
    )

    assert receipt["after"]["assistant_roster"][0]["status"] == "archived"
    test_db.refresh(agent)
    assert agent.status == "active"
    assert agent.version == version
    assert agent.metadata_json == before
    assert "private prompt" not in str(receipt)
    assert "private token" not in str(receipt)
    assert "project_admin_operations" not in roster_project.metadata_json


def test_assistant_roster_reuses_source_owner_and_destination_binding_checks(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    creator = _user(test_db, "assistant-creator")
    agent = _agent(test_db, roster_project, creator)

    with pytest.raises(HTTPException) as failure:
        _update(
            test_db,
            roster_project,
            test_user,
            assistant_roster_changes=[
                {
                    "agent_id": agent.id,
                    "agent_version": agent.version,
                    "default_runtime_profile_id": "unowned-profile",
                }
            ],
        )
    assert failure.value.status_code == 404
    assert failure.value.detail == "Runtime profile not found"
    assert agent.version == 1

    with pytest.raises(HTTPException) as failure:
        _update(
            test_db,
            roster_project,
            test_user,
            assistant_roster_changes=[
                {
                    "agent_id": agent.id,
                    "agent_version": agent.version,
                    "execution_device_id": "unshared-device",
                }
            ],
        )
    assert failure.value.status_code == 422
    assert (
        failure.value.detail
        == "Execution environment is not configured in this Project"
    )
    assert agent.device_id is None
    assert agent.version == 1
    assert "project_admin_operations" not in roster_project.metadata_json


def test_private_assistant_is_hidden_and_cannot_be_changed_by_project_maintainer(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    creator = _user(test_db, "private-creator")
    agent = _agent(test_db, roster_project, creator, visibility="private")

    assert _configuration(test_db, roster_project, test_user)["assistant_roster"] == []
    with pytest.raises(HTTPException) as failure:
        _update(
            test_db,
            roster_project,
            test_user,
            assistant_roster_changes=[
                {
                    "agent_id": agent.id,
                    "agent_version": agent.version,
                    "status": "archived",
                }
            ],
        )
    assert failure.value.status_code == 403
    assert agent.status == "active"


def test_assistant_version_conflict_rolls_back_member_and_config_changes(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    agent = _agent(test_db, roster_project, test_user)
    target = _user(test_db, "mixed-atomic-member")
    before = deepcopy(roster_project.metadata_json)

    with pytest.raises(HTTPException) as failure:
        _update(
            test_db,
            roster_project,
            test_user,
            name="Rejected",
            member_changes=[
                {
                    "operation": "add",
                    "user_id": target.id,
                    "permission_role": "Developer",
                }
            ],
            assistant_roster_changes=[
                {
                    "agent_id": agent.id,
                    "agent_version": agent.version + 1,
                    "capability_description": "QA",
                }
            ],
        )

    assert failure.value.status_code == 409
    assert isinstance(failure.value.detail, dict)
    assert failure.value.detail["reason_code"] == "version_conflict"
    assert roster_project.name == "Project roster"
    assert roster_project.metadata_json == before
    assert not any(
        value["user_id"] == target.id
        for value in _configuration(test_db, roster_project, test_user)["members"]
    )


def test_archived_assistants_follow_existing_maintainer_visibility_rule(
    test_db: Session, test_user: User, roster_project: CloudProject
) -> None:
    viewer = _user(test_db, "roster-viewer")
    agent = _agent(test_db, roster_project, test_user)
    _update(
        test_db,
        roster_project,
        test_user,
        member_changes=[
            {"operation": "add", "user_id": viewer.id, "permission_role": "Viewer"}
        ],
        assistant_roster_changes=[
            {"agent_id": agent.id, "agent_version": agent.version, "status": "archived"}
        ],
    )

    assert _configuration(test_db, roster_project, viewer)["assistant_roster"] == []
    assert (
        _configuration(test_db, roster_project, test_user)["assistant_roster"][0][
            "status"
        ]
        == "archived"
    )


@pytest.mark.parametrize(
    "changes",
    [
        [{"operation": "add", "user_id": 1}],
        [{"operation": "update", "user_id": 1}],
        [{"operation": "remove_direct", "user_id": 1, "permission_role": "Viewer"}],
        [{"operation": "add", "user_id": 1, "permission_role": "Owner"}],
        [{"operation": "add", "user_id": 1, "permission_role": "Viewer"}] * 2,
    ],
)
def test_roster_schema_rejects_ambiguous_or_unsupported_member_mutations(
    changes,
) -> None:
    with pytest.raises(ValidationError):
        CloudProjectUpdate(version=1, member_changes=changes)


@pytest.mark.parametrize(
    "private_field", ["system_prompt", "memory", "mcp_servers", "token", "transcript"]
)
def test_assistant_roster_schema_cannot_expose_private_configuration(
    private_field: str,
) -> None:
    with pytest.raises(ValidationError):
        CloudProjectUpdate(
            version=1,
            assistant_roster_changes=[
                {
                    "agent_id": "assistant",
                    "agent_version": 1,
                    private_field: "private",
                }
            ],
        )
