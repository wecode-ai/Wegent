# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Explicit Issue invitations never grant access to the containing project."""

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.user import User
from app.services.cloud_projects.access import IssueAction, require_cloud_project_role
from app.services.delivery.service import delivery_service
from app.services.loop_items.service import loop_item_service
from tests.api.test_deliveries_api import delivery_project


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
