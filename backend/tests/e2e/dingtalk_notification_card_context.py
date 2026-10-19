# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""CI E2E coverage for the item context every DingTalk notification card needs.

The defect this guards against is a card that names the action but loses the
item it is about: no title, no key, no board status, no assignee, so the meta
line renders as a bare ``·``.

This test uses the migrated CI database. It drives the real notification
producers, reads the rows they persist, and renders each row through the real
dispatcher and card builder. Only the DingTalk HTTP transport and the task
scheduler hop are substituted, so the producer, the stored payload, the push
copy, the channel config, and the card parameter map all run together.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.core import async_utils
from app.db.session import SessionLocal
from app.models.delivery import CloudProject, LoopItem
from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_chat import LoopItemAssign
from app.schemas.wework_notification import NotificationCreate
from app.schemas.workspace import CollaborationGroupCreate, CollaborationGroupMember
from app.services.channels.dingtalk.sender import DingTalkRobotSender
from app.services.im.notification_dispatcher import im_notification_dispatcher
from app.services.im.session_service import im_session_service
from app.services.loop_items.service import loop_item_service
from app.services.notification_copy import push_copy
from app.services.wework_notifications import (
    notification_links,
    send_wework_notification,
)
from app.services.workspaces.service import workspace_service
from shared.utils.crypto import encrypt_sensitive_data
from tests.utils.collaboration import authorize_project

CHANNEL_ID = 770002
CUSTOM_TEMPLATE_ID = "wegent-ci-e2e-notification-card"
PROJECT_NAME = "通知卡片 E2E 看板"
ISSUE_TITLE = "修复钉钉通知卡片字段"
ISSUE_KEY = "CARDE2E-12"
REVIEW_STATUS = "待人工验收"


