# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Explicit Issue invitations never grant access to the containing project."""

import uuid
from copy import deepcopy

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, LoopItemComment
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.project_chat import LoopItemAssign
from app.services.cloud_projects.access import IssueAction, require_cloud_project_role
from app.services.delivery.service import delivery_service
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items.service import loop_item_service
from tests.api.test_deliveries_api import delivery_project


def test_cp14_parent_and_child_invitations_are_independent(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
) -> None:
    parent = make_issue(test_db, delivery_project, test_user)
    child = make_issue(test_db, delivery_project, test_user)
    child.parent_id = parent.id
    test_db.commit()
    loop_item_service.add_collaborator(test_db, parent.id, outsider.id, test_user.id)
    with pytest.raises(HTTPException) as hidden_child:
        loop_item_service.get(test_db, child.id, outsider.id)
    assert hidden_child.value.status_code == 404
    loop_item_service.add_collaborator(test_db, child.id, outsider.id, test_user.id)
    loop_item_service.remove_collaborator(test_db, parent.id, outsider.id, test_user.id)
    with pytest.raises(HTTPException) as hidden_parent:
        loop_item_service.get(test_db, parent.id, outsider.id)
    assert hidden_parent.value.status_code == 404
    assert loop_item_service.get(test_db, child.id, outsider.id).id == child.id
    loop_item_service.remove_collaborator(test_db, child.id, outsider.id, test_user.id)
    with pytest.raises(HTTPException) as revoked_child:
        loop_item_service.get(test_db, child.id, outsider.id)
    assert revoked_child.value.status_code == 404


@pytest.fixture
def outsider(test_db: Session) -> User:
    user = User(
        user_name=f"invite-{uuid.uuid4().hex}", password_hash="unused", is_active=True
    )
    test_db.add(user)
    test_db.commit()
    return user


def make_issue(db: Session, project: CloudProject, owner: User) -> LoopItem:
    item = LoopItem(
        cloud_project_id=project.id,
        title="Private Issue",
        description="Private content",
        created_by_user_id=owner.id,
        updated_by_user_id=owner.id,
        metadata_json={"security_level": "related"},
    )
    db.add(item)
    db.commit()
    return item


@pytest.mark.parametrize("invitation", ["participant", "assignee"])
def test_cp14_current_invitation_is_issue_scoped_and_revocable(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
    invitation: str,
) -> None:
    item = make_issue(test_db, delivery_project, test_user)
    sibling = make_issue(test_db, delivery_project, test_user)
    with pytest.raises(HTTPException) as denied:
        loop_item_service.get(test_db, item.id, outsider.id)
    assert denied.value.status_code == 404
    if invitation == "participant":
        loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    else:
        item.assignee_user_id = outsider.id
        test_db.commit()
    assert loop_item_service.get(test_db, item.id, outsider.id).id == item.id
    assert delivery_service.list_deliveries(test_db, item.id, outsider.id) == []
    response = loop_item_service.response_values(test_db, item, outsider.id)
    assert (
        response["can_view_detail"]
        and response["can_edit"]
        and response["invited_only"]
    )
    loop_item_service._require_item_access(
        test_db, item, outsider.id, action=IssueAction.ASSIGN
    )
    loop_item_service.add_comment(
        test_db, item.id, outsider.id, "Invited participant reply"
    )
    for read in [
        lambda: require_cloud_project_role(test_db, delivery_project.id, outsider.id),
        lambda: loop_item_service.get(test_db, sibling.id, outsider.id),
        lambda: loop_item_service._require_item_access(
            test_db, item, outsider.id, action=IssueAction.EXECUTE
        ),
    ]:
        with pytest.raises(HTTPException) as denied:
            read()
        assert denied.value.status_code in {403, 404}
    if invitation == "participant":
        loop_item_service.remove_collaborator(
            test_db, item.id, outsider.id, test_user.id
        )
    else:
        item.assignee_user_id = None
        test_db.commit()
    with pytest.raises(HTTPException) as denied:
        loop_item_service.get(test_db, item.id, outsider.id)
    assert denied.value.status_code == 404


def test_inactive_recipient_cannot_be_invited(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
) -> None:
    item = make_issue(test_db, delivery_project, test_user)
    outsider.is_active = False
    test_db.commit()
    with pytest.raises(HTTPException) as denied:
        loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    assert denied.value.status_code == 422
    assert loop_item_service.list_collaborators(test_db, item.id, test_user.id) == []


