# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""CI E2E coverage for the item context every DingTalk notification card needs.

The defect this guards against is a card that names the action but loses the
item it is about: no title, no key, no board status, no assignee, so the meta
line renders as a bare ``·``.

The test drives each production producer against the CI database. Notification
commits use the real background scheduler, delivery finds the recipient through
the Redis-backed private-session index, and the real dispatcher, card builder,
and DingTalk sender perform the HTTP delivery. Only the DingTalk API endpoint
itself is a local recording server, so assertions inspect the request that the
production sender actually emitted instead of a stubbed success value.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.endpoints import loop_item_executions
from app.core import async_utils
from app.core.cache import cache_manager
from app.core.config import settings
from app.core.provider_credentials import store_provider_config
from app.db.session import SessionLocal
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectChatAgent,
)
from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_chat import (
    LoopItemAssign,
    LoopItemExecutionBatchCreate,
    LoopItemExecutionBatchItem,
)
from app.schemas.wework_notification import NotificationCreate
from app.schemas.workspace import CollaborationGroupCreate, CollaborationGroupMember
from app.services.channels.dingtalk.sender import DingTalkRobotSender
from app.services.im.session_service import (
    PRIVATE_SESSION_KEY_PREFIX,
    USER_GLOBAL_NOTIFICATION_PREFIX,
    USER_PRIVATE_SESSIONS_PREFIX,
    im_session_service,
)
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service
from app.services.notification_copy import WEB_LINK_LABEL, WEWORK_LINK_LABEL
from app.services.wework_notifications import send_wework_notification
from app.services.workspaces.service import workspace_service
from shared.utils.crypto import encrypt_sensitive_data
from tests.e2e._dingtalk_card_server import (
    RecordingDingTalkServer,
    RecordingGitLabServer,
)
from tests.utils.collaboration import authorize_project, authorize_project_agent

CHANNEL_ID = 770002
CUSTOM_TEMPLATE_ID = "wegent-ci-e2e-notification-card"
PROJECT_NAME = "通知卡片 E2E 看板"
EXTERNAL_PROJECT_NAME = "外部 Issue 通知看板"
REVIEW_STATUS = "待人工验收"
EXTERNAL_REVIEW_STATUS = "待外部评审"


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


def _board_statuses() -> list[dict[str, str]]:
    return [
        {"id": "inbox", "name": "收集箱"},
        {"id": "in_progress", "name": "处理中"},
        {"id": "in_review", "name": REVIEW_STATUS},
    ]


