# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Explicit Issue invitations never grant access to the containing project."""

import hashlib
import uuid
from unittest.mock import AsyncMock, Mock, call

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.cloud_project import CloudProject
from app.models.delivery import (
    LoopItem,
    LoopItemCollaborator,
    LoopItemTaskBinding,
    StandInIssueEvent,
)
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.services.auth.task_token import create_task_token
from app.services.cloud_projects.access import IssueAction, require_cloud_project_role
from app.services.delivery.service import delivery_service
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items.service import loop_item_service
from app.services.wework_notifications import (
    deliver_notification_payload,
    notification_links,
)
from tests.api.test_deliveries_api import delivery_project


def revoke_invitation_fixture(db: Session, issue_id: str, user_id: int) -> None:
    invitation = (
        db.query(LoopItemCollaborator)
        .filter_by(loop_item_id=issue_id, user_id=user_id)
        .one()
    )
    db.delete(invitation)
    db.commit()


def test_shared_my_work_lists_unlinked_issues_by_current_invitation(
    test_client: TestClient, test_db: Session, test_user: User, outsider: User
) -> None:
    def issue(title: str, archived: bool = False) -> LoopItem:
        return LoopItem(
            title=title,
            description="",
            status="pending",
            priority="medium",
            created_by_user_id=test_user.id,
            assignee_user_id=outsider.id,
            metadata_json={"archived": archived},
        )

    visible, hidden, archived = (
        issue("Visible"),
        issue("Outside scope"),
        issue("Archived", True),
    )
    test_db.add_all([visible, hidden, archived])
    test_db.flush()
    test_db.add_all(
        [
            LoopItemCollaborator(
                loop_item_id=row.id,
                user_id=outsider.id,
                added_by_user_id=test_user.id,
                source="manual",
            )
            for row in (visible, archived)
        ]
    )
    test_db.commit()
    token = create_access_token(data={"sub": outsider.user_name})
    path = "/api/v1/cloud-work-items/my-work"

    def page(bearer=token, **options):
        response = test_client.get(
            path,
            params={
                "unlinked": "true",
                "scope": "assigned",
                "order": "attention",
                **options,
            },
            headers={"Authorization": f"Bearer {bearer}"},
        )
        assert response.status_code == 200, response.text
        return response.json()

    (item,) = page()["items"]
    assert item["id"] == visible.id
    assert item["cloud_project_id"] == ""
    assert item["assignment_context"] is None
    headers = {"Authorization": f"Bearer {token}"}
    assert (
        test_client.get(f"/api/v1/loop-items/{hidden.id}", headers=headers).status_code
        == 404
    )
    assert [item["id"] for item in page(archived="true")["items"]] == [archived.id]
    owner = create_access_token(data={"sub": test_user.user_name})
    first = page(owner, scope="created", limit=1)
    assert first["next_cursor"]
    second = page(owner, scope="created", limit=1, cursor=first["next_cursor"])
    assert {first["items"][0]["id"], second["items"][0]["id"]} == {
        visible.id,
        hidden.id,
    }
    assert second["next_cursor"] is None
    revoke_invitation_fixture(test_db, visible.id, outsider.id)
    assert page()["items"] == []
    assert (
        test_client.get(f"/api/v1/loop-items/{visible.id}", headers=headers).status_code
        == 404
    )


