"""Human handoff notification and draft persistence without AI advancement."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.project_chat_message import ProjectChatMessage
from app.models.wework_notification import WeworkNotification
from app.schemas.issue_assignment import IssueAssignmentResult
from app.schemas.wework_navigation import validate_wework_url
from app.services.issue_assignments import issue_assignment_service
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.loop_item_unread import is_unread
from tests.services.test_issue_assignments import assigned_issue, command


@pytest.fixture(autouse=True)
def no_external_delivery(monkeypatch):
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", MagicMock())
    monkeypatch.setattr(
        "app.services.project_chat.push.push_project_chat_message", MagicMock()
    )


@pytest.mark.asyncio
async def test_handoff_notifies_once_and_marks_issue_unread(
    test_db, test_user, assigned_issue
):
    issue, manager = assigned_issue
    issue.metadata_json = {
        **issue.metadata_json,
        "content_revision": 1,
        "read_revisions": {str(test_user.id): 1},
    }
    test_db.commit()
    decision = command("assign_user", assignee_user_id=test_user.id)
    for _ in range(2):
        await issue_assignment_service.decide(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            decision=decision,
            manager_run_id=manager.id,
        )
    notice = test_db.query(WeworkNotification).one()
    assert notice.user_id == test_user.id
    assert notice.is_read is False
    assert notice.url == (
        f"wework://boards/{issue.cloud_project_id}/issues/{issue.id}"
        "/assignments/assignment-1"
    )
    assert validate_wework_url(notice.url) == notice.url
    assert notice.payload["assignmentId"] == "assignment-1"
    assert notice.payload["instruction"] == decision.instruction
    assert is_unread(issue.metadata_json, test_user.id)


@pytest.mark.asyncio
@pytest.mark.parametrize("paused", [False, True])
async def test_save_reply_is_idempotent_and_keeps_human_control(
    test_db, test_user, assigned_issue, monkeypatch, paused
):
    issue, manager = assigned_issue
    start = AsyncMock()
    monkeypatch.setattr(issue_workflow_start_service, "start", start)
    await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command("assign_user", assignee_user_id=test_user.id),
        manager_run_id=manager.id,
    )
    if paused:
        issue.metadata_json = {
            **issue.metadata_json,
            "workflow": {
                **issue.metadata_json["workflow"],
                "orchestration_status": "paused",
            },
        }
        test_db.commit()
    version = issue.metadata_json["workflow"]["assignment_version"]
    for _ in range(2):
        saved = issue_assignment_service.save_reply(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            result=IssueAssignmentResult(
                assignment_id="assignment-1", summary="Need another review"
            ),
        )
        assert saved["assignment"]["reply_draft"] == "Need another review"
        assert saved["assignment"]["status"] == "waiting_human"
        assert saved["orchestration_status"] == (
            "paused" if paused else "waiting_human"
        )
        assert saved["assignment_version"] == version
    comments = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.task_id == issue.id,
            ProjectChatMessage.sender_type == "user",
        )
        .all()
    )
    assert len(comments) == 1
    assert comments[0].content == "Need another review"
    assert comments[0].sender_id == str(test_user.id)
    assert test_db.query(WeworkNotification).count() == 1
    start.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["stale", "other_person"])
async def test_reply_rejects_stale_assignment_and_wrong_owner(
    test_db, test_user, assigned_issue, invalid
):
    issue, manager = assigned_issue
    await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command("assign_user", assignee_user_id=test_user.id),
        manager_run_id=manager.id,
    )
    if invalid == "other_person":
        workflow = issue.metadata_json["workflow"]
        issue.metadata_json = {
            **issue.metadata_json,
            "workflow": {
                **workflow,
                "assignment": {
                    **workflow["assignment"],
                    "assignee_user_id": test_user.id + 1,
                },
            },
        }
        test_db.commit()
    with pytest.raises(ValueError, match="no longer|Only the assigned"):
        issue_assignment_service.save_reply(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            result=IssueAssignmentResult(
                assignment_id=(
                    "old-assignment" if invalid == "stale" else "assignment-1"
                ),
                summary="Do not accept",
            ),
        )
    assert "reply_draft" not in issue.metadata_json["workflow"]["assignment"]


@pytest.mark.asyncio
async def test_reply_endpoint_requires_human_authentication(
    test_db, test_user, assigned_issue, test_client, test_token, test_task_token
):
    issue, manager = assigned_issue
    await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command("assign_user", assignee_user_id=test_user.id),
        manager_run_id=manager.id,
    )
    path = f"/api/v1/loop-items/{issue.id}/assignment/reply"
    values = {"assignment_id": "assignment-1", "summary": "Still reviewing"}
    assert (
        test_client.post(
            path, json=values, headers={"Authorization": f"Bearer {test_task_token}"}
        ).status_code
        == 401
    )
    response = test_client.post(
        path, json=values, headers={"Authorization": f"Bearer {test_token}"}
    )
    assert response.status_code == 200
    assert response.json()["assignment"]["status"] == "waiting_human"
