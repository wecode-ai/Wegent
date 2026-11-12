"""Existing stop endpoint uses current Group and exact Thread execution authority."""

import pytest

from app.core.security import create_access_token
from app.models.delivery import (
    CloudProject,
    CollaborationChatGroup,
    LoopItem,
    ThreadParticipant,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_chat import LoopItemExecutionView
from app.services.loop_items.service import loop_item_service
from app.services.thread_participation import join_thread, participant_id
from tests.services.test_group_agent_resources import inline
from tests.services.test_thread_participation import make_group, person


def setup(db, owner, *, role="Developer", joined=True):
    actor = person(db, "group-run-controller")
    group = make_group(db, owner, [(actor, role)])
    agent = inline(db, owner, group)
    item = loop_item_service.create(
        db,
        cloud_project_id=group.id,
        user_id=owner.id,
        values=LoopItemCreate(title="Real shared run", assignee_agent_id=agent.id),
    )
    if joined:
        join_thread(db, item, actor.id)
    run = db.query(LoopItemExecution).filter_by(loop_item_id=item.id).one()
    db.commit()
    token = create_access_token(data={"sub": actor.user_name})
    return group, item, run, actor, {"Authorization": f"Bearer {token}"}


def stop(client, group, run, headers):
    return client.post(
        f"/api/v1/cloud-projects/{group.id}/executions/{run.id}/stop",
        headers=headers,
    )


def test_joined_group_developer_can_stop_real_group_owned_run(
    test_client, test_db, test_user
):
    group, item, run, _, headers = setup(test_db, test_user)
    response = stop(test_client, group, run, headers)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert LoopItemExecutionView.model_validate(response.json()).workspace_id is None
    test_db.refresh(run)
    assert run.status == "cancelled"
    assert run.cloud_project_id == item.cloud_project_id == group.id
    assert test_db.get(CloudProject, group.id) is None


@pytest.mark.parametrize("role,joined", [("Viewer", True), ("Developer", False)])
def test_reading_or_joining_does_not_grant_stop_authority(
    test_client, test_db, test_user, role, joined
):
    group, _, run, _, headers = setup(test_db, test_user, role=role, joined=joined)
    before = run.status, run.version
    response = stop(test_client, group, run, headers)
    assert response.status_code == 403, response.text
    test_db.refresh(run)
    assert (run.status, run.version) == before


@pytest.mark.parametrize(
    "change,expected",
    [("leave", 403), ("revoke", 404), ("complete", 409), ("archive", 409)],
)
def test_stop_rechecks_current_group_and_thread_after_ui_was_opened(
    test_client, test_db, test_user, change, expected
):
    group, item, run, actor, headers = setup(test_db, test_user)
    if change == "leave":
        test_db.get(ThreadParticipant, participant_id(item.id, actor.id)).status = (
            "left"
        )
    elif change == "revoke":
        test_db.query(ResourceMember).filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group.id),
            entity_type="user",
            entity_id=str(actor.id),
        ).one().status = "rejected"
    elif change == "complete":
        item.status = "completed"
    else:
        group.status = "archived"
    test_db.commit()
    before = run.status, run.version
    response = stop(test_client, group, run, headers)
    assert response.status_code == expected, response.text
    test_db.refresh(run)
    assert (run.status, run.version) == before


def test_stop_refuses_execution_pointing_at_another_groups_thread(
    test_client, test_db, test_user
):
    group, _, run, _, headers = setup(test_db, test_user)
    other = CollaborationChatGroup(
        project_key="STOPOTHER",
        name="Unrelated Group",
        created_by_user_id=test_user.id,
    )
    test_db.add(other)
    test_db.flush()
    item = LoopItem(
        cloud_project_id=other.id,
        title="Unrelated Thread",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.flush()
    run.loop_item_id = item.id
    test_db.commit()
    before = run.status, run.version
    response = stop(test_client, group, run, headers)
    assert response.status_code == 404, response.text
    test_db.refresh(run)
    assert (run.status, run.version) == before


def test_group_execution_list_uses_actual_group_read_scope(
    test_client, test_db, test_user
):
    group, item, run, _, headers = setup(test_db, test_user)
    response = test_client.get(
        f"/api/v1/cloud-projects/{group.id}/executions", headers=headers
    )
    assert response.status_code == 200, response.text
    listed = response.json()["items"]
    assert [row["id"] for row in listed] == [run.id]
    actual = LoopItemExecutionView.model_validate(listed[0])
    assert str(actual.cloud_project_id) == group.id
    assert actual.loop_item_id == item.id
    assert actual.workspace_id is None


def test_group_execution_list_does_not_open_an_unrelated_group(
    test_client, test_db, test_user
):
    group, _, _, actor, headers = setup(test_db, test_user)
    test_db.query(ResourceMember).filter_by(
        resource_type="CollaborationChatGroup",
        resource_id=int(group.id),
        entity_type="user",
        entity_id=str(actor.id),
    ).one().status = "rejected"
    test_db.commit()
    response = test_client.get(
        f"/api/v1/cloud-projects/{group.id}/executions", headers=headers
    )
    assert response.status_code == 404, response.text
