# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.share import MemberRole
from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import task_kinds_service
from app.services.adapters.task_kinds.task_skills_resolver import resolve_task_skills
from app.services.adapters.team_kinds import team_kinds_service
from app.services.chat.task_default_knowledge_bases import (
    build_initial_task_knowledge_base_refs,
    resolve_task_default_knowledge_base_ids,
)
from app.services.external_entity_resolver import register_entity_resolver
from app.services.share.namespace_entity_resolver import NamespaceEntityResolver


def _create_user(db: Session, name: str) -> User:
    user = User(
        user_name=name,
        password_hash=get_password_hash(f"{name}-pass"),
        email=f"{name}@example.com",
        is_active=True,
        role="user",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _create_namespace(db: Session, owner: User, name: str) -> Namespace:
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner.id,
        visibility="private",
        description="test namespace",
        level="group",
        is_active=True,
    )
    db.add(namespace)
    db.commit()
    db.refresh(namespace)
    return namespace


def _add_namespace_member(
    db: Session, namespace: Namespace, user: User, role: str = "Reporter"
) -> None:
    db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=namespace.id,
            entity_type="user",
            entity_id=str(user.id),
            role=role,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=namespace.owner_user_id,
            share_link_id=0,
            reviewed_by_user_id=namespace.owner_user_id,
            copied_resource_id=0,
        )
    )
    db.commit()


def _authorize_team_to_namespace(db: Session, team: Kind, namespace: Namespace) -> None:
    db.add(
        ResourceMember(
            resource_type=ResourceType.TEAM.value,
            resource_id=team.id,
            entity_type="namespace",
            entity_id=str(namespace.id),
            role=MemberRole.Reporter.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=team.user_id,
            share_link_id=0,
            reviewed_by_user_id=team.user_id,
            copied_resource_id=0,
        )
    )
    db.commit()