def _make_project(
    db: Session,
    owner: User,
    *,
    name: str = PROJECT_NAME,
    project_key: str | None = None,
    task_provider: str = "local",
    provider_config: dict[str, object] | None = None,
    statuses: list[dict[str, str]] | None = None,
) -> CloudProject:
    public_id = str(uuid.uuid4())
    metadata: dict[str, Any] = {
        "board_config": {"statuses": statuses or _board_statuses()},
    }
    if task_provider != "local":
        metadata.update(
            {
                "task_provider": task_provider,
                "provider_config": provider_config or {"repository": "wegent/card-e2e"},
            }
        )
    project = CloudProject(
        public_id=public_id,
        project_key=project_key or f"CARDE2E{uuid.uuid4().hex[:4].upper()}",
        name=name,
        description="",
        created_by_user_id=owner.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json=metadata,
        next_item_number=1,
    )
    authorize_project(db, project)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_issue(
    db: Session,
    project: CloudProject,
    author: User,
    *,
    title: str,
    key: str,
    status: str,
    assignee_user_id: int | None = None,
) -> LoopItem:
    item = LoopItem(
        id=str(uuid.uuid4()),
        name=key,
        cloud_project_id=project.id,
        title=title,
        description="检查卡片是否携带完整的事项字段。",
        status=status,
        priority="none",
        created_by_user_id=author.id,
        assignee_user_id=assignee_user_id,
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


async def _connect_dingtalk(db: Session, user: User) -> IMPrivateSession:
    """Register a real Redis session so delivery must discover the recipient."""

    session = await im_session_service.get_or_create_private_session(
        db,
        user_id=user.id,
        channel_type="dingtalk",
        channel_id=CHANNEL_ID,
        conversation_id=f"card-e2e-{uuid.uuid4().hex}",
        sender_id=f"card-e2e-sender-{user.id}",
        proactive_recipient_id=f"staff-{user.id}",
        display_name="Card E2E",
    )
    await im_session_service.enable_global_notification(db, session=session)
    return session


def _notification(
    db: Session,
    *,
    user_id: int,
    kind: str,
) -> WeworkNotification:
    return (
        db.query(WeworkNotification)
        .filter(
            WeworkNotification.user_id == user_id,
            WeworkNotification.kind == kind,
        )
        .one()
    )


def _assert_card(
    request: dict[str, Any],
    *,
    recipient: User,
    kind_label: str,
    tone: str,
    headline: str,
    item_title: str,
    item_key: str,
    project: CloudProject,
    status: str,
    assignee_name: str,
    item_id: str,
) -> None:
    """Assert the request carries every field the card template reads."""

    assert request["cardTemplateId"] == CUSTOM_TEMPLATE_ID
    assert request["openSpaceId"] == f"dtv1.card//IM_ROBOT.staff-{recipient.id}"
    params = request["cardData"]["cardParamMap"]
    assert params["kindLabel"] == kind_label
    assert params["tone"] == tone
    assert params["headline"] == headline
    assert params["itemTitle"] == item_title
    assert params["itemKey"] == item_key

    meta_parts = params["metaLine"].split(" · ")
    assert all(part.strip() for part in meta_parts), params["metaLine"]
    assert meta_parts == [
        project.name,
        status,
        f"负责人：{assignee_name}",
    ], f"unexpected metaLine: {params['metaLine']!r}"

    web_url = (
        f"{settings.FRONTEND_URL.rstrip('/')}/collaboration/{project.id}"
        f"/issues/{item_id}"
    )
    wework_url = f"wework://boards/{project.id}/issues/{item_id}"
    assert params["primaryLabel"] == WEB_LINK_LABEL
    assert params["primaryUrl"] == web_url
    assert params["secondaryLabel"] == WEWORK_LINK_LABEL
    assert params["secondaryUrl"] == wework_url


def _make_manager_agent(
    db: Session,
    project: CloudProject,
    owner: User,
) -> ProjectChatAgent:
    agent = ProjectChatAgent(
        id=f"manager-{uuid.uuid4().hex}",
        cloud_project_id=str(project.id),
        title="Notification Manager",
        name="Notification Manager",
        status="active",
        created_by_user_id=owner.id,
        metadata_json={"wegent_team_id": 9001},
    )
    authorize_project_agent(db, agent)
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


def _make_manager_execution(
    db: Session,
    *,
    project: CloudProject,
    issue: LoopItem,
    manager: ProjectChatAgent,
    owner: User,
    group: dict[str, Any],
) -> tuple[LoopItemExecution, str, str]:
    dispatch_id = f"collaboration-group:{uuid.uuid4().hex}"
    assignment_key = uuid.uuid4().hex
    runtime_task_id = f"manager-runtime-{uuid.uuid4().hex}"
    manager_execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=str(project.id),
        agent_id="",
        executor_owner_user_id=owner.id,
        assigner_user_id=owner.id,
        runtime_device_id=f"manager-device-{uuid.uuid4().hex}",
        runtime_instance_id=f"manager-instance-{uuid.uuid4().hex}",
        runtime_task_id=runtime_task_id,
        execution_environment="cloud",
        execution_payload=json.dumps(
            {
                "runtime_selection": {
                    "executor_kind": "collaboration_group_dispatch",
                },
                "origin_context": {
                    "dispatch_kind": "collaboration_group",
                    "dispatch_role": "manager",
                    "manager_agent_id": manager.id,
                    "dispatch_id": dispatch_id,
                    "run_id": f"collaboration-group:{assignment_key}",
                    "collaboration_group_id": str(group["id"]),
                    "collaboration_group": group,
                    "assignment_key": assignment_key,
                },
            }
        ),
        status="running",
    )
    db.add(manager_execution)
    db.commit()
    db.refresh(manager_execution)
    return (
        manager_execution,
        dispatch_id,
        f"{runtime_task_id}-manager-initial",
    )


