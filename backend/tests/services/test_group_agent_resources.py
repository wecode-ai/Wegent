"""Group and optional Project resource authority remain independent."""

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, ProjectChatAgent, ThreadProjectLink
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_chat import ProjectChatAgentCreate
from app.services.chat_group_access import GROUP_RESOURCE_TYPE
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.collaboration_revocation import (
    execution_authorized,
    revoke_unauthorized_project_work,
)
from app.services.group_resource_permissions import authorize_group_team
from app.services.issue_resource_context import require_assignment_agent
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import project_chat_service
from app.services.thread_project_links import create_thread_classification
from tests.services.test_thread_participation import make_group, make_thread, person
from tests.utils.collaboration import authorize_project, authorize_project_agent


def inline(db, owner, group, *, visibility="public"):
    view = project_chat_service.create_agent(
        db,
        user_id=owner.id,
        project_id=str(group.id),
        request=ProjectChatAgentCreate(name="Group Agent", visibility=visibility),
    )
    return db.get(ProjectChatAgent, view.id)


def project_agent(db, owner):
    project = CloudProject(
        name="Resource project",
        project_key="RESOURCE",
        created_by_user_id=owner.id,
        metadata_json={"task_provider": "local"},
    )
    authorize_project(db, project)
    agent = ProjectChatAgent(
        cloud_project_id=project.id,
        name="Project Agent",
        title="Project Agent",
        created_by_user_id=owner.id,
        status="active",
        metadata_json={"runtime": "codex"},
    )
    authorize_project_agent(db, agent)
    return project, agent


def test_direct_group_agent_has_explicit_revocable_grant(test_db, test_user):
    group = make_group(test_db, test_user, [])
    agent = inline(test_db, test_user, group)
    assert agent.cloud_project_id == group.id
    assert (
        collaboration_permission_service.require_project_agent(
            test_db, group.id, agent.id, user_id=test_user.id
        )
        is agent
    )
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type=GROUP_RESOURCE_TYPE,
            resource_id=int(group.id),
            entity_type="project_agent",
            entity_id=agent.id,
        )
        .one()
    )
    grant_id = grant.id
    collaboration_permission_service.share_project_agent(
        test_db, group, agent, test_user.id
    )
    assert grant.id == grant_id
    grant.status = "rejected"
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        collaboration_permission_service.require_project_agent(
            test_db, group.id, agent.id
        )
    assert denied.value.status_code == 422


def test_group_member_cannot_install_or_publish_another_private_definition(
    test_db, test_user
):
    member = person(test_db, "group-member")
    group = make_group(test_db, test_user, [(member, "Developer")])
    agent = inline(test_db, test_user, group, visibility="private")
    with pytest.raises(HTTPException) as denied:
        inline(test_db, member, group)
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException) as denied:
        collaboration_permission_service.require_project_agent(
            test_db, group.id, agent.id, user_id=member.id
        )
    assert denied.value.status_code == 403


def test_group_team_needs_source_owner_explicit_authorization(test_db, test_user):
    group = make_group(test_db, test_user, [])
    team = Kind(
        kind="Team",
        name="Source Team",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={},
    )
    test_db.add(team)
    test_db.flush()
    with pytest.raises(HTTPException):
        collaboration_permission_service.require_project_team(
            test_db, group.id, team.id, require_binding=False
        )
    authorize_group_team(test_db, group, test_user.id, team.id)
    assert (
        collaboration_permission_service.require_project_team(
            test_db, group.id, team.id, require_binding=False
        )
        is team
    )


def test_group_admin_does_not_own_another_users_team(test_db, test_user):
    other = person(test_db, "resource-owner")
    group = make_group(test_db, test_user, [])
    team = Kind(
        kind="Team",
        name="Private Team",
        namespace="default",
        user_id=other.id,
        is_active=True,
        json={},
    )
    test_db.add(team)
    test_db.flush()
    with pytest.raises(HTTPException):
        authorize_group_team(test_db, group, test_user.id, team.id)
    assert (
        test_db.query(ResourceMember)
        .filter_by(resource_type="Team", resource_id=team.id, entity_type="chat_group")
        .count()
        == 0
    )