@pytest.mark.parametrize("invitation", ["participant", "assignee"])
def test_cp14_invitation_cannot_replace_required_stage_membership(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
    invitation: str,
) -> None:
    item = make_issue(test_db, delivery_project, test_user)
    if invitation == "participant":
        loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    else:
        item.assignee_user_id = outsider.id
    item.metadata_json = {
        **item.metadata_json,
        "workflow": {
            "current_stage_id": "build",
            "nodes": [
                {
                    "id": "build",
                    "name": "Build",
                    "required_assignee_type": "user",
                    "required_assignee_id": str(outsider.id),
                }
            ],
        },
    }
    test_db.commit()
    assert loop_item_service.get(test_db, item.id, outsider.id).id == item.id
    before = (item.version, item.assignee_user_id, deepcopy(item.metadata_json))
    comments = test_db.query(LoopItemComment).count()

    with pytest.raises(HTTPException) as denied:
        loop_item_service.assign(
            test_db,
            project_id=int(delivery_project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="user",
                assignee_id=str(outsider.id),
                notify_assignee=False,
            ),
        )

    assert denied.value.status_code == 422
    assert denied.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert denied.value.detail["reason"] == "Required assignee lost project access"
    assert (item.version, item.assignee_user_id, item.metadata_json) == before
    assert test_db.query(LoopItemComment).count() == comments
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0


def test_cp14_invitee_can_remove_unconstrained_assignment(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
) -> None:
    item = make_issue(test_db, delivery_project, test_user)
    loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    loop_item_service.assign(
        test_db,
        project_id=int(delivery_project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(outsider.id),
            notify_assignee=False,
        ),
    )
    assert item.assignee_user_id == outsider.id
    assignment = issue_assignment_service.active_for_issue(test_db, item.id)[0]
    version = item.version

    removed = issue_assignment_service.remove_and_project(
        test_db,
        project_id=int(delivery_project.id),
        issue_id=item.id,
        assignment_id=assignment.id,
        user_id=outsider.id,
    )

    assert removed.id == assignment.id
    assert item.assignee_user_id is None
    assert item.version == version + 1
    assert issue_assignment_service.active_for_issue(test_db, item.id) == []
    assert loop_item_service.get(test_db, item.id, outsider.id).id == item.id
    with pytest.raises(HTTPException) as denied:
        require_cloud_project_role(test_db, delivery_project.id, outsider.id)
    assert denied.value.status_code == 404


def test_cp14_revoked_invitee_cannot_remove_assignment(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
) -> None:
    item = make_issue(test_db, delivery_project, test_user)
    loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    loop_item_service.assign(
        test_db,
        project_id=int(delivery_project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(test_user.id),
            notify_assignee=False,
        ),
    )
    assignment = issue_assignment_service.active_for_issue(test_db, item.id)[0]
    loop_item_service.remove_collaborator(test_db, item.id, outsider.id, test_user.id)
    before = (
        item.version,
        item.assignee_user_id,
        test_db.query(LoopItemComment).count(),
    )

    with pytest.raises(HTTPException) as denied:
        issue_assignment_service.remove_and_project(
            test_db,
            project_id=int(delivery_project.id),
            issue_id=item.id,
            assignment_id=assignment.id,
            user_id=outsider.id,
        )

    assert denied.value.status_code == 404
    assert (
        item.version,
        item.assignee_user_id,
        test_db.query(LoopItemComment).count(),
    ) == before
    assert [
        event.id
        for event in issue_assignment_service.active_for_issue(test_db, item.id)
    ] == [assignment.id]