async def _delete_sessions(
    *,
    sessions: list[IMPrivateSession],
    user_ids: list[int],
) -> None:
    client = await cache_manager._get_client()
    try:
        keys = [
            f"{PRIVATE_SESSION_KEY_PREFIX}{session.session_key}" for session in sessions
        ]
        keys.extend(
            f"{USER_GLOBAL_NOTIFICATION_PREFIX}{user_id}" for user_id in user_ids
        )
        if keys:
            await client.delete(*keys)
        for session in sessions:
            await client.zrem(
                f"{USER_PRIVATE_SESSIONS_PREFIX}{session.user_id}",
                session.session_key,
            )
    finally:
        await client.aclose()


def _cleanup(
    db: Session,
    *,
    user_ids: list[int],
    project_ids: list[str],
    device_names: list[str],
) -> None:
    if not user_ids:
        return
    db.query(WeworkNotification).filter(
        WeworkNotification.user_id.in_(user_ids)
    ).delete(synchronize_session=False)
    if project_ids:
        item_ids = [
            row.id
            for row in db.query(LoopItem.id)
            .filter(LoopItem.cloud_project_id.in_(project_ids))
            .all()
        ]
        if item_ids:
            db.query(LoopItemTaskBinding).filter(
                LoopItemTaskBinding.loop_item_id.in_(item_ids)
            ).delete(synchronize_session=False)
            db.query(ProjectChatMessage).filter(
                ProjectChatMessage.task_id.in_(item_ids)
            ).delete(synchronize_session=False)
        db.query(LoopItemExecution).filter(
            LoopItemExecution.cloud_project_id.in_(project_ids)
        ).delete(synchronize_session=False)
        db.query(ProjectChatAgent).filter(
            ProjectChatAgent.cloud_project_id.in_(project_ids)
        ).delete(synchronize_session=False)
        db.query(LoopItem).filter(LoopItem.cloud_project_id.in_(project_ids)).delete(
            synchronize_session=False
        )
        db.query(ResourceMember).filter(
            ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
            ResourceMember.resource_id.in_([int(pid) for pid in project_ids]),
        ).delete(synchronize_session=False)
        db.query(CloudProject).filter(CloudProject.id.in_(project_ids)).delete(
            synchronize_session=False
        )
    if device_names:
        db.query(Kind).filter(Kind.name.in_(device_names)).delete(
            synchronize_session=False
        )
    for user_id in user_ids:
        kinds = (
            db.query(Kind)
            .filter(
                Kind.kind.in_(("CollaborationWorkspace", "CollaborationGroup")),
                Kind.user_id == user_id,
            )
            .all()
        )
        for kind in kinds:
            db.query(ResourceMember).filter(
                ResourceMember.resource_type == kind.kind,
                ResourceMember.resource_id == kind.id,
            ).delete(synchronize_session=False)
            db.delete(kind)
        user = db.get(User, user_id)
        if user is not None:
            db.delete(user)
    db.query(Kind).filter_by(id=CHANNEL_ID, user_id=0, kind="Messager").delete()
    db.commit()