def test_cp14_unlinked_issue_uses_standard_detail_response(
    test_client: TestClient, test_db: Session, test_user: User, outsider: User
) -> None:
    item = LoopItem(
        title="Issue without a project",
        description="Private detail",
        status="pending",
        priority="medium",
        created_by_user_id=test_user.id,
        metadata_json={
            "due_at": "2026-12-05",
            "share": {"files": [{"object_key": "private-storage"}]},
            "archived": True,
            "assignee_resource": {"kind": "agent", "id": 5},
            "resource_participants": [
                {
                    "kind": "agent",
                    "id": 5,
                    "name": "Reviewer",
                    "instructions": "Private configuration",
                    "team_id": 7,
                }
            ],
        },
    )
    test_db.add(item)
    test_db.commit()
    path = f"/api/v1/loop-items/{item.id}"
    owner = create_access_token(data={"sub": test_user.user_name})
    guest = create_access_token(data={"sub": outsider.user_name})
    task_token = create_task_token(1, 1, test_user.id, test_user.user_name)

    def read(token: str):
        return test_client.get(path, headers={"Authorization": f"Bearer {token}"})

    assert read(task_token).status_code == 404
    assert read(guest).status_code == 404
    response = read(owner)
    assert response.status_code == 200, response.text
    detail = response.json()
    assert detail["cloud_project_id"] == ""
    assert detail["sequence_number"] == 0
    assert detail["security_level"] == "related"
    assert detail["description"] == "Private detail"
    assert detail["assignee_agent_id"] == "5"
    assert detail["assignee_agent_name"] == "Reviewer"
    assert detail["due_at"].startswith("2026-12-05")
    assert detail["resource_participants"] == [
        {"kind": "agent", "id": 5, "name": "Reviewer"}
    ]
    assert detail["permissions"] == {
        "edit_content": True,
        "comment": True,
        "assign": True,
        "execute": False,
    }
    assert detail["edit_context"] == {
        "participants": [],
        "resources": [{"kind": "agent", "id": 5, "name": "Reviewer", "team_id": 7}],
        "archived": True,
        "has_shared_source": True,
    }

    test_db.add(
        LoopItemCollaborator(
            loop_item_id=item.id,
            user_id=outsider.id,
            added_by_user_id=test_user.id,
            source="team_invitation",
        )
    )
    test_db.commit()
    invited = read(guest)
    assert invited.status_code == 200
    assert invited.json()["edit_context"] == {
        **detail["edit_context"],
        "has_shared_source": False,
        "participants": [
            {"user_id": outsider.id, "user_name": outsider.user_name, "direct": False}
        ],
    }
    revoke_invitation_fixture(test_db, item.id, outsider.id)
    assert read(guest).status_code == 404


