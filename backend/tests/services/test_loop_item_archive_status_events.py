# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Archiving cancels linked activity without changing an Issue's business state."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    ProjectIncomingEvent,
    loop_datetime_value_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.project_chat import ProjectChatCommentExecution, ProjectChatSend
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_execution import project_automation_execution
from app.services.project_chat.comment_execution import execute_comment
from app.services.project_chat.service import project_chat_service
from app.services.project_incoming_hooks import project_incoming_hook_service
from tests.api.test_deliveries_api import delivery_project
from tests.utils.collaboration import authorize_project_agent


@pytest.fixture
async def linked_archive_activity(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[LoopItem, LoopItemExecution, ProjectChatMessage]:
    monkeypatch.setattr(
        "app.services.project_chat.service.notify_project_chat_mentions", MagicMock()
    )
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.wework_notifications.deliver_notification", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.project_chat.push.push_project_chat_message", MagicMock()
    )
    agent = ProjectChatAgent(
        id="archive-agent",
        cloud_project_id=delivery_project.id,
        title="Archive agent",
        name="Archive agent",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={"runtime": "codex", "capability_mode": "manual"},
    )
    authorize_project_agent(test_db, agent)
    issue = LoopItem(
        cloud_project_id=delivery_project.id,
        title="Archive an Issue with a queued AI activity",
        status="in_progress",
        assignee_agent_id=agent.id,
        created_by_user_id=test_user.id,
    )
    rule = ProjectAutomationRule(
        cloud_project_id=delivery_project.id,
        title="Run when entering review",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.status_changed",
            "event_config": {
                "transition": "any",
                "statuses": ["in_review"],
                "execution_target": "existing_issue",
            },
        },
    )
    test_db.add_all([agent, issue, rule])
    test_db.commit()
    saved = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            project_id=delivery_project.id,
            task_id=issue.id,
            client_message_id="archive-comment",
            content="Please execute before archiving",
            mentions=[{"type": "agent", "id": agent.id, "label": agent.name}],
        ),
    )
    # Comment admission creates its activity before any Runtime claim exists.
    responses = await execute_comment(
        test_db,
        user_id=test_user.id,
        request=ProjectChatCommentExecution(
            project_id=delivery_project.id,
            task_id=issue.id,
            trigger_message_id=saved.message.message_id,
        ),
    )
    execution = test_db.get(LoopItemExecution, responses[0].metadata["execution_id"])
    activity = (
        test_db.query(ProjectChatMessage)
        .filter_by(message_id=responses[0].message_id)
        .one()
    )
    assert execution.status == "queued"
    assert execution.runtime_device_id == ""
    assert activity.status == "pending"
    assert activity.metadata_json["execution_id"] == execution.id
    return issue, execution, activity


@pytest.mark.asyncio
@pytest.mark.parametrize("execution_status", ["queued", "waiting_runtime"])
@pytest.mark.parametrize("archive_parent", [False, True])
async def test_archive_linked_activity_preserves_status_without_review_event(
    test_db: Session,
    test_user: User,
    linked_archive_activity: tuple[LoopItem, LoopItemExecution, ProjectChatMessage],
    execution_status: str,
    archive_parent: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    issue, execution, activity = linked_archive_activity
    if execution_status == "waiting_runtime":
        assert loop_item_execution_service.prepare_queued_assignments(test_db) == 1
        assert execution.status == "waiting_runtime"
    root = issue
    if archive_parent:
        root = LoopItem(
            cloud_project_id=issue.cloud_project_id,
            title="Archive the entire subtree",
            status="inbox",
            created_by_user_id=test_user.id,
        )
        test_db.add(root)
        test_db.flush()
        issue.parent_id = root.id
    test_db.commit()
    issue_version = issue.version
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    loop_item_service.delete(test_db, root.id, test_user.id)

    assert not loop_datetime_value_is_unset(issue.deleted_at)
    assert issue.status == "in_progress"
    assert issue.version == issue_version + 1
    assert execution.status == "cancelled"
    assert activity.status == "cancelled"
    assert test_db.query(ProjectIncomingEvent).count() == 0
    assert await project_incoming_hook_service.check_pending(test_db) == 0
    assert test_db.query(ProjectAutomationRun).count() == 0
    dispatch.assert_not_awaited()
    loop_item_service.restore(test_db, root.id, test_user.id)
    assert issue.status == "in_progress"
    if archive_parent:
        assert root.status == "inbox"


@pytest.mark.asyncio
async def test_archive_and_linked_activity_cancellation_rollback_together(
    test_db: Session,
    test_user: User,
    linked_archive_activity: tuple[LoopItem, LoopItemExecution, ProjectChatMessage],
) -> None:
    issue, execution, activity = linked_archive_activity
    issue_version = issue.version

    def fail_cancellation_flush(
        _session: Session, _flush_context: object, _instances: object
    ) -> None:
        if execution.status != "cancelled":
            return
        assert not loop_datetime_value_is_unset(issue.deleted_at)
        assert execution.status == "cancelled"
        assert activity.status == "cancelled"
        raise RuntimeError("Cancellation flush interrupted")

    event.listen(test_db, "before_flush", fail_cancellation_flush)
    try:
        with pytest.raises(RuntimeError, match="Cancellation flush interrupted"):
            loop_item_service.delete(test_db, issue.id, test_user.id)
    finally:
        event.remove(test_db, "before_flush", fail_cancellation_flush)
    test_db.rollback()

    assert loop_datetime_value_is_unset(issue.deleted_at)
    assert issue.status == "in_progress"
    assert issue.version == issue_version
    assert execution.status == "queued"
    assert activity.status == "pending"
    assert test_db.query(ProjectIncomingEvent).count() == 0
