# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Human assignment cards keep Issue context and personal-task actions."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.user import User
from app.services import collaboration_human_assignments
from app.services.channels.dingtalk.notification_card import card_param_map
from app.services.channels.dingtalk.sender import DingTalkRobotSender
from app.services.notification_copy import NotificationTarget, push_copy


@pytest.fixture
def capture_notification(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    create = MagicMock()
    monkeypatch.setattr(collaboration_human_assignments, "create_notification", create)
    monkeypatch.setattr(
        DingTalkRobotSender,
        "send_card",
        AsyncMock(side_effect=AssertionError("Unit tests must not deliver IM cards")),
    )
    return create


def _db(*users: User) -> MagicMock:
    db = MagicMock(spec=Session)
    db.query.return_value.filter.return_value.all.return_value = []
    by_id = {user.id: user for user in users}
    db.get.side_effect = lambda model, key: by_id.get(key)
    return db


def _project() -> CloudProject:
    return CloudProject(
        id="24",
        project_key="2026TEST",
        name="发布看板",
        metadata_json={
            "board_config": {"statuses": [{"id": "in_review", "name": "待人工验收"}]}
        },
    )


def _issue() -> LoopItem:
    return LoopItem(
        id="2026TEST-12",
        name="",
        title="修复通知卡片",
        description="检查任务信息是否完整。",
        status="in_review",
        assignee_user_id=1,
    )


def _card(create: MagicMock) -> dict[str, str]:
    create.assert_called_once()
    notification = create.call_args.kwargs
    return card_param_map(
        push=push_copy(
            kind=notification["kind"],
            title=notification["title"],
            body=notification["body"],
            payload=notification["payload"],
        ),
        card_template_id="custom-assignment-template",
    )


def test_direct_assignment_card_names_the_issue_and_pending_assignee(
    capture_notification: MagicMock,
) -> None:
    previous_assignee = User(id=1, user_name="旧负责人")
    human = User(id=2, user_name="新负责人")
    actor = User(id=3, user_name="项目经理")
    issue = _issue()

    collaboration_human_assignments.notify_direct_human_assignment(
        _db(previous_assignee, human, actor),
        project=_project(),
        issue=issue,
        human=human,
        actor_user_id=3,
        assignment_id="direct-assignment-1",
    )

    card = _card(capture_notification)
    assert card["kindLabel"] == "任务分配"
    assert card["headline"] == "新任务：修复通知卡片"
    assert card["itemTitle"] == "修复通知卡片"
    assert card["itemKey"] == "2026TEST-12"
    assert card["metaLine"] == "发布看板 · 待人工验收 · 负责人：新负责人"
    assert issue.assignee_user_id == previous_assignee.id
    payload = capture_notification.call_args.kwargs["payload"]
    assert payload["action"] == "open_issue"
    assert payload["actorName"] == "项目经理"


def test_collaboration_dispatch_keeps_personal_task_actions_and_issue_context(
    capture_notification: MagicMock,
) -> None:
    human = User(id=2, user_name="新负责人")
    actor = User(id=3, user_name="项目经理")
    instructions = "只检查卡片元数据。\n将检查结果回复到协作轮次。"

    collaboration_human_assignments.notify_collaboration_human_assignment(
        _db(human, actor),
        project=_project(),
        issue=_issue(),
        human=human,
        actor_user_id=3,
        actor_name="项目经理",
        human_assignment_id="human-work-1",
        dispatch_id="dispatch-1",
        round_id="round-2",
        assignment_id="member-assignment-3",
        task_title="验收本轮通知展示",
        instructions=instructions,
        workflow_stage_id="review-stage",
    )

    card = _card(capture_notification)
    assert card["headline"] == "新任务：验收本轮通知展示"
    assert card["itemTitle"] == "修复通知卡片"
    assert card["itemKey"] == "2026TEST-12"
    assert card["metaLine"] == "发布看板 · 待人工验收 · 负责人：新负责人"
    notification = capture_notification.call_args.kwargs
    assert notification["user_id"] == human.id
    assert notification["actor_user_id"] == 3
    expected_actions = {
        "action": "create_personal_task",
        "projectId": "24",
        "itemId": "2026TEST-12",
        "issueId": "2026TEST-12",
        "dispatchTaskId": "human-work-1",
        "humanAssignmentId": "human-work-1",
        "dispatchId": "dispatch-1",
        "roundId": "round-2",
        "assignmentId": "member-assignment-3",
        "taskTitle": "验收本轮通知展示",
        "instructions": instructions,
        "workflowStageId": "review-stage",
        "idempotencyKey": "human-assignment:human-work-1",
    }
    payload = notification["payload"]
    assert {key: payload[key] for key in expected_actions} == expected_actions


def test_external_assignment_card_uses_the_provider_target_not_the_sparse_index(
    capture_notification: MagicMock,
) -> None:
    human = User(id=2, user_name="新负责人")
    actor = User(id=3, user_name="项目经理")
    project = CloudProject(id="24", name="代码托管看板")
    index = LoopItem(id="123EXT-42", cloud_project_id="24")
    target = NotificationTarget(
        project_id="24",
        project_name="代码托管看板",
        item_id="123EXT-42",
        item_key="123EXT-42",
        item_title="远端 Issue 的标题",
        item_status="等待确认",
        assignee_name="旧负责人",
    )
    db = _db(human, actor)

    collaboration_human_assignments.notify_direct_human_assignment(
        db,
        project=project,
        issue=index,
        human=human,
        actor_user_id=3,
        assignment_id="external-assignment-1",
        task_title="处理远端任务",
        instructions="确认远端 Issue 的验收结果。",
        notification_target=target,
    )

    card = _card(capture_notification)
    assert card["kindLabel"] == "任务分配"
    assert card["headline"] == "新任务：处理远端任务"
    assert card["itemTitle"] == "远端 Issue 的标题"
    assert card["itemKey"] == "123EXT-42"
    assert card["metaLine"] == "代码托管看板 · 等待确认 · 负责人：新负责人"
    # The explicit target replaces the board lookup; only the actor is loaded.
    assert [call.args[0] for call in db.get.call_args_list] == [User]
    assert index.title is None
    assert index.status is None