def _create_shell(db: Session) -> Kind:
    shell = Kind(
        user_id=0,
        kind="Shell",
        name="shell",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {"name": "shell", "namespace": "default"},
            "spec": {"shellType": "ClaudeCode", "baseImage": "test-image:latest"},
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(shell)
    db.commit()
    db.refresh(shell)
    return shell


def _create_parent_agent_graph(
    db: Session,
    owner: User,
    parent_namespace: str,
    *,
    skills: list[str] | None = None,
    default_knowledge_base_id: int | None = None,
) -> Kind:
    _create_shell(db)
    ghost_spec = {
        "systemPrompt": "parent prompt",
        "mcpServers": {},
        "skills": skills or [],
    }
    if default_knowledge_base_id is not None:
        ghost_spec["defaultKnowledgeBaseRefs"] = [
            {"id": default_knowledge_base_id, "name": "Parent KB"}
        ]

    ghost = Kind(
        user_id=owner.id,
        kind="Ghost",
        name="parent-ghost",
        namespace=parent_namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "parent-ghost", "namespace": parent_namespace},
            "spec": ghost_spec,
        },
        is_active=True,
    )
    bot = Kind(
        user_id=owner.id,
        kind="Bot",
        name="parent-bot",
        namespace=parent_namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "parent-bot", "namespace": parent_namespace},
            "spec": {
                "ghostRef": {"name": ghost.name, "namespace": ghost.namespace},
                "shellRef": {"name": "shell", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    team = Kind(
        user_id=owner.id,
        kind="Team",
        name="parent-team",
        namespace=parent_namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "parent-team", "namespace": parent_namespace},
            "spec": {
                "members": [
                    {
                        "botRef": {"name": bot.name, "namespace": bot.namespace},
                        "prompt": "",
                        "role": "worker",
                    }
                ],
                "collaborationModel": "coordinate",
                "bind_mode": ["chat"],
                "description": "",
                "icon": "bot",
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add_all([ghost, bot, team])
    db.commit()
    db.refresh(team)
    return team


def _create_parent_knowledge_base(db: Session, owner: User, namespace: str) -> Kind:
    kb = Kind(
        user_id=owner.id,
        kind="KnowledgeBase",
        name="parent-kb",
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {"name": "parent-kb", "namespace": namespace},
            "spec": {"name": "Parent KB", "description": ""},
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(kb)
    db.commit()
    db.refresh(kb)
    return kb


def _arrange_parent_team_authorized_to_child(
    db: Session,
    *,
    skills: list[str] | None = None,
    with_knowledge_base: bool = False,
) -> tuple[User, User, Namespace, Kind, Kind | None]:
    register_entity_resolver("namespace", NamespaceEntityResolver)
    owner = _create_user(db, "parent-agent-owner")
    child_member = _create_user(db, "child-agent-member")
    parent = _create_namespace(db, owner, "agent-parent")
    child = _create_namespace(db, owner, "agent-parent/child")
    _add_namespace_member(db, child, child_member)
    kb = (
        _create_parent_knowledge_base(db, owner, parent.name)
        if with_knowledge_base
        else None
    )
    team = _create_parent_agent_graph(
        db,
        owner,
        parent.name,
        skills=skills,
        default_knowledge_base_id=kb.id if kb else None,
    )
    _authorize_team_to_namespace(db, team, child)
    return owner, child_member, child, team, kb


def test_child_group_team_list_includes_authorized_parent_team(test_db: Session):
    _owner, child_member, child, team, _kb = _arrange_parent_team_authorized_to_child(
        test_db
    )

    teams = team_kinds_service.get_user_teams(
        test_db,
        user_id=child_member.id,
        scope="group",
        group_name=child.name,
    )

    listed_team = next(item for item in teams if item["id"] == team.id)
    assert listed_team["name"] == "parent-team"
    assert listed_team["namespace"] == "agent-parent"
    # share_status=2 means the team is shared from others.
    assert listed_team["share_status"] == 2
    assert listed_team["access_source"] == "namespace_authorization"
    assert team_kinds_service.count_user_teams(
        test_db,
        user_id=child_member.id,
        scope="group",
        group_name=child.name,
    ) == len(teams)


def test_team_list_deduplicates_direct_share_and_namespace_authorization(
    test_db: Session,
):
    _owner, child_member, _child, team, _kb = _arrange_parent_team_authorized_to_child(
        test_db
    )
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.TEAM.value,
            resource_id=team.id,
            entity_type="user",
            entity_id=str(child_member.id),
            role=MemberRole.Reporter.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=team.user_id,
            share_link_id=0,
            reviewed_by_user_id=team.user_id,
            copied_resource_id=0,
        )
    )
    test_db.commit()

    teams = team_kinds_service.get_user_teams(
        test_db,
        user_id=child_member.id,
        scope="all",
    )

    matching_teams = [item for item in teams if item["id"] == team.id]
    assert len(matching_teams) == 1
    assert matching_teams[0]["access_source"] == "user_share"
    assert team_kinds_service.count_user_teams(
        test_db,
        user_id=child_member.id,
        scope="all",
    ) == len(teams)


def test_child_member_can_create_task_with_authorized_parent_team_and_use_skills(
    test_db: Session,
):
    _owner, child_member, _child, team, _kb = _arrange_parent_team_authorized_to_child(
        test_db,
        skills=["parent-skill"],
    )

    result = task_kinds_service.create_task_or_append(
        test_db,
        obj_in=TaskCreate(
            team_id=team.id,
            title="Use authorized parent team",
            prompt="hello",
            task_type="task",
        ),
        user=child_member,
    )

    task = test_db.get(TaskResource, result["id"])
    assert task is not None
    assert task.user_id == child_member.id
    assert task.json["spec"]["teamRef"]["user_id"] == team.user_id
    subtasks = test_db.query(Subtask).filter(Subtask.task_id == task.id).all()
    # Task creation stores the initial user request plus the execution subtask.
    assert len(subtasks) == 2

    resolved = resolve_task_skills(test_db, task_id=task.id, user_id=child_member.id)
    assert resolved["team_id"] == team.id
    assert "parent-skill" in resolved["skills"]


def test_authorized_parent_team_defaults_are_resolved_dynamically(
    test_db: Session,
):
    owner, child_member, _child, team, kb = _arrange_parent_team_authorized_to_child(
        test_db,
        with_knowledge_base=True,
    )
    kb_owner = _create_user(test_db, "parent-kb-owner")
    assert kb is not None
    kb.user_id = kb_owner.id
    test_db.commit()
    parent_namespace = (
        test_db.query(Namespace).filter(Namespace.name == team.namespace).one()
    )
    _add_namespace_member(test_db, parent_namespace, owner, role="Maintainer")

    initial_refs = build_initial_task_knowledge_base_refs(
        db=test_db,
        user=child_member,
        team=team,
    )
    result = task_kinds_service.create_task_or_append(
        test_db,
        obj_in=TaskCreate(
            team_id=team.id,
            title="Use parent knowledge base",
            prompt="hello",
            task_type="task",
        ),
        user=child_member,
    )
    resolved_ids = resolve_task_default_knowledge_base_ids(
        test_db,
        task_id=result["id"],
        user_id=child_member.id,
    )

    assert initial_refs == []
    assert resolved_ids == [kb.id]

    owner_membership = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Namespace",
            ResourceMember.resource_id == parent_namespace.id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(owner.id),
        )
        .one()
    )
    test_db.delete(owner_membership)
    test_db.commit()

    assert (
        resolve_task_default_knowledge_base_ids(
            test_db,
            task_id=result["id"],
            user_id=child_member.id,
        )
        == []
    )
