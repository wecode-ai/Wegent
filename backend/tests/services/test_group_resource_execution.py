"""Live Group comment and Crew execution retain their selected resource owner."""

import pytest
from fastapi import HTTPException

from app.models.delivery import ThreadProjectLink
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.schemas.project_chat import ProjectChatCommentExecution
from app.schemas.workspace import CollaborationGroupCreate, CollaborationGroupMember
from app.services.collaboration_revocation import execution_authorized
from app.services.issue_resource_context import (
    require_assignment_agent,
    require_assignment_group,
)
from app.services.loop_item_executions.service import (
    _execution_is_claimable_by_device,
    loop_item_execution_service,
)
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.comment_execution import _comment_agent
from app.services.thread_participation import join_thread
from app.services.thread_project_links import create_thread_classification
from app.services.workspaces import workspace_service
from tests.services.test_chat_group_crews import draft
from tests.services.test_group_agent_resources import inline, project_agent
from tests.services.test_loop_item_executions import _ensure_device
from tests.services.test_thread_participation import make_group, make_thread, person
from tests.utils.collaboration import authorize_resource


def test_current_resource_read_preserves_pending_policy(test_db, test_user):
    group = make_group(test_db, test_user, [])
    item = make_thread(test_db, group, test_user)
    project, agent = project_agent(test_db, test_user)
    create_thread_classification(test_db, item, project)
    agent.metadata_json = {
        **agent.metadata_json,
        "execution_policy": {"mode": "project_pool"},
    }
    actual = require_assignment_agent(
        test_db,
        container_id=group.id,
        agent_id=agent.id,
        user_id=test_user.id,
        item=item,
        execute=True,
    )
    assert actual.metadata_json["execution_policy"] == {"mode": "project_pool"}


@pytest.mark.parametrize("reuse_project", [False, True])
def test_real_runtime_intent_keeps_group_owner_and_resource_workspace(
    test_db, test_user, reuse_project
):
    group = make_group(test_db, test_user, [])
    if reuse_project:
        source, agent = project_agent(test_db, test_user)
        source.metadata_json = {
            **source.metadata_json,
            "execution_environment": {
                "workspace_policy": "project",
                "repositories": [
                    {
                        "name": "source",
                        "url": "https://example.com/source.git",
                        "path": "source",
                        "primary": True,
                    }
                ],
            },
        }
    else:
        source, agent = group, inline(test_db, test_user, group)
    agent.metadata_json = {**agent.metadata_json, "workspace_policy": "project"}
    test_db.flush()
    item = loop_item_service.create(
        test_db,
        cloud_project_id=group.id,
        user_id=test_user.id,
        values=LoopItemCreate(
            title="Actual Group execution",
            assignee_agent_id=agent.id,
            classification_project_id=source.id if reuse_project else None,
        ),
    )
    execution = test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).one()
    request = loop_item_execution_service._persist_runtime_request_intent(
        test_db, execution=execution
    )
    assert request.cloud_project_id == group.id
    assert request.origin["cloudProjectId"] == group.id
    assert request.origin["loopItemId"] == item.id
    assert request.origin["workspacePolicy"] == "project"
    if reuse_project:
        assert (
            request.execution["environment"]["environmentId"] == f"project-{source.id}"
        )
        assert (
            request.execution["environment"]["repositories"][0]["url"]
            == "https://example.com/source.git"
        )
    else:
        assert request.origin["executionEnvironment"]["repositories"] == []
        assert request.standalone_chat_workspace is True