def test_cp14_invitee_can_manage_people_but_not_project_execution(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
) -> None:
    from app.schemas.delivery import LoopItemUpdate
    from app.schemas.project_chat import LoopItemAssign

    item = make_issue(test_db, delivery_project, test_user)
    sibling = make_issue(test_db, delivery_project, test_user)
    loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    updated = loop_item_service.update(
        test_db,
        item.id,
        outsider.id,
        LoopItemUpdate(version=item.version, title="Managed by invitee"),
    )
    assert updated.title == "Managed by invitee"
    loop_item_service.add_collaborator(test_db, item.id, test_user.id, outsider.id)
    assigned = loop_item_service.assign(
        test_db,
        project_id=int(delivery_project.id),
        item_id=item.id,
        user_id=outsider.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(test_user.id),
            notify_assignee=False,
        ),
    )
    assert assigned.assignee_user_id == test_user.id
    access = loop_item_service._require_item_access(test_db, item, outsider.id)
    from app.services.loop_items.access import can_view_item

    assert not can_view_item(test_db, access, sibling, outsider.id)
    with pytest.raises(HTTPException) as denied:
        loop_item_service.assign(
            test_db,
            project_id=int(delivery_project.id),
            item_id=item.id,
            user_id=outsider.id,
            values=LoopItemAssign(
                version=item.version, assignee_type="agent", assignee_id="robot"
            ),
        )
    assert denied.value.status_code == 403


def test_external_provider_does_not_receive_native_issue_invitations(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
) -> None:
    item = make_issue(test_db, delivery_project, test_user)
    delivery_project.metadata_json = {"task_provider": "github"}
    test_db.commit()
    with pytest.raises(HTTPException) as denied:
        loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    assert denied.value.status_code == 404
    assert loop_item_service.list_collaborators(test_db, item.id, test_user.id) == []


def test_cp14_removing_participant_retains_current_assignee_access(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
) -> None:
    item = make_issue(test_db, delivery_project, test_user)
    item.assignee_user_id = outsider.id
    test_db.commit()
    loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)

    loop_item_service.remove_collaborator(test_db, item.id, outsider.id, test_user.id)

    assert loop_item_service.list_collaborators(test_db, item.id, test_user.id) == []
    assert loop_item_service.get(test_db, item.id, outsider.id).id == item.id
    item.assignee_user_id = None
    test_db.commit()
    with pytest.raises(HTTPException) as denied:
        loop_item_service.get(test_db, item.id, outsider.id)
    assert denied.value.status_code == 404


@pytest.mark.parametrize("explicit_viewer", [False, True])
def test_cp07_cp14_invitation_grants_public_and_explicit_viewers_issue_management(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
    explicit_viewer: bool,
) -> None:
    from app.schemas.base_role import BaseRole
    from app.schemas.cloud_project import CloudProjectMemberCreate, CloudProjectUpdate
    from app.schemas.delivery import LoopItemUpdate
    from app.schemas.project_chat import LoopItemAssign
    from app.services.cloud_projects.service import cloud_project_service
    from app.services.project_chat.service import project_chat_service

    project = cloud_project_service.update(
        test_db,
        int(delivery_project.id),
        test_user.id,
        CloudProjectUpdate(version=delivery_project.version, visibility="public"),
    )
    if explicit_viewer:
        cloud_project_service.add_member(
            test_db,
            int(project.id),
            test_user.id,
            CloudProjectMemberCreate(user_id=outsider.id, role=BaseRole.Viewer),
        )
    item = make_issue(test_db, project, test_user)
    loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    response = loop_item_service.response_values(test_db, item, outsider.id)
    assert response["can_edit"] is True
    assert response["invited_only"] is True
    updated = loop_item_service.update(
        test_db,
        item.id,
        outsider.id,
        LoopItemUpdate(
            version=item.version, title="Public reader manages only this Issue"
        ),
    )
    assert updated.title == "Public reader manages only this Issue"
    assert (
        project_chat_service._require_scope(
            test_db,
            user_id=outsider.id,
            project_id=project.id,
            task_id=item.id,
            required_role=BaseRole.Developer,
        ).id
        == project.id
    )
    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(outsider.id),
            notify_assignee=False,
        ),
    )
    assert assigned.assignee_user_id == outsider.id
    public_access = require_cloud_project_role(test_db, project.id, outsider.id)
    assert public_access.role == BaseRole.Viewer
    assert public_access.sources == (
        {"type": "direct" if explicit_viewer else "public", "role": "Viewer"},
    )
    members = cloud_project_service.list_members(test_db, int(project.id), test_user.id)
    assert (outsider.id in {member["user_id"] for member in members}) is explicit_viewer
    with pytest.raises(HTTPException) as denied:
        loop_item_service._require_item_access(
            test_db, item, outsider.id, action=IssueAction.EXECUTE
        )
    assert denied.value.status_code == 403