def _make_user(db: Session, label: str) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(
        user_name=f"card-e2e-{label}-{suffix}",
        password_hash="unused",
        email=f"card-e2e-{label}-{suffix}@example.com",
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _add_member(db: Session, project: CloudProject, user: User, role: BaseRole) -> None:
    db.add(
        ResourceMember.create(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=int(project.id),
            entity_id=str(user.id),
            role=role.value,
            status=MemberStatus.APPROVED.value,
        )
    )
    db.flush()


def _make_project(db: Session, owner: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"CARDE2E{uuid.uuid4().hex[:4].upper()}",
        name=PROJECT_NAME,
        description="",
        created_by_user_id=owner.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={
            "board_config": {
                "statuses": [
                    {"id": "inbox", "name": "收集箱"},
                    {"id": "in_progress", "name": "处理中"},
                    {"id": "in_review", "name": REVIEW_STATUS},
                ]
            }
        },
    )
    authorize_project(db, project)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_issue(db: Session, project: CloudProject, author: User) -> LoopItem:
    item = LoopItem(
        id=str(uuid.uuid4()),
        name=ISSUE_KEY,
        cloud_project_id=project.id,
        title=ISSUE_TITLE,
        description="检查卡片是否携带完整的事项字段。",
        status="in_review",
        created_by_user_id=author.id,
        metadata_json={},
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _ensure_channel(db: Session) -> None:
    """Replace this test's dedicated channel so every run starts from scratch."""

    db.query(Kind).filter_by(id=CHANNEL_ID, user_id=0, kind="Messager").delete()
    db.add(
        Kind(
            id=CHANNEL_ID,
            user_id=0,
            kind="Messager",
            name=f"dingtalk-{CHANNEL_ID}",
            namespace="system",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Messager",
                "metadata": {
                    "name": f"dingtalk-{CHANNEL_ID}",
                    "namespace": "system",
                },
                "spec": {
                    "channelType": "dingtalk",
                    "isEnabled": True,
                    "config": {
                        "client_id": "card-e2e-client",
                        "client_secret": encrypt_sensitive_data(
                            "card-e2e-client-Secret"
                        ),
                        "notification_card": {"template_id": CUSTOM_TEMPLATE_ID},
                    },
                },
            },
            is_active=True,
        )
    )
    db.commit()


async def _render_card(
    db: Session,
    *,
    notification: WeworkNotification,
    cards: list[dict[str, Any]],
    recipient: User,
) -> dict[str, str]:
    """Push one stored notification through the production dispatcher."""

    conversation_id = f"card-e2e-{uuid.uuid4().hex}"
    session = IMPrivateSession(
        session_key=im_session_service.build_session_key(
            user_id=recipient.id,
            channel_type="dingtalk",
            channel_id=CHANNEL_ID,
            conversation_id=conversation_id,
        ),
        user_id=recipient.id,
        channel_type="dingtalk",
        channel_id=CHANNEL_ID,
        conversation_id=conversation_id,
        sender_id=f"card-e2e-sender-{recipient.id}",
        proactive_recipient_id=f"staff-{recipient.id}",
        display_name="Card E2E",
    )
    push = push_copy(
        kind=notification.kind,
        title=notification.title,
        body=notification.body,
        payload=notification.payload,
    )
    before = len(cards)
    result = await im_notification_dispatcher.send_notification(
        db,
        session,
        push,
        links=notification_links(notification),
    )
    assert result.get("success") is True, result
    assert len(cards) == before + 1, "DingTalk card was not rendered"
    assert cards[-1]["card_template_id"] == CUSTOM_TEMPLATE_ID
    return cards[-1]["params"]


def _assert_card_names_the_item(
    card: dict[str, str],
    *,
    kind_label: str,
    tone: str,
    title: str,
    key: str,
    status: str,
    assignee: User,
) -> None:
    """Every card field the defect dropped must be present and meaningful."""

    assert card["kindLabel"] == kind_label
    assert card["tone"] == tone
    assert card["headline"]
    assert card["itemTitle"] == title
    assert card["itemKey"] == key
    parts = card["metaLine"].split(" · ")
    assert card["metaLine"], "card lost its project, status and assignee"
    assert all(part.strip() for part in parts), card["metaLine"]
    assert parts == [PROJECT_NAME, status, f"负责人：{assignee.user_name}"]
    assert card["primaryUrl"].startswith(("http://", "https://"))
    assert card["secondaryUrl"].startswith("wework://")


async def run() -> None:
    cards: list[dict[str, Any]] = []
    created_user_ids: list[int] = []
    created_project_ids: list[str] = []

    async def _record_card(
        _sender: DingTalkRobotSender,
        user_id: str,
        card_template_id: str,
        card_param_map: dict[str, str],
        open_space_id: str | None = None,
        preview: str = "",
        mention_user_ids: Any = None,
    ) -> dict[str, Any]:
        """Stand in for the DingTalk HTTP call while keeping the card contract."""

        del open_space_id, mention_user_ids
        cards.append(
            {
                "user_id": user_id,
                "card_template_id": card_template_id,
                "preview": preview,
                "params": dict(card_param_map),
            }
        )
        return {"success": True, "result": {"processQueryKey": "card-e2e"}}

    original_send_card = DingTalkRobotSender.send_card
    original_schedule = async_utils.schedule_async_task
    DingTalkRobotSender.send_card = _record_card
    # The producers persist the row; this test drives delivery itself so the
    # assertion does not depend on the socket loop or Redis session state.
    async_utils.schedule_async_task = lambda *_args, **_kwargs: None
    db = SessionLocal()
    try:
        owner = _make_user(db, "owner")
        assignee = _make_user(db, "assignee")
        created_user_ids.extend([owner.id, assignee.id])
        project = _make_project(db, owner)
        created_project_ids.append(str(project.id))
        _add_member(db, project, assignee, BaseRole.Developer)
        db.commit()
        _ensure_channel(db)

        # 1. Direct human assignment: the producer that previously dropped
        #    every board field except the ids.
        issue = _make_issue(db, project, owner)
        loop_item_service.assign(
            db,
            project_id=int(project.id),
            item_id=issue.id,
            user_id=owner.id,
            values=LoopItemAssign(
                version=issue.version,
                assignee_type="user",
                assignee_id=str(assignee.id),
            ),
        )
        assignment = (
            db.query(WeworkNotification)
            .filter(
                WeworkNotification.user_id == assignee.id,
                WeworkNotification.kind == "issue_dispatch_assignment",
            )
            .one()
        )
        card = await _render_card(
            db,
            notification=assignment,
            cards=cards,
            recipient=assignee,
        )
        _assert_card_names_the_item(
            card,
            kind_label="任务分配",
            tone="blue",
            title=ISSUE_TITLE,
            key=ISSUE_KEY,
            status=REVIEW_STATUS,
            assignee=assignee,
        )
        assert card["headline"] == f"新任务：{ISSUE_TITLE}"
        assert assignment.payload["itemId"] == issue.id
        assert assignment.payload["itemTitle"] == ISSUE_TITLE

        # 2. A project-sourced message: the API path that used to persist only
        #    the ids and leave the card with no context.
        message = send_wework_notification(
            db,
            user_id=owner.id,
            values=NotificationCreate(
                project_id=int(project.id),
                item_id=issue.id,
                recipient_user_id=assignee.id,
                title="请确认验收结果",
                body="看板事项需要你确认。",
            ),
        )
        card = await _render_card(
            db,
            notification=message,
            cards=cards,
            recipient=assignee,
        )
        _assert_card_names_the_item(
            card,
            kind_label="任务通知",
            tone="gray",
            title=ISSUE_TITLE,
            key=ISSUE_KEY,
            status=REVIEW_STATUS,
            assignee=assignee,
        )
        assert card["detail"] == "看板事项需要你确认。"
        assert message.payload["itemKey"] == ISSUE_KEY

        # 3. Human-led collaboration group: its leader notification used to
        #    carry the ids only, so the card again had no item to name.
        group = workspace_service.create_project_collaboration_group(
            db,
            int(project.id),
            owner.id,
            CollaborationGroupCreate(
                name=f"card-e2e-group-{uuid.uuid4().hex[:8]}",
                instructions="拆解任务并验收结果。",
                leader=CollaborationGroupMember(
                    kind="human", id=owner.id, name=owner.user_name
                ),
                members=[
                    CollaborationGroupMember(
                        kind="human", id=owner.id, name=owner.user_name
                    ),
                    CollaborationGroupMember(
                        kind="human", id=assignee.id, name=assignee.user_name
                    ),
                ],
                stages=[{"id": "implementation", "name": "Implementation"}],
            ),
        )
        coordinated = loop_item_service.create(
            db,
            int(project.id),
            owner.id,
            LoopItemCreate(
                title="协调本轮通知卡片",
                description="先拆解再分配。",
                assignee_group_id=str(group["id"]),
            ),
        )
        leader_notification = (
            db.query(WeworkNotification)
            .filter(
                WeworkNotification.user_id == owner.id,
                WeworkNotification.kind == "assignment",
            )
            .one()
        )
        card = await _render_card(
            db,
            notification=leader_notification,
            cards=cards,
            recipient=owner,
        )
        _assert_card_names_the_item(
            card,
            kind_label="任务分配",
            tone="blue",
            title=coordinated.title,
            key=coordinated.id,
            status="处理中",
            assignee=owner,
        )
    finally:
        DingTalkRobotSender.send_card = original_send_card
        async_utils.schedule_async_task = original_schedule
        db.close()
        _cleanup_session(created_user_ids, created_project_ids)


def _cleanup_session(
    created_user_ids: list[int], created_project_ids: list[str]
) -> None:
    """Remove the fixtures with a fresh session after the assertions ran."""

    db = SessionLocal()
    try:
        _cleanup(db, created_user_ids, created_project_ids)
    finally:
        db.close()


def _cleanup(
    db: Session,
    created_user_ids: list[int],
    project_ids: list[str],
) -> None:
    if not created_user_ids:
        return
    if project_ids:
        for row in (
            db.query(WeworkNotification)
            .filter(WeworkNotification.user_id.in_(created_user_ids))
            .all()
        ):
            db.delete(row)
        for item in (
            db.query(LoopItem).filter(LoopItem.cloud_project_id.in_(project_ids)).all()
        ):
            db.delete(item)
        for member in (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id.in_([int(pid) for pid in project_ids]),
            )
            .all()
        ):
            db.delete(member)
        for project in (
            db.query(CloudProject).filter(CloudProject.id.in_(project_ids)).all()
        ):
            db.delete(project)
        db.flush()
    for user_id in created_user_ids:
        workspace_kinds = (
            db.query(Kind)
            .filter(
                Kind.kind.in_(("CollaborationWorkspace", "CollaborationGroup")),
                Kind.user_id == user_id,
            )
            .all()
        )
        for kind in workspace_kinds:
            db.query(ResourceMember).filter(
                ResourceMember.resource_type == kind.kind,
                ResourceMember.resource_id == kind.id,
            ).delete()
            db.delete(kind)
        user = db.get(User, user_id)
        if user is not None:
            db.delete(user)
    db.commit()


if __name__ == "__main__":
    asyncio.run(run())
    print("DingTalk notification card context E2E passed")