def test_cp14_collaborator_list_for_issue_without_project(
    test_db: Session,
    test_user: User,
    outsider: User,
) -> None:
    item = LoopItem(
        title="Issue without a project",
        description="Private content",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.flush()
    invitation = LoopItemCollaborator(
        loop_item_id=item.id,
        user_id=outsider.id,
        added_by_user_id=test_user.id,
        source="manual",
    )
    test_db.add(invitation)
    test_db.commit()

    rows = loop_item_service.list_collaborators(test_db, item.id, outsider.id)
    assert len(rows) == 1
    assert rows[0]["user_id"] == outsider.id
    assert rows[0]["loop_item_id"] == item.id
    assert rows[0]["id"] == invitation.id
    assert rows[0]["source"] == "manual"
    assert rows[0]["email"] is None

    invitation.source = "team_invitation"
    test_db.commit()
    assert loop_item_service.list_collaborators(test_db, item.id, outsider.id) == []

    test_db.delete(invitation)
    test_db.commit()
    with pytest.raises(HTTPException) as revoked:
        loop_item_service.list_collaborators(test_db, item.id, outsider.id)
    assert revoked.value.status_code == 404
    assert loop_item_service.list_collaborators(test_db, item.id, test_user.id) == []


def test_cp14_shared_issue_patch_updates_only_submitted_content(
    test_client: TestClient, test_db: Session, test_user: User, outsider: User
) -> None:
    item = LoopItem(
        title="Original",
        description="Keep the description",
        status="in_progress",
        priority="low",
        created_by_user_id=test_user.id,
        metadata_json={"archived": True, "due_at": "2026-12-01"},
    )
    test_db.add(item)
    test_db.flush()
    invitation = LoopItemCollaborator(
        loop_item_id=item.id,
        user_id=outsider.id,
        added_by_user_id=test_user.id,
        source="manual",
    )
    test_db.add(invitation)
    test_db.commit()
    version = item.version
    path = f"/api/v1/loop-items/{item.id}"
    guest = create_access_token(data={"sub": outsider.user_name})
    task = create_task_token(1, 1, test_user.id, test_user.user_name)

    def update(values: dict, token: str = guest):
        return test_client.patch(
            path, json=values, headers={"Authorization": f"Bearer {token}"}
        )

    patch = {
        "version": version,
        "title": " Changed ",
        "priority": "high",
    }
    assert update(patch, task).status_code == 404
    response = update(patch)
    assert response.status_code == 200, response.text
    detail = response.json()
    assert detail["title"] == "Changed"
    assert detail["description"] == "Keep the description"
    assert detail["status"] == "in_progress"
    assert detail["version"] == version + 1
    assert detail["priority"] == "high"
    assert detail["due_at"].startswith("2026-12-01")
    assert detail["edit_context"]["archived"] is True
    assert detail["edit_context"]["participants"][0]["user_id"] == outsider.id
    assert update(patch).json()["detail"]["code"] == "version_conflict"
    cleared = update({"version": detail["version"], "due_at": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["due_at"] is None
    assert cleared.json()["title"] == "Changed"
    latest = cleared.json()["version"]
    unsupported = update({"version": latest, "assignee_team_id": 1})
    assert unsupported.status_code == 422
    revoke_invitation_fixture(test_db, item.id, outsider.id)
    assert update({"version": latest, "title": "Unauthorized"}).status_code == 404
    assert item.title == "Changed"


def test_cp14_issue_detail_only_returns_visible_relations(
    test_client: TestClient, test_db: Session, test_user: User, outsider: User
) -> None:
    def issue(title: str, parent_id: str | None = None) -> LoopItem:
        return LoopItem(
            title=title,
            status="pending",
            priority="medium",
            parent_id=parent_id,
            created_by_user_id=test_user.id,
        )

    parent = issue("Parent")
    test_db.add(parent)
    test_db.flush()
    visible = issue("Visible child", parent.id)
    private = issue("Private child", parent.id)
    test_db.add_all([visible, private])
    test_db.flush()
    child_invitation = LoopItemCollaborator(
        loop_item_id=visible.id,
        user_id=outsider.id,
        added_by_user_id=test_user.id,
        source="manual",
    )
    test_db.add(child_invitation)
    test_db.commit()
    token = create_access_token(data={"sub": outsider.user_name})
    headers = {"Authorization": f"Bearer {token}"}

    def relations(issue_id: str) -> list[str]:
        result = test_client.get(f"/api/v1/loop-items/{issue_id}", headers=headers)
        assert result.status_code == 200, result.text
        return [item["id"] for item in result.json()["related_issues"]]

    assert relations(visible.id) == []
    test_db.add(
        LoopItemCollaborator(
            loop_item_id=parent.id,
            user_id=outsider.id,
            added_by_user_id=test_user.id,
            source="manual",
        )
    )
    test_db.commit()
    assert relations(parent.id) == [visible.id]
    assert relations(visible.id) == [parent.id]


@pytest.mark.parametrize("remove_issue", [False, True])
def test_cp14_unlinked_assignment_uses_shared_issue_endpoints(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    outsider: User,
    monkeypatch: pytest.MonkeyPatch,
    remove_issue: bool,
) -> None:
    monkeypatch.setattr("app.core.socketio.get_sio", lambda: Mock(emit=AsyncMock()))
    item = LoopItem(
        title="Assign this Issue",
        status="pending",
        priority="medium",
        created_by_user_id=test_user.id,
        metadata_json={
            "resource_participants": [{"kind": "group", "id": 3, "name": "Reviewers"}]
        },
    )
    test_db.add(item)
    test_db.flush()
    invitation = LoopItemCollaborator(
        loop_item_id=item.id,
        user_id=outsider.id,
        added_by_user_id=test_user.id,
        source="team_invitation",
    )
    test_db.add(invitation)
    test_db.commit()
    token = create_access_token(data={"sub": test_user.user_name})

    def update(values: dict):
        return test_client.patch(
            f"/api/v1/loop-items/{item.id}",
            json=values,
            headers={"Authorization": f"Bearer {token}"},
        )

    assignment = {
        "version": item.version,
        "assignee_user_id": outsider.id,
        "notify_assignee": True,
    }
    assert update(assignment).status_code == 422
    invitation.source = "manual"
    test_db.commit()

    response = update(assignment)
    assert response.status_code == 200, response.text
    test_db.refresh(item)
    assignment_id = item.metadata_json["assignment_id"]
    assert response.json()["assignee_user_id"] == outsider.id
    history = response.json()["assignment_history"]
    assert [(entry["action"], entry["to_name"]) for entry in history] == [
        ("assign", outsider.user_name)
    ]
    assert [
        entry.id
        for entry in issue_assignment_service.active_for_issue(test_db, item.id)
    ] == [assignment_id]
    event = test_db.query(StandInIssueEvent).filter_by(user_id=outsider.id).one()
    assert event.metadata_json == {
        "assignmentId": assignment_id,
        "personalIssueId": item.id,
    }

    binding = LoopItemTaskBinding(
        id=hashlib.sha256(
            f"issue-stand-in:{item.id}:{assignment_id}".encode()
        ).hexdigest(),
        loop_item_id=item.id,
        task_user_id=outsider.id,
        linked_by_user_id=outsider.id,
        device_id="device",
        task_id="task",
        metadata_json={"assignment_id": assignment_id},
    )
    test_db.add(binding)
    test_db.commit()

    if remove_issue:
        item.metadata_json = {
            **item.metadata_json,
            "share": {"files": [{"id": "file"}]},
        }
        message = ProjectChatMessage(
            message_id="unlinked-discussion", task_id=item.id, content="Discussion"
        )
        test_db.add(message)
        test_db.commit()
        path = f"/api/v1/loop-items/{item.id}"
        guest = create_access_token(data={"sub": outsider.user_name})

        def delete(version: int, bearer: str = token):
            return test_client.request(
                "DELETE",
                path,
                json={"version": version},
                headers={"Authorization": f"Bearer {bearer}"},
            )

        assert delete(item.version, guest).status_code == 404
        assert delete(item.version - 1).status_code == 409
        assert item.deleted_at is None
        response = delete(item.version)
        assert response.status_code == 204, response.text
        test_db.refresh(item)
        test_db.refresh(binding)
        test_db.refresh(message)
        assert item.deleted_at is not None
        assert binding.unlinked_at is not None
        assert message.deleted_at == item.deleted_at
        assert item.metadata_json["share"]["files"] == [{"id": "file"}]
        return

    cleared = update({"version": item.version, "assignee_user_id": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["assignee_user_id"] is None
    assert cleared.json()["assignment_history"][-1]["action"] == "unassign"
    test_db.refresh(binding)
    assert binding.unlinked_at is not None
    assert issue_assignment_service.active_for_issue(test_db, item.id) == []
    group = update({"version": cleared.json()["version"], "assignee_group_id": "3"})
    assert group.status_code == 200, group.text
    history = group.json()["assignment_history"]
    assert history[-1]["to_name"] == "Reviewers"
    repeated = update({"version": group.json()["version"], "assignee_group_id": "3"})
    assert repeated.json()["assignment_history"] == history


def test_project_assignee_clear_keeps_workflow_assignments(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emit = AsyncMock()
    monkeypatch.setattr("app.core.socketio.get_sio", lambda: Mock(emit=emit))
    item = LoopItem(
        title="Clear the primary assignee",
        status="pending",
        priority="medium",
        created_by_user_id=test_user.id,
        cloud_project_id=delivery_project.id,
        sequence_number=1,
    )
    test_db.add(item)
    test_db.commit()
    token = create_access_token(data={"sub": test_user.user_name})
    path = f"/api/v1/loop-items/{item.id}"
    headers = {"Authorization": f"Bearer {token}"}
    assign = {
        "version": item.version,
        "assignee_user_id": test_user.id,
        "notify_assignee": False,
    }
    assigned = test_client.patch(path, json=assign, headers=headers)
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["assignee_user_id"] == test_user.id
    assert assigned.json()["status"] == "pending"
    assert assigned.json()["assignment_history"][-1]["to_name"] == test_user.user_name
    stale = test_client.patch(path, json=assign, headers=headers)
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "version_conflict"
    test_db.refresh(item)
    root = issue_assignment_service.active_for_issue(test_db, item.id)
    assert [(entry.workflow_step, entry.metadata["notify"]) for entry in root] == [
        ("", False)
    ]
    issue_assignment_service.record(
        test_db,
        project_id=delivery_project.id,
        issue_id=item.id,
        member_type="human",
        member_id=str(test_user.id),
        assigned_by_user_id=test_user.id,
        workflow_step="review",
        notify=False,
        trigger="manual",
    )
    test_db.commit()
    response = test_client.patch(
        path,
        json={"version": item.version, "assignee_user_id": None},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["assignee_user_id"] is None
    active = issue_assignment_service.active_for_issue(test_db, item.id)
    assert [entry.workflow_step for entry in active] == ["review"]
    assert emit.await_count == 2
    assert emit.await_args.args[1] == {
        "event": "wework.issue.assignments.changed",
        "payload": {"userId": test_user.id},
    }


@pytest.mark.parametrize("linked", [False, True])
def test_cp14_shared_issue_status_updates_history_and_assignment_count(
    linked: bool,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emit = AsyncMock()
    monkeypatch.setattr("app.core.socketio.get_sio", lambda: Mock(emit=emit))
    item = LoopItem(
        title="Assigned Issue",
        description="Keep the assignment",
        status="in_progress",
        priority="medium",
        created_by_user_id=test_user.id,
        assignee_user_id=test_user.id,
        cloud_project_id=delivery_project.id if linked else None,
        sequence_number=1 if linked else None,
    )
    test_db.add(item)
    test_db.commit()
    path = f"/api/v1/loop-items/{item.id}"
    token = create_access_token(data={"sub": test_user.user_name})

    def update(next_status: str, version: int):
        return test_client.patch(
            path,
            json={"status": next_status, "version": version},
            headers={"Authorization": f"Bearer {token}"},
        )

    version = item.version
    if not linked:
        assert update("in_review", version).status_code == 422
    closed = update("completed", version)
    assert closed.status_code == 200, closed.text
    detail = closed.json()
    assert detail["assignee_user_id"] == test_user.id
    assert detail["completed_at"] is not None
    assert detail["status_history"][-1]["from_status_name"] == "进行中"
    assert detail["status_history"][-1]["to_status_name"] == "已完成"
    assert update("in_progress", version).status_code == 409

    reopened = update("in_progress", detail["version"])
    assert reopened.status_code == 200, reopened.text
    detail = reopened.json()
    assert detail["completed_at"] is None
    assert [entry["to_status"] for entry in detail["status_history"]] == [
        "completed",
        "in_progress",
    ]
    repeated = update("in_progress", detail["version"])
    assert repeated.json()["status_history"] == detail["status_history"]
    event = call(
        "runtime:event",
        {
            "event": "wework.issue.assignments.changed",
            "payload": {"userId": test_user.id},
        },
        room=f"wework-runtime:user:{test_user.id}",
        namespace="/wework-runtime",
    )
    assert emit.await_args_list == [event, event]

    version = repeated.json()["version"]
    headers = {"Authorization": f"Bearer {token}"}
    archived = test_client.patch(
        path, json={"version": version, "archived": True}, headers=headers
    )
    if linked:
        assert archived.status_code == 422
        assert emit.await_args_list == [event, event]
        return

    assert archived.status_code == 200, archived.text
    archive_detail = archived.json()
    assert archive_detail["edit_context"]["archived"] is True
    for key in ("description", "status", "assignee_user_id", "status_history"):
        assert archive_detail[key] == detail[key]
    stale = test_client.patch(
        path, json={"version": version, "archived": False}, headers=headers
    )
    assert stale.status_code == 409
    restored = test_client.patch(
        path,
        json={"version": archive_detail["version"], "archived": False},
        headers=headers,
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["edit_context"]["archived"] is False
    assert emit.await_args_list == [event, event, event, event]


def test_cp14_add_collaborator_to_issue_without_project(
    test_db: Session, test_user: User, outsider: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    schedule = Mock()
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", schedule)
    item = LoopItem(title="Private Issue", created_by_user_id=test_user.id)
    test_db.add(item)
    test_db.commit()
    version = item.version

    with pytest.raises(HTTPException) as hidden:
        loop_item_service.add_collaborator(test_db, item.id, test_user.id, outsider.id)
    assert hidden.value.status_code == 404

    added = loop_item_service.add_collaborator(
        test_db, item.id, outsider.id, test_user.id
    )
    assert item.version == version + 1
    assert added["user_id"] == outsider.id
    assert added["email"] is None
    with pytest.raises(HTTPException) as forbidden:
        loop_item_service.add_collaborator(test_db, item.id, test_user.id, outsider.id)
    assert forbidden.value.status_code == 403

    same = loop_item_service.add_collaborator(
        test_db, item.id, outsider.id, test_user.id
    )
    assert same["id"] == added["id"]
    assert item.version == version + 1

    existing = test_db.get(LoopItemCollaborator, added["id"])
    existing.source = "team_invitation"
    test_db.commit()
    promoted = loop_item_service.add_collaborator(
        test_db, item.id, outsider.id, test_user.id
    )
    assert promoted["id"] == added["id"]
    assert promoted["source"] == "manual"
    assert item.version == version + 2

    schedule.assert_called_once()
    deliver, notification, channels = schedule.call_args.args
    assert deliver is deliver_notification_payload
    assert channels == {"in_app": False, "system": False, "im": True}
    assert notification["user_id"] == outsider.id
    assert notification["kind"] == "issue_participation"
    assert notification["payload"] == {
        "personalIssueId": item.id,
        "itemTitle": item.title,
        "assigned": False,
    }
    desktop, web = notification_links(WeworkNotification(**notification))
    assert desktop.url == f"wework://personal-issues/{item.id}"
    assert web.url.endswith(f"/collaboration/participating?personalIssueId={item.id}")


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
    revoke_invitation_fixture(test_db, parent.id, outsider.id)
    with pytest.raises(HTTPException) as hidden_parent:
        loop_item_service.get(test_db, parent.id, outsider.id)
    assert hidden_parent.value.status_code == 404
    assert loop_item_service.get(test_db, child.id, outsider.id).id == child.id
    revoke_invitation_fixture(test_db, child.id, outsider.id)
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
        revoke_invitation_fixture(test_db, item.id, outsider.id)
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

    revoke_invitation_fixture(test_db, item.id, outsider.id)

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