@pytest.mark.parametrize(
    "revocation", ["project", "workspace", "parent", "ambiguous_parent"]
)
def test_cp05_issue_invitation_requires_an_active_unambiguous_container(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
    revocation: str,
) -> None:
    from app.models.kind import Kind
    from app.models.resource_member import ResourceMember

    item = make_issue(test_db, delivery_project, test_user)
    loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    workspace_id = delivery_project.workspace_id
    if revocation == "project":
        test_db.query(CloudProject).filter(
            CloudProject.id == delivery_project.id
        ).update({"status": "archived"}, synchronize_session=False)
    elif revocation == "workspace":
        test_db.query(Kind).filter(Kind.id == workspace_id).update(
            {"is_active": False}, synchronize_session=False
        )
    elif revocation == "parent":
        test_db.query(ResourceMember).filter_by(
            resource_type="CloudProject",
            resource_id=int(delivery_project.id),
            entity_type="workspace",
        ).delete(synchronize_session=False)
    else:
        test_db.add(
            ResourceMember(
                resource_type="CloudProject",
                resource_id=int(delivery_project.id),
                entity_type="workspace",
                entity_id="999999",
                role="Owner",
                status="approved",
                user_id=0,
            )
        )
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        loop_item_service.get(test_db, item.id, outsider.id)
    assert denied.value.status_code == 404


def test_cp14_invitee_cannot_archive_active_runs_before_any_mutation(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
) -> None:
    from app.models.delivery import loop_datetime_value_is_unset
    from app.models.loop_item_execution import LoopItemExecution

    item = make_issue(test_db, delivery_project, test_user)
    loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=delivery_project.id,
        assigner_user_id=test_user.id,
        executor_owner_user_id=test_user.id,
        status="running",
        execution_environment="local",
    )
    test_db.add(execution)
    test_db.commit()
    before_version = item.version
    with pytest.raises(HTTPException) as denied:
        loop_item_service.delete(test_db, item.id, outsider.id)
    assert denied.value.status_code == 403
    assert loop_datetime_value_is_unset(item.deleted_at)
    assert item.version == before_version
    assert execution.status == "running"


@pytest.mark.parametrize("operation", ["start", "fail", "assigned_comment"])
def test_cp14_invitee_cannot_start_or_change_agent_execution(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    outsider: User,
    operation: str,
) -> None:
    from app.models.loop_item_execution import LoopItemExecution
    from app.models.project_chat_message import ProjectChatMessage
    from app.schemas.project_chat import (
        ProjectChatAgentFailure,
        ProjectChatAgentStart,
        ProjectChatCommentExecution,
    )
    from app.services.project_chat.comment_execution import _new_execution
    from app.services.project_chat.service import project_chat_service

    item = make_issue(test_db, delivery_project, test_user)
    loop_item_service.add_collaborator(test_db, item.id, outsider.id, test_user.id)
    item.assignee_agent_id = "assigned-agent"
    test_db.commit()
    with pytest.raises(HTTPException) as denied:
        if operation == "start":
            project_chat_service.start_agent_response(
                test_db,
                user_id=outsider.id,
                request=ProjectChatAgentStart(
                    project_id=delivery_project.id,
                    task_id=item.id,
                    agent_id="assigned-agent",
                    runtime_device_id="foreign-device",
                    runtime_task_id="foreign-task",
                ),
            )
        elif operation == "fail":
            project_chat_service.fail_agent_response(
                test_db,
                user_id=outsider.id,
                request=ProjectChatAgentFailure(
                    project_id=delivery_project.id,
                    task_id=item.id,
                    message_id="agent-message",
                ),
            )
        else:
            trigger = ProjectChatMessage(
                project_id=delivery_project.id,
                task_id=item.id,
                sender_type="user",
                sender_id=str(outsider.id),
                sender_name=outsider.user_name,
                message_id=str(uuid.uuid4()),
                content="Plain comment",
                metadata_json={},
            )
            _new_execution(
                test_db,
                outsider.id,
                ProjectChatCommentExecution(
                    project_id=delivery_project.id,
                    task_id=item.id,
                    trigger_message_id=trigger.message_id,
                ),
                trigger,
                [],
                delivery_project,
            )
    assert denied.value.status_code == 403
    assert (
        test_db.query(ProjectChatMessage)
        .filter_by(task_id=item.id, sender_type="agent")
        .count()
        == 0
    )
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0