@pytest.mark.parametrize("reuse_project", [False, True])
def test_device_claim_uses_resource_owner_and_rechecks_its_grant(
    test_db, test_user, reuse_project
):
    group = make_group(test_db, test_user, [])
    item = make_thread(test_db, group, test_user)
    if reuse_project:
        source, agent = project_agent(test_db, test_user)
        create_thread_classification(test_db, item, source)
    else:
        source, agent = group, inline(test_db, test_user, group)
    device = _ensure_device(test_db, test_user, "actual-group-runner", "local")
    if reuse_project:
        authorize_resource(test_db, source, device)
        scope = "project"
    else:
        scope = "chat_group"
        test_db.add(
            ResourceMember(
                resource_type="Device",
                resource_id=device.id,
                entity_type=scope,
                entity_id=group.id,
                status="approved",
                role="Developer",
            )
        )
    agent.device_id = device.name
    agent.metadata_json = {**agent.metadata_json, "model": "test-model"}
    test_db.flush()
    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=group.id,
        agent=agent,
        assigner_user_id=test_user.id,
        environment="local",
        execution_device_id=device.name,
        priority=None,
    )
    values = dict(
        execution=execution,
        owner_user_id=test_user.id,
        submitted_device_id=device.name,
    )
    assert _execution_is_claimable_by_device(test_db, **values) is True
    test_db.query(ResourceMember).filter_by(
        resource_type="Device",
        resource_id=device.id,
        entity_type=scope,
        entity_id=source.id,
    ).one().status = "rejected"
    test_db.flush()
    assert _execution_is_claimable_by_device(test_db, **values) is False
    assert execution.cloud_project_id == group.id


@pytest.mark.parametrize("reuse_project", [False, True])
def test_comment_agent_uses_current_source_and_rejects_unlink(
    test_db, test_user, reuse_project
):
    group = make_group(test_db, test_user, [])
    item = make_thread(test_db, group, test_user)
    if reuse_project:
        source, agent = project_agent(test_db, test_user)
        create_thread_classification(test_db, item, source)
    else:
        source, agent = group, inline(test_db, test_user, group)
    request = ProjectChatCommentExecution(
        project_id=group.id, task_id=item.id, trigger_message_id="saved-comment"
    )
    assert _comment_agent(test_db, request, agent.id, test_user.id) is agent
    assert agent.cloud_project_id == source.id
    assert item.cloud_project_id == group.id
    if reuse_project:
        test_db.query(ThreadProjectLink).filter_by(loop_item_id=item.id).delete()
        test_db.flush()
    else:
        agent.status = "archived"
        test_db.flush()
    with pytest.raises(HTTPException):
        _comment_agent(test_db, request, agent.id, test_user.id)


def test_comment_does_not_reuse_other_actors_private_agent(test_db, test_user):
    observer = person(test_db, "private-comment-observer")
    group = make_group(test_db, test_user, [(observer, "Developer")])
    item = make_thread(test_db, group, test_user, observer)
    agent = inline(test_db, test_user, group, visibility="private")
    item.assignee_agent_id = agent.id
    request = ProjectChatCommentExecution(
        project_id=group.id, task_id=item.id, trigger_message_id="saved-comment"
    )
    with pytest.raises(HTTPException) as denied:
        _comment_agent(test_db, request, agent.id, observer.id)
    assert denied.value.status_code == 403


def test_crew_cannot_delegate_another_creators_private_agent(test_db, test_user):
    other = person(test_db, "crew-consumer")
    group = make_group(test_db, test_user, [(other, "Developer")])
    agent = inline(test_db, test_user, group, visibility="private")
    member = CollaborationGroupMember(kind="agent", id=agent.id)
    crew = workspace_service.create_project_collaboration_group(
        test_db,
        int(group.id),
        test_user.id,
        CollaborationGroupCreate(
            name="Private leader", leader=member, members=[member]
        ),
    )
    with pytest.raises(HTTPException) as denied:
        loop_item_service.create(
            test_db,
            cloud_project_id=group.id,
            user_id=other.id,
            values=LoopItemCreate(
                title="Rejected private delegation",
                assignee_group_id=str(crew["id"]),
                assignee_group_source_id=group.id,
            ),
        )
    assert denied.value.status_code == 403