def test_linked_project_agent_keeps_group_work_owner_and_original_binding(
    test_db, test_user
):
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    project, agent = project_agent(test_db, test_user)
    create_thread_classification(test_db, thread, project)
    actual = require_assignment_agent(
        test_db,
        container_id=group.id,
        agent_id=agent.id,
        user_id=test_user.id,
        item=thread,
        execute=True,
    )
    assert actual is agent
    assert actual.cloud_project_id == project.id
    assert thread.cloud_project_id == group.id
    assert test_db.query(ProjectChatAgent).count() == 1


def test_unlinked_project_agent_is_denied_even_to_both_administrators(
    test_db, test_user
):
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    _, agent = project_agent(test_db, test_user)
    with pytest.raises(HTTPException) as denied:
        require_assignment_agent(
            test_db,
            container_id=group.id,
            agent_id=agent.id,
            user_id=test_user.id,
            item=thread,
        )
    assert denied.value.status_code == 422
    assert thread.assignee_agent_id in (None, "")


def test_project_grant_is_independent_of_group_administration(test_db, test_user):
    project_owner = person(test_db, "project-owner")
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    project, agent = project_agent(test_db, project_owner)
    create_thread_classification(test_db, thread, project)
    with pytest.raises(HTTPException):
        require_assignment_agent(
            test_db,
            container_id=group.id,
            agent_id=agent.id,
            user_id=test_user.id,
            item=thread,
        )
    assert thread.cloud_project_id == group.id


def test_unlinking_invalidates_resource_reuse_without_replacing_assignment(
    test_db, test_user
):
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    project, agent = project_agent(test_db, test_user)
    create_thread_classification(test_db, thread, project)
    thread.assignee_agent_id = agent.id
    link = test_db.query(ThreadProjectLink).one()
    link.status = "archived"
    test_db.flush()
    with pytest.raises(HTTPException):
        require_assignment_agent(
            test_db,
            container_id=group.id,
            agent_id=agent.id,
            user_id=test_user.id,
            item=thread,
            execute=True,
        )
    assert thread.assignee_agent_id == agent.id


@pytest.mark.parametrize("joined,role", [(False, "Developer"), (True, "Viewer")])
def test_group_reading_is_not_shared_resource_execution(
    test_db, test_user, joined, role
):
    actor = person(test_db, "observer")
    group = make_group(test_db, test_user, [(actor, role)])
    thread = make_thread(test_db, group, test_user, actor if joined else None)
    agent = inline(test_db, test_user, group)
    with pytest.raises(HTTPException) as denied:
        require_assignment_agent(
            test_db,
            container_id=group.id,
            agent_id=agent.id,
            user_id=actor.id,
            item=thread,
            execute=True,
        )
    assert denied.value.status_code == 403


@pytest.mark.parametrize("reuse_project", [False, True])
def test_real_thread_creation_admits_exact_source_binding_without_rehoming(
    test_db, test_user, reuse_project
):
    group = make_group(test_db, test_user, [])
    if reuse_project:
        project, agent = project_agent(test_db, test_user)
    else:
        project, agent = None, inline(test_db, test_user, group)
    thread = loop_item_service.create(
        test_db,
        cloud_project_id=str(group.id),
        user_id=test_user.id,
        values=LoopItemCreate(
            title="Authorized shared work",
            assignee_agent_id=agent.id,
            classification_project_id=str(project.id) if project else None,
        ),
    )
    execution = test_db.query(LoopItemExecution).filter_by(loop_item_id=thread.id).one()
    assert thread.cloud_project_id == group.id
    assert execution.cloud_project_id == group.id
    assert thread.assignee_agent_id == agent.id
    assert execution.agent_id == agent.id
    assert execution_authorized(test_db, execution) is True
    if project:
        test_db.query(ResourceMember).filter_by(
            resource_type="Workspace",
            resource_id=project.workspace_id,
            entity_type="project_agent",
            entity_id=agent.id,
        ).one().status = "rejected"
    else:
        test_db.query(ResourceMember).filter_by(
            resource_type=GROUP_RESOURCE_TYPE,
            resource_id=int(group.id),
            entity_type="project_agent",
            entity_id=agent.id,
        ).one().status = "rejected"
    test_db.flush()
    assert execution_authorized(test_db, execution) is False
    assert (
        revoke_unauthorized_project_work(test_db, project.id if project else group.id)
        == []
    )
    assert execution.status == "cancelled"
    assert execution.cloud_project_id == group.id
    assert thread.cloud_project_id == group.id
    assert thread.assignee_agent_id == agent.id