async def run() -> None:
    server = RecordingDingTalkServer()
    server.start()
    gitlab_server = RecordingGitLabServer(
        title="远端 Issue 的标题",
        description="确认远端 Issue 的验收结果。",
        labels=["wegent:status:in_review"],
    )
    gitlab_server.start()
    original_base_url = DingTalkRobotSender.BASE_URL
    original_main_loop = async_utils.get_main_event_loop()
    DingTalkRobotSender.BASE_URL = server.base_url
    async_utils.set_main_event_loop(asyncio.get_running_loop())

    db = SessionLocal()
    created_user_ids: list[int] = []
    created_project_ids: list[str] = []
    device_names: list[str] = []
    sessions: list[IMPrivateSession] = []

    try:
        owner = _make_user(db, "owner")
        direct_assignee = _make_user(db, "direct")
        project_recipient = _make_user(db, "project")
        collaboration_member = _make_user(db, "collaboration")
        external_assignee = _make_user(db, "external")
        outsider = _make_user(db, "outsider")
        created_user_ids.extend(
            [
                owner.id,
                direct_assignee.id,
                project_recipient.id,
                collaboration_member.id,
                external_assignee.id,
                outsider.id,
            ]
        )

        project = _make_project(db, owner)
        created_project_ids.append(str(project.id))
        for user in (
            direct_assignee,
            project_recipient,
            collaboration_member,
        ):
            _add_member(db, project, user, BaseRole.Developer)
        db.commit()
        _ensure_channel(db)
        for user in (direct_assignee, project_recipient, collaboration_member):
            sessions.append(await _connect_dingtalk(db, user))

        # 1. Direct human assignment.
        direct_issue = _make_issue(
            db,
            project,
            owner,
            title="修复钉钉通知卡片字段",
            key="CARDE2E-12",
            status="in_review",
        )
        cards_before = len(server.cards())
        loop_item_service.assign(
            db,
            project_id=int(project.id),
            item_id=direct_issue.id,
            user_id=owner.id,
            values=LoopItemAssign(
                version=direct_issue.version,
                assignee_type="user",
                assignee_id=str(direct_assignee.id),
            ),
        )
        direct_notification = _notification(
            db,
            user_id=direct_assignee.id,
            kind="issue_dispatch_assignment",
        )
        request = await server.wait_for_card(
            after=cards_before,
            item_key="CARDE2E-12",
        )
        _assert_card(
            request,
            recipient=direct_assignee,
            kind_label="任务分配",
            tone="blue",
            headline="新任务：修复钉钉通知卡片字段",
            item_title=direct_issue.title,
            item_key="CARDE2E-12",
            project=project,
            status=REVIEW_STATUS,
            assignee_name=direct_assignee.user_name,
            item_id=direct_issue.id,
        )
        assert direct_notification.payload["itemTitle"] == direct_issue.title
        assert direct_notification.payload["assigneeName"] == direct_assignee.user_name

        # 2. Project-sourced message.
        project_issue = _make_issue(
            db,
            project,
            owner,
            title="确认通知卡片验收",
            key="CARDE2E-13",
            status="in_review",
            assignee_user_id=project_recipient.id,
        )
        cards_before = len(server.cards())
        message = send_wework_notification(
            db,
            user_id=owner.id,
            values=NotificationCreate(
                project_id=int(project.id),
                item_id=project_issue.id,
                recipient_user_id=project_recipient.id,
                title="请确认验收结果",
                body="看板事项需要你确认。",
            ),
        )
        request = await server.wait_for_card(
            after=cards_before,
            item_key="CARDE2E-13",
        )
        _assert_card(
            request,
            recipient=project_recipient,
            kind_label="任务通知",
            tone="gray",
            headline="请确认验收结果",
            item_title=project_issue.title,
            item_key="CARDE2E-13",
            project=project,
            status=REVIEW_STATUS,
            assignee_name=project_recipient.user_name,
            item_id=project_issue.id,
        )
        assert message.payload["itemKey"] == "CARDE2E-13"

        # 3. Human-led collaboration coordination.
        sessions.append(await _connect_dingtalk(db, owner))
        group = workspace_service.create_project_collaboration_group(
            db,
            int(project.id),
            owner.id,
            CollaborationGroupCreate(
                name=f"card-e2e-group-{uuid.uuid4().hex[:8]}",
                instructions="拆解任务并验收结果。",
                leader=CollaborationGroupMember(
                    kind="human",
                    id=owner.id,
                    name=owner.user_name,
                ),
                members=[
                    CollaborationGroupMember(
                        kind="human",
                        id=owner.id,
                        name=owner.user_name,
                    ),
                    CollaborationGroupMember(
                        kind="human",
                        id=collaboration_member.id,
                        name=collaboration_member.user_name,
                    ),
                ],
                stages=[{"id": "implementation", "name": "Implementation"}],
            ),
        )
        cards_before = len(server.cards())
        coordinated = loop_item_service.create(
            db,
            int(project.id),
            owner.id,
            LoopItemCreate(
                title="协调本轮通知卡片",
                description="先拆解再分配。",
                status="in_progress",
                assignee_group_id=str(group["id"]),
            ),
        )
        leader_notification = _notification(
            db,
            user_id=owner.id,
            kind="assignment",
        )
        request = await server.wait_for_card(
            after=cards_before,
            item_key=coordinated.id,
        )
        _assert_card(
            request,
            recipient=owner,
            kind_label="任务分配",
            tone="blue",
            headline="请协调：协调本轮通知卡片",
            item_title=coordinated.title,
            item_key=coordinated.id,
            project=project,
            status="处理中",
            assignee_name=owner.user_name,
            item_id=coordinated.id,
        )
        assert leader_notification.payload["collaborationGroupId"] == str(group["id"])

        # 4. Collaboration member dispatch through the production batch endpoint.
        manager = _make_manager_agent(db, project, owner)
        device_name = f"manager-device-{uuid.uuid4().hex}"
        device_names.append(device_name)
        db.add(
            Kind(
                kind="Device",
                namespace="default",
                name=device_name,
                user_id=owner.id,
                is_active=True,
                json={"spec": {"deviceType": "cloud"}},
            )
        )
        collaboration_group = {
            "id": f"group-{uuid.uuid4().hex}",
            "name": "Notification group",
            "leader": {"kind": "agent", "id": manager.id},
            "members": [
                {"kind": "agent", "id": manager.id},
                {
                    "kind": "human",
                    "id": str(collaboration_member.id),
                    "name": collaboration_member.user_name,
                },
            ],
        }
        assignment_issue = _make_issue(
            db,
            project,
            owner,
            title="协作成员通知卡片",
            key="CARDE2E-14",
            status="in_progress",
        )
        manager_execution, dispatch_id, manager_runtime_task_id = (
            _make_manager_execution(
                db,
                project=project,
                issue=assignment_issue,
                manager=manager,
                owner=owner,
                group=collaboration_group,
            )
        )
        manager_execution.runtime_device_id = device_name
        assignment_issue.metadata_json = {
            "collaboration_group": collaboration_group,
            "collaboration_group_assignment_key": str(
                manager_execution.runtime_origin_context["assignment_key"]
            ),
        }
        db.commit()

        cards_before = len(server.cards())
        loop_item_executions.enqueue_execution_batch(
            int(project.id),
            LoopItemExecutionBatchCreate(
                loop_item_id=assignment_issue.id,
                dispatch_id=dispatch_id,
                round_id="round-card-e2e",
                manager_runtime_task_id=manager_runtime_task_id,
                manager_agent_id=manager.id,
                items=[
                    LoopItemExecutionBatchItem(
                        assignment_id="member-notification",
                        title="验收通知卡片",
                        instructions="检查标题、编号、状态、负责人和两个链接。",
                        assignee_type="human",
                        assignee_id=str(collaboration_member.id),
                    )
                ],
            ),
            db,
            owner,
        )
        member_notification = _notification(
            db,
            user_id=collaboration_member.id,
            kind="issue_dispatch_assignment",
        )
        request = await server.wait_for_card(
            after=cards_before,
            item_key="CARDE2E-14",
        )
        _assert_card(
            request,
            recipient=collaboration_member,
            kind_label="任务分配",
            tone="blue",
            headline="新任务：验收通知卡片",
            item_title=assignment_issue.title,
            item_key="CARDE2E-14",
            project=project,
            status="处理中",
            assignee_name=collaboration_member.user_name,
            item_id=assignment_issue.id,
        )
        assert member_notification.payload["roundId"] == "round-card-e2e"

        # 5. An external Issue uses the provider's title and localized status
        #    instead of the sparse local index row.
        external_project = _make_project(
            db,
            owner,
            name=EXTERNAL_PROJECT_NAME,
            project_key="123EXT",
            task_provider="gitlab",
            statuses=[
                {"id": "inbox", "name": "收集箱"},
                {"id": "in_progress", "name": "处理中"},
                {"id": "in_review", "name": EXTERNAL_REVIEW_STATUS},
            ],
            provider_config=store_provider_config(
                "gitlab",
                {
                    "repository": "wegent/card-e2e",
                    "api_base": gitlab_server.api_base,
                    "token": "card-e2e-provider-token",
                },
            ),
        )
        created_project_ids.append(str(external_project.id))
        _add_member(db, external_project, external_assignee, BaseRole.Developer)
        db.commit()
        sessions.append(await _connect_dingtalk(db, external_assignee))
        external_item_id = f"{external_project.project_key}-1"
        external_title = "远端 Issue 的标题"

        cards_before = len(server.cards())
        external_loop_item_provider.assign(
            db,
            external_item_id,
            owner.id,
            LoopItemAssign(
                version=1,
                assignee_type="user",
                assignee_id=str(external_assignee.id),
            ),
        )
        external_notification = _notification(
            db,
            user_id=external_assignee.id,
            kind="issue_dispatch_assignment",
        )
        request = await server.wait_for_card(
            after=cards_before,
            item_key=external_item_id,
        )
        _assert_card(
            request,
            recipient=external_assignee,
            kind_label="任务分配",
            tone="blue",
            headline=f"新任务：{external_title}",
            item_title=external_title,
            item_key=external_item_id,
            project=external_project,
            status=EXTERNAL_REVIEW_STATUS,
            assignee_name=external_assignee.user_name,
            item_id=external_item_id,
        )
        assert external_notification.payload["itemTitle"] == external_title
        assert [(method, path) for method, path, _body in gitlab_server.requests] == [
            ("GET", "/api/v4/projects/wegent%2Fcard-e2e/issues/1"),
            ("PUT", "/api/v4/projects/wegent%2Fcard-e2e/issues/1"),
        ]

        # 6. A non-member cannot send a project notification, and the rejected
        #    request must not create an inbox row or a card.
        cards_before = len(server.cards())
        notifications_before = (
            db.query(WeworkNotification)
            .filter(WeworkNotification.user_id == project_recipient.id)
            .count()
        )
        try:
            send_wework_notification(
                db,
                user_id=outsider.id,
                values=NotificationCreate(
                    project_id=int(project.id),
                    item_id=project_issue.id,
                    recipient_user_id=project_recipient.id,
                    title="不应发送的通知",
                    body="非项目成员不能发送。",
                ),
            )
        except HTTPException as error:
            assert error.status_code in {403, 404}
        else:
            raise AssertionError("Non-member project notification was accepted")
        db.rollback()
        assert len(server.cards()) == cards_before
        assert (
            db.query(WeworkNotification)
            .filter(WeworkNotification.user_id == project_recipient.id)
            .count()
            == notifications_before
        )
    finally:
        try:
            await _delete_sessions(sessions=sessions, user_ids=created_user_ids)
        finally:
            db.close()
            cleanup_db = SessionLocal()
            try:
                _cleanup(
                    cleanup_db,
                    user_ids=created_user_ids,
                    project_ids=created_project_ids,
                    device_names=device_names,
                )
            finally:
                cleanup_db.close()
            DingTalkRobotSender.BASE_URL = original_base_url
            async_utils.set_main_event_loop(original_main_loop)
            server.stop()
            gitlab_server.stop()


if __name__ == "__main__":
    asyncio.run(run())
    print("DingTalk notification card context E2E passed")