@pytest.mark.parametrize("revocation", ["role", "crew", "generation"])
def test_real_group_crew_uses_group_human_roster_and_refuses_downgrade(
    test_db, test_user, revocation
):
    human = person(test_db, "crew-human-member")
    group = make_group(test_db, test_user, [(human, "Developer")])
    agent = inline(test_db, test_user, group)
    device = _ensure_device(test_db, test_user, "crew-device", "local")
    test_db.add(
        ResourceMember(
            resource_type="Device",
            resource_id=device.id,
            entity_type="chat_group",
            entity_id=group.id,
            status="approved",
            role="Developer",
        )
    )
    agent.device_id = device.name
    agent.metadata_json = {**agent.metadata_json, "model": "test-model"}
    test_db.flush()
    leader = CollaborationGroupMember(kind="agent", id=agent.id)
    crew = workspace_service.create_project_collaboration_group(
        test_db,
        int(group.id),
        test_user.id,
        CollaborationGroupCreate(
            name="Group roster",
            leader=leader,
            members=[leader, CollaborationGroupMember(kind="human", id=str(human.id))],
        ),
    )
    item = loop_item_service.create(
        test_db,
        cloud_project_id=group.id,
        user_id=test_user.id,
        values=LoopItemCreate(
            title="Real crew dispatch",
            assignee_group_id=str(crew["id"]),
            assignee_group_source_id=group.id,
        ),
    )
    execution = test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).one()
    assert execution.executor_type == "collaboration_group_dispatch"
    assert execution_authorized(test_db, execution) is True
    if revocation == "role":
        test_db.query(ResourceMember).filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group.id),
            entity_type="user",
            entity_id=str(human.id),
        ).one().role = "Viewer"
    elif revocation == "crew":
        item.metadata_json = {
            **item.metadata_json,
            "collaboration_group": {
                **item.metadata_json["collaboration_group"],
                "id": "different-current-crew",
            },
        }
    else:
        item.metadata_json = {
            **item.metadata_json,
            "collaboration_group_assignment_key": "reassigned-same-crew",
        }
    test_db.flush()
    assert execution_authorized(test_db, execution) is False


def test_generic_run_also_requires_current_thread_participation(test_db, test_user):
    actor = person(test_db, "generic-run-actor")
    group = make_group(test_db, test_user, [(actor, "Developer")])
    item = make_thread(test_db, group, test_user)
    execution = LoopItemExecution(
        cloud_project_id=group.id,
        loop_item_id=item.id,
        assigner_user_id=actor.id,
        executor_owner_user_id=actor.id,
        status="queued",
    )
    test_db.add(execution)
    test_db.flush()
    assert execution.executor_type == "generic_robot"
    assert execution_authorized(test_db, execution) is False
    join_thread(test_db, item, actor.id)
    test_db.flush()
    assert execution_authorized(test_db, execution) is True


def test_same_crew_definition_has_two_explicit_enabling_sources(test_db, test_user):
    group = make_group(test_db, test_user, [])
    item = make_thread(test_db, group, test_user)
    project, _ = project_agent(test_db, test_user)
    create_thread_classification(test_db, item, project)
    crew = workspace_service.create_project_collaboration_group(
        test_db, int(project.id), test_user.id, draft(test_user)
    )
    workspace_service.add_project_collaboration_group(
        test_db, int(group.id), crew["id"], test_user.id
    )
    values = dict(
        container_id=group.id,
        group_id=str(crew["id"]),
        user_id=test_user.id,
        item=item,
    )
    with pytest.raises(HTTPException) as ambiguous:
        require_assignment_group(test_db, **values)
    assert ambiguous.value.status_code == 422
    direct = require_assignment_group(test_db, **values, source_id=group.id)
    reused = require_assignment_group(test_db, **values, source_id=project.id)
    assert direct["binding_owner_id"] == group.id
    assert reused["binding_owner_id"] == project.id
    assert direct["owner_type"] == reused["owner_type"] == "project"
    assert str(direct["owner_id"]) == str(reused["owner_id"]) == project.id
    loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(
            version=item.version,
            assignee_group_id=str(crew["id"]),
            assignee_group_source_id=project.id,
            status="inbox",
        ),
    )
    first_key = item.metadata_json["collaboration_group_assignment_key"]
    assert item.metadata_json["collaboration_group"]["binding_owner_id"] == project.id
    loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(
            version=item.version,
            assignee_group_source_id=group.id,
            status="inbox",
        ),
    )
    assert item.metadata_json["collaboration_group"]["binding_owner_id"] == group.id
    assert item.metadata_json["collaboration_group_assignment_key"] != first_key
    assert item.cloud_project_id == group.id
    test_db.query(ResourceMember).filter_by(
        resource_type="CollaborationGroup",
        resource_id=crew["id"],
        entity_type="project",
        entity_id=project.id,
    ).one().status = "rejected"
    test_db.flush()
    with pytest.raises(HTTPException):
        require_assignment_group(test_db, **values, source_id=project.id)
    assert (
        require_assignment_group(test_db, **values, source_id=group.id)[
            "binding_owner_id"
        ]
        == group.id
    )
