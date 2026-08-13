# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.task import TaskResource
from app.schemas.team import TeamUpdate
from app.services.adapters.team_kinds import team_kinds_service


def _create_team_kind(db, user_id: int, namespace: str = "default") -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name="dev-team",
        namespace=namespace,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "dev-team", "namespace": namespace},
            "spec": {"members": [], "collaborationModel": "pipeline"},
            "status": {"state": "Available"},
        },
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def _create_team_task(
    db,
    *,
    user_id: int,
    team_name: str,
    team_namespace: str,
    team_owner_id: int | None,
) -> TaskResource:
    now = datetime.now().isoformat()
    team_ref = {"name": team_name, "namespace": team_namespace}
    if team_owner_id is not None:
        team_ref["user_id"] = team_owner_id
    task = TaskResource(
        user_id=user_id,
        kind="Task",
        name=f"task-{user_id}-{team_owner_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {
                "name": f"task-{user_id}-{team_owner_id}",
                "namespace": "default",
            },
            "spec": {
                "title": "Task",
                "prompt": "Prompt",
                "teamRef": team_ref,
                "workspaceRef": {"name": "workspace", "namespace": "default"},
            },
            "status": {
                "status": "PENDING",
                "progress": 0,
                "createdAt": now,
                "updatedAt": now,
            },
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    db.add(task)
    db.flush()
    return task


def test_update_team_persists_display_name_in_metadata(test_db, test_user):
    team = _create_team_kind(test_db, test_user.id)

    result = team_kinds_service.update_with_user(
        test_db,
        team_id=team.id,
        obj_in=TeamUpdate(displayName="Spec Dev Team"),
        user_id=test_user.id,
    )

    test_db.refresh(team)
    assert result["displayName"] == "Spec Dev Team"
    assert team.json["metadata"]["displayName"] == "Spec Dev Team"


def test_update_team_persists_quick_phrases_in_spec(test_db, test_user):
    team = _create_team_kind(test_db, test_user.id)

    result = team_kinds_service.update_with_user(
        test_db,
        team_id=team.id,
        obj_in=TeamUpdate(
            quick_phrases=["  帮我创建一个 xxx 的 PPT  ", "", "把这份大纲整理成 PPT"]
        ),
        user_id=test_user.id,
    )

    test_db.refresh(team)
    assert result["quick_phrases"] == [
        "帮我创建一个 xxx 的 PPT",
        "把这份大纲整理成 PPT",
    ]
    assert team.json["spec"]["quick_phrases"] == [
        "帮我创建一个 xxx 的 PPT",
        "把这份大纲整理成 PPT",
    ]


def test_team_rename_requires_confirmation_and_leaves_task_reference_unchanged(
    test_db, test_user
):
    team = _create_team_kind(test_db, test_user.id)
    task = _create_team_task(
        test_db,
        user_id=test_user.id,
        team_name=team.name,
        team_namespace=team.namespace,
        team_owner_id=test_user.id,
    )
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        team_kinds_service.update_with_user(
            test_db,
            team_id=team.id,
            obj_in=TeamUpdate(name="renamed-agent"),
            user_id=test_user.id,
        )

    assert exc_info.value.status_code == 409

    result = team_kinds_service.update_with_user(
        test_db,
        team_id=team.id,
        obj_in=TeamUpdate(name="renamed-agent"),
        user_id=test_user.id,
        force_identity_change=True,
        confirm_name=team.name,
    )

    test_db.refresh(task)
    assert result["name"] == "renamed-agent"
    assert task.json["spec"]["teamRef"]["name"] == "dev-team"


def test_update_team_moves_owned_group_agent_to_personal_scope(test_db, test_user):
    namespace = Namespace(
        name="engineering",
        display_name="Engineering",
        owner_user_id=test_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=namespace.id,
            entity_type="user",
            entity_id=str(test_user.id),
            user_id=test_user.id,
            role="Owner",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=test_user.id,
            reviewed_by_user_id=test_user.id,
        )
    )
    test_db.commit()
    team = _create_team_kind(test_db, test_user.id, namespace="engineering")

    result = team_kinds_service.update_with_user(
        test_db,
        team_id=team.id,
        obj_in=TeamUpdate(namespace="default"),
        user_id=test_user.id,
        force_identity_change=True,
        confirm_name=team.name,
    )

    test_db.refresh(team)
    assert result["namespace"] == "default"
    assert team.namespace == "default"
    assert team.json["metadata"]["namespace"] == "default"
