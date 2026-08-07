# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for the shared project chat persistence service."""

import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.ws.device_namespace import _project_chat_runtime_event_sync
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.kind import Kind
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.project_chat import (
    ProjectChatAgentCreate,
    ProjectChatAgentFailure,
    ProjectChatAgentStart,
    ProjectChatSend,
    ProjectChatSubscribe,
)
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import project_chat_service


def create_project(test_db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"CHAT{uuid.uuid4().hex[:6].upper()}",
        name="Project chat",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    agent = ProjectChatAgent(
        id="12",
        cloud_project_id=project.id,
        title="Code Reviewer",
        name="Code Reviewer",
        status="active",
        metadata_json={"runtime": "codex"},
    )
    test_db.add(agent)
    test_db.commit()
    return project


def make_device(
    db: Session, user: User, device_id: str, device_type: str = "cloud"
) -> Kind:
    device = Kind(
        kind="Device",
        name=device_id,
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={
            "spec": {"deviceType": device_type},
            "metadata": {"name": device_id},
        },
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def test_list_agents_accepts_mysql_unset_datetime_sentinel(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    agent = test_db.query(ProjectChatAgent).filter(ProjectChatAgent.id == "12").one()
    agent.deleted_at = datetime(1970, 1, 1, 0, 0, 1)
    test_db.commit()

    agents = project_chat_service.list_agents(
        test_db, user_id=test_user.id, project_id=project.id
    )

    assert [item.id for item in agents] == ["12"]


def test_project_supports_multiple_robots_with_execution_config(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    make_device(test_db, test_user, "local-dev-1", "local")
    make_device(test_db, test_user, "cloud-dev-1", "cloud")

    first = project_chat_service.create_agent(
        test_db,
        user_id=test_user.id,
        project_id=project.id,
        request=ProjectChatAgentCreate(
            name="Local Builder",
            execution_environment="local",
            execution_mode="manual_approval",
            visibility="public",
            execution_device_id="local-dev-1",
        ),
    )
    second = project_chat_service.create_agent(
        test_db,
        user_id=test_user.id,
        project_id=project.id,
        request=ProjectChatAgentCreate(
            name="Cloud Reviewer",
            execution_environment="cloud",
            execution_mode="auto",
            visibility="private",
            execution_device_id="cloud-dev-1",
        ),
    )

    agents = project_chat_service.list_agents(
        test_db, user_id=test_user.id, project_id=project.id
    )
    by_id = {agent.id: agent for agent in agents}

    assert set(by_id) == {"12", first.id, second.id}
    assert by_id[first.id].execution_environment == "local"
    assert by_id[first.id].execution_mode == "manual_approval"
    assert by_id[first.id].visibility == "public"
    assert by_id[second.id].execution_environment == "cloud"
    assert by_id[second.id].execution_mode == "auto"
    assert by_id[second.id].visibility == "private"
    assert by_id[second.id].created_by_user_id == test_user.id


def test_list_agents_filters_visibility_for_other_members(
    test_db: Session, test_user: User
) -> None:
    from app.models.resource_member import MemberStatus, ResourceMember
    from app.models.share_link import ResourceType
    from app.schemas.base_role import BaseRole

    project = create_project(test_db, test_user)
    make_device(test_db, test_user, "local-dev-2", "local")
    private_bot = project_chat_service.create_agent(
        test_db,
        user_id=test_user.id,
        project_id=project.id,
        request=ProjectChatAgentCreate(
            name="Private",
            visibility="private",
            execution_device_id="local-dev-2",
        ),
    )
    admin_bot = project_chat_service.create_agent(
        test_db,
        user_id=test_user.id,
        project_id=project.id,
        request=ProjectChatAgentCreate(
            name="Admin",
            visibility="creator_admin",
            execution_device_id="local-dev-2",
        ),
    )
    public_bot = project_chat_service.create_agent(
        test_db,
        user_id=test_user.id,
        project_id=project.id,
        request=ProjectChatAgentCreate(
            name="Public",
            visibility="public",
            execution_device_id="local-dev-2",
        ),
    )
    member = User(
        user_name="member",
        password_hash="unused",
        email="member@example.com",
        is_active=True,
    )
    admin = User(
        user_name="project_admin",
        password_hash="unused",
        email="project_admin@example.com",
        is_active=True,
    )
    test_db.add_all([member, admin])
    test_db.flush()
    test_db.add_all(
        [
            ResourceMember(
                resource_type=ResourceType.CLOUD_PROJECT.value,
                resource_id=project.id,
                entity_type="user",
                entity_id=str(member.id),
                role=BaseRole.Developer.value,
                status=MemberStatus.APPROVED.value,
            ),
            ResourceMember(
                resource_type=ResourceType.CLOUD_PROJECT.value,
                resource_id=project.id,
                entity_type="user",
                entity_id=str(admin.id),
                role=BaseRole.Maintainer.value,
                status=MemberStatus.APPROVED.value,
            ),
        ]
    )
    test_db.commit()

    member_view = {
        agent.id
        for agent in project_chat_service.list_agents(
            test_db, user_id=member.id, project_id=project.id
        )
    }
    assert member_view == {public_bot.id}

    admin_view = {
        agent.id
        for agent in project_chat_service.list_agents(
            test_db, user_id=admin.id, project_id=project.id
        )
    }
    assert {public_bot.id, admin_bot.id, "12"} <= admin_view
    assert private_bot.id not in admin_view


def test_send_is_idempotent_and_assigns_durable_sequence(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    request = ProjectChatSend(
        clientMessageId=str(uuid.uuid4()),
        projectId=project.id,
        content="Please review this",
        mentions=[
            {
                "type": "agent",
                "id": "12",
                "label": "Code Reviewer",
            }
        ],
    )

    first = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=request,
    )
    repeated = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=request,
    )

    assert first.created is True
    assert repeated.created is False
    assert repeated.message.message_id == first.message.message_id
    assert first.message.sequence_number > 0
    assert first.message.metadata["mentions"][0]["id"] == "12"


def test_send_and_agent_response_record_requested_model_metadata(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    trigger = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="Review with a specific model",
            mentions=[{"type": "agent", "id": "12", "label": "Code Reviewer"}],
            model="gpt-5.5-codex",
        ),
    ).message
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            triggerMessageId=trigger.message_id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-1",
            model="gpt-5.5-codex",
        ),
    )

    assert trigger.metadata["model"] == "gpt-5.5-codex"
    assert response.metadata["model"] == "gpt-5.5-codex"


def test_task_subscription_returns_only_the_task_thread(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Task thread",
        description="",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)

    project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="Project message",
        ),
    )
    task_message = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            taskId=task.id,
            content="Task message",
        ),
    ).message

    messages = project_chat_service.subscribe(
        test_db,
        user_id=test_user.id,
        request=ProjectChatSubscribe(projectId=project.id, taskId=task.id),
    )

    assert [message.content for message in messages] == ["Task message"]


def test_agent_runtime_chunks_are_persisted_for_reconnect(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    trigger = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="@Code Reviewer inspect this",
            mentions=[{"type": "agent", "id": "12", "label": "Code Reviewer"}],
        ),
    ).message
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            triggerMessageId=trigger.message_id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-1",
        ),
    )

    delta = project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="runtime-task-1",
        event_name="response.output_text.delta",
        payload={"data": {"delta": "hello"}},
    )
    assert delta is not None
    assert delta[0].content == "hello"
    assert delta[1] == "delta"
    test_db.expire_all()
    assert (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == response.message_id)
        .one()
        .content
        == "hello"
    )

    completed = project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="runtime-task-1",
        event_name="response.completed",
        payload={"data": {"value": "hello world"}},
    )
    assert completed is not None
    assert completed[0].content == "hello world"
    assert completed[0].status == "completed"
    assert completed[1] == "snapshot"


def test_subagent_runtime_event_becomes_compact_task_activity(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Run this task",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    trigger = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            taskId=task.id,
            content="Please execute the task",
            mentions=[{"type": "agent", "id": "12", "label": "Code Reviewer"}],
        ),
    ).message
    parent = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            triggerMessageId=trigger.message_id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-1",
        ),
    )

    child = project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="runtime-task-1",
        event_name="subagent.completed",
        payload={
            "data": {
                "subagent_id": "tests",
                "subagent_name": "测试",
                "summary": "测试通过",
            }
        },
    )

    assert child is not None
    assert child[1] == "snapshot"
    assert child[0].sender["name"] == "Code Reviewer.测试"
    assert child[0].trigger_message_id == parent.message_id
    assert child[0].metadata["kind"] == "task_ai_subagent"
    assert child[0].content == "测试通过"


def test_task_agent_response_updates_task_ai_state(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Run this task",
        description="",
        status="todo",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    trigger = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            taskId=task.id,
            content="Please execute the task",
            mentions=[{"type": "agent", "id": "12", "label": "Code Reviewer"}],
        ),
    ).message

    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            triggerMessageId=trigger.message_id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-1",
        ),
    )

    test_db.refresh(task)
    ai_state = task.metadata_json["ai_state"]
    assert response.metadata["run_status"] == "running"
    assert ai_state["run_id"] == response.metadata["run_id"]
    assert ai_state["status"] == "running"
    assert ai_state["agent_id"] == "12"
    assert ai_state["runtime_device_id"] == "device-1"
    assert ai_state["runtime_task_id"] == "runtime-task-1"
    assert ai_state["trigger_message_id"] == trigger.message_id


def test_expired_task_ai_lease_terminates_streaming_message(
    test_db: Session, test_user: User
) -> None:
    """When the executor terminal event never arrives, the lease reconcile must
    also terminate the streaming chat message so the activity rail stops
    showing "running"."""

    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Lease expired task",
        description="",
        status="todo",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    message_view = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            triggerMessageId=None,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-expired",
        ),
    )
    assert message_view.status == "streaming"
    message = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == message_view.message_id)
        .one()
    )
    test_db.refresh(task)
    ai_state = dict((task.metadata_json or {})["ai_state"])
    ai_state["lease_expires_at"] = (
        datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=10)
    ).isoformat()
    task.metadata_json = {**dict(task.metadata_json or {}), "ai_state": ai_state}
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)
    assert values["ai_state"]["status"] == "interrupted"
    assert message.status == "failed"
    assert message.metadata_json.get("lease_expired") is True


def _running_ai_task(
    test_db: Session, user: User, project: CloudProject
) -> tuple[LoopItem, ProjectChatMessage]:
    """Create a task with a streaming agent message and running ai_state."""

    task = LoopItem(
        cloud_project_id=project.id,
        title="Reconcile task",
        description="",
        status="todo",
        assignee_agent_id="12",
        created_by_user_id=user.id,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    view = project_chat_service.start_agent_response(
        test_db,
        user_id=user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            triggerMessageId=None,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-reconcile",
        ),
    )
    message = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == view.message_id)
        .one()
    )
    test_db.refresh(task)
    assert message.status == "streaming"
    assert (task.metadata_json or {})["ai_state"]["status"] == "running"
    return task, message


def _expire_ai_lease(
    test_db: Session, task: LoopItem, *, minutes_ago: int = 10
) -> None:
    ai_state = dict((task.metadata_json or {})["ai_state"])
    ai_state["lease_expires_at"] = (
        datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=minutes_ago)
    ).isoformat()
    task.metadata_json = {**dict(task.metadata_json or {}), "ai_state": ai_state}
    test_db.commit()


@pytest.mark.parametrize(
    ("ai_status", "expected_message_status"),
    [
        ("completed", "streaming"),
        ("failed", "streaming"),
        ("interrupted", "streaming"),
    ],
)
def test_lease_reconcile_skips_when_ai_state_is_not_running(
    test_db: Session, test_user: User, ai_status: str, expected_message_status: str
) -> None:
    project = create_project(test_db, test_user)
    task, message = _running_ai_task(test_db, test_user, project)
    ai_state = dict((task.metadata_json or {})["ai_state"])
    ai_state["status"] = ai_status
    ai_state["lease_expires_at"] = (
        datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=10)
    ).isoformat()
    task.metadata_json = {**dict(task.metadata_json or {}), "ai_state": ai_state}
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)
    assert values["ai_state"]["status"] == ai_status
    test_db.refresh(message)
    assert message.status == expected_message_status


def test_lease_reconcile_skips_when_lease_not_expired(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task, message = _running_ai_task(test_db, test_user, project)
    ai_state = dict((task.metadata_json or {})["ai_state"])
    ai_state["lease_expires_at"] = (
        datetime.now(UTC).replace(tzinfo=None) + timedelta(minutes=10)
    ).isoformat()
    task.metadata_json = {**dict(task.metadata_json or {}), "ai_state": ai_state}
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)
    assert values["ai_state"]["status"] == "running"
    test_db.refresh(message)
    assert message.status == "streaming"


def test_lease_reconcile_skips_when_lease_missing(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task, message = _running_ai_task(test_db, test_user, project)
    ai_state = dict((task.metadata_json or {})["ai_state"])
    ai_state.pop("lease_expires_at", None)
    task.metadata_json = {**dict(task.metadata_json or {}), "ai_state": ai_state}
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)
    assert values["ai_state"]["status"] == "running"
    test_db.refresh(message)
    assert message.status == "streaming"


def test_lease_reconcile_tolerates_missing_message(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task, _message = _running_ai_task(test_db, test_user, project)
    ai_state = dict((task.metadata_json or {})["ai_state"])
    ai_state["project_chat_message_id"] = "missing-message-id"
    ai_state["lease_expires_at"] = (
        datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=10)
    ).isoformat()
    task.metadata_json = {**dict(task.metadata_json or {}), "ai_state": ai_state}
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)
    assert values["ai_state"]["status"] == "interrupted"


def test_lease_reconcile_leaves_terminal_message_unchanged(
    test_db: Session, test_user: User
) -> None:
    """A terminal message wins over the lease: the message state is the
    source of truth, so a stale lease must not downgrade it."""

    project = create_project(test_db, test_user)
    task, message = _running_ai_task(test_db, test_user, project)
    message.status = "completed"
    message.content = "已完成"
    test_db.commit()
    _expire_ai_lease(test_db, task)

    values = loop_item_service.response_values(test_db, task, test_user.id)
    assert values["ai_state"]["status"] == "completed"
    test_db.refresh(message)
    assert message.status == "completed"
    assert message.content == "已完成"


def test_lease_reconcile_increments_auto_retry_budget(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task, message = _running_ai_task(test_db, test_user, project)
    ai_state = dict((task.metadata_json or {})["ai_state"])
    ai_state["auto_retry"] = True
    ai_state["auto_retry_count"] = 1
    ai_state["lease_expires_at"] = (
        datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=10)
    ).isoformat()
    task.metadata_json = {**dict(task.metadata_json or {}), "ai_state": ai_state}
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)
    assert values["ai_state"]["status"] == "interrupted"
    assert values["ai_state"]["auto_retry_count"] == 2
    test_db.refresh(message)
    assert message.status == "failed"


def test_message_reconcile_syncs_completed_ai_state(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task, message = _running_ai_task(test_db, test_user, project)
    message.status = "completed"
    message.content = "任务完成总结"
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)
    ai_state = values["ai_state"]
    assert ai_state["status"] == "completed"
    assert ai_state["lease_expires_at"] is None
    assert ai_state["completed_at"] is not None


def test_message_reconcile_skips_streaming_message(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task, message = _running_ai_task(test_db, test_user, project)
    assert message.status == "streaming"

    values = loop_item_service.response_values(test_db, task, test_user.id)
    assert values["ai_state"]["status"] == "running"


def test_task_assignment_agent_response_updates_task_ai_state_without_user_comment(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Run assigned task",
        description="",
        status="todo",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)

    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-1",
            prompt="请开始执行任务",
        ),
    )

    test_db.refresh(task)
    ai_state = task.metadata_json["ai_state"]
    assert response.trigger_message_id is None
    assert response.metadata["run_status"] == "running"
    assert ai_state["status"] == "running"
    assert ai_state["prompt"] == "请开始执行任务"


def test_task_agent_failure_updates_task_ai_state(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Run this task",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    trigger = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            taskId=task.id,
            content="Please execute the task",
            mentions=[{"type": "agent", "id": "12", "label": "Code Reviewer"}],
        ),
    ).message
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            triggerMessageId=trigger.message_id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-1",
        ),
    )

    failed = project_chat_service.fail_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentFailure(
            projectId=project.id,
            taskId=task.id,
            messageId=response.message_id,
            error="Runtime failed",
        ),
    )

    test_db.refresh(task)
    ai_state = task.metadata_json["ai_state"]
    assert failed.status == "failed"
    assert failed.metadata["run_status"] == "failed"
    assert ai_state["status"] == "failed"
    assert ai_state["last_error"] == "Runtime failed"


def test_auto_retry_failure_increments_budget_but_manual_rerun_does_not(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Run this task",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)

    auto = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-auto-1",
            autoRetry=True,
        ),
    )
    assert auto.metadata["auto_retry"] is True

    project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="runtime-auto-1",
        event_name="response.failed",
        payload={"data": {"error": "Auto retry failed"}},
    )
    test_db.refresh(task)
    ai_state = task.metadata_json["ai_state"]
    assert ai_state["status"] == "failed"
    assert ai_state["auto_retry"] is True
    assert ai_state["auto_retry_count"] == 1

    manual = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-manual-1",
            autoRetry=False,
        ),
    )
    assert manual.metadata["auto_retry"] is False
    project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="runtime-manual-1",
        event_name="response.failed",
        payload={"data": {"error": "Manual rerun failed"}},
    )
    test_db.refresh(task)
    ai_state = task.metadata_json["ai_state"]
    assert ai_state["status"] == "failed"
    assert ai_state["auto_retry"] is False
    assert ai_state["auto_retry_count"] == 1


def test_agent_response_creates_distinct_message_for_each_runtime_run(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Review the project count",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    response_ids = []
    run_ids = []
    for index in range(2):
        trigger = project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=ProjectChatSend(
                clientMessageId=str(uuid.uuid4()),
                projectId=project.id,
                taskId=task.id,
                content=f"Follow-up {index}",
                mentions=[{"type": "agent", "id": "12", "label": "Code Reviewer"}],
            ),
        ).message
        response = project_chat_service.start_agent_response(
            test_db,
            user_id=test_user.id,
            request=ProjectChatAgentStart(
                projectId=project.id,
                taskId=task.id,
                triggerMessageId=trigger.message_id,
                agentId="12",
                runtimeDeviceId="device-1",
                runtimeTaskId="shared-runtime-task",
            ),
        )
        completed = project_chat_service.project_runtime_event(
            test_db,
            device_id="device-1",
            runtime_task_id="shared-runtime-task",
            event_name="response.completed",
            payload={"data": {"value": f"Result {index}"}},
        )
        assert completed is not None
        assert completed[0].message_id == response.message_id
        response_ids.append(response.message_id)
        run_ids.append(response.metadata["run_id"])

    responses = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == "device-1",
            ProjectChatMessage.runtime_task_id == "shared-runtime-task",
        )
        .order_by(ProjectChatMessage.id)
        .all()
    )
    assert len(responses) == 2
    assert [response.message_id for response in responses] == response_ids
    assert responses[0].content == "Result 0"
    assert responses[1].content == "Result 1"
    assert all(response.status == "completed" for response in responses)
    assert run_ids[0] != run_ids[1]
    test_db.refresh(task)
    assert task.metadata_json["ai_state"]["run_id"] == run_ids[1]
    assert task.metadata_json["ai_state"]["status"] == "completed"


def test_agent_response_must_reference_a_real_project_chat_message(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)

    with pytest.raises(HTTPException, match="must be attached"):
        project_chat_service.start_agent_response(
            test_db,
            user_id=test_user.id,
            request=ProjectChatAgentStart(
                projectId=project.id,
                triggerMessageId="missing-message",
                agentId="12",
                runtimeDeviceId="device-1",
                runtimeTaskId="runtime-task-1",
            ),
        )


def test_local_runtime_completion_persists_the_agent_response(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    trigger = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="@Code Reviewer finish this",
            mentions=[{"type": "agent", "id": "12", "label": "Code Reviewer"}],
        ),
    ).message
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            triggerMessageId=trigger.message_id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-1",
        ),
    )

    completed = project_chat_service.project_runtime_event(
        test_db,
        device_id="local-device",
        runtime_task_id="runtime-task-1",
        event_name="response.completed",
        payload={"data": {"value": "Task complete"}},
    )

    assert completed is not None
    assert completed[0].content == "Task complete"
    assert completed[0].status == "completed"
    assert completed[0].type == "text"


def test_runtime_completion_advances_assigned_task_to_review(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        id="CHAT-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Implement feature",
        description="Ship it",
        status="in_progress",
        priority="none",
        sort_order=0,
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    trigger = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            taskId=task.id,
            content="继续处理",
            mentions=[{"type": "agent", "id": "12", "label": "Code Reviewer"}],
        ),
    ).message
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            triggerMessageId=trigger.message_id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-review",
        ),
    )
    test_db.refresh(task)
    assert task.metadata_json["ai_state"]["run_id"] == response.metadata["run_id"]
    assert task.metadata_json["ai_state"]["status"] == "running"

    project_chat_service.project_runtime_event(
        test_db,
        device_id="local-device",
        runtime_task_id="runtime-task-review",
        event_name="response.completed",
        payload={"data": {"value": "Ready for review"}},
    )

    test_db.refresh(task)
    assert task.status == "in_review"
    assert task.metadata_json["ai_state"]["status"] == "completed"


def test_runtime_task_terminal_status_closes_the_task_ai_state(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        id="CHAT-2",
        cloud_project_id=project.id,
        sequence_number=2,
        title="Implement task",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-status",
            prompt="请开始执行任务",
        ),
    )

    completed = project_chat_service.project_runtime_event(
        test_db,
        device_id="local-device",
        runtime_task_id="runtime-task-status",
        event_name="runtime.task.completed",
        payload={
            "status": "completed",
            "data": {"status": "completed", "value": "Done"},
        },
    )

    assert completed is not None
    assert completed[0].status == "completed"
    assert completed[0].metadata["run_status"] == "completed"
    test_db.refresh(task)
    assert task.status == "in_review"
    assert task.metadata_json["ai_state"]["run_id"] == response.metadata["run_id"]
    assert task.metadata_json["ai_state"]["status"] == "completed"


def test_runtime_done_event_closes_the_task_ai_state(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        id="CHAT-DONE-EVENT",
        cloud_project_id=project.id,
        sequence_number=3,
        title="Close from done",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-done-event",
            prompt="请开始执行任务",
        ),
    )

    completed = project_chat_service.project_runtime_event(
        test_db,
        device_id="local-device",
        runtime_task_id="runtime-task-done-event",
        event_name="done",
        payload={
            "status": "done",
            "data": {"result": {"content": "done from executor"}},
        },
    )

    assert completed is not None
    assert completed[0].status == "completed"
    assert completed[0].content == "done from executor"
    test_db.refresh(task)
    assert task.status == "in_review"
    assert task.metadata_json["ai_state"]["run_id"] == response.metadata["run_id"]
    assert task.metadata_json["ai_state"]["status"] == "completed"


def test_loop_item_response_reconciles_expired_task_ai_lease(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        id="CHAT-LEASE",
        cloud_project_id=project.id,
        sequence_number=3,
        title="Recover lost runtime",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-lost",
            prompt="请开始执行任务",
        ),
    )
    test_db.refresh(task)
    expired_at = (
        datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=5)
    ).isoformat()
    task.metadata_json = {
        **task.metadata_json,
        "ai_state": {
            **task.metadata_json["ai_state"],
            "lease_expires_at": expired_at,
        },
    }
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)

    assert values["ai_state"]["run_id"] == response.metadata["run_id"]
    assert values["ai_state"]["status"] == "interrupted"
    assert "lease expired" in values["ai_state"]["last_error"]


def test_loop_item_response_reconciles_terminal_ai_message(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        id="CHAT-TERMINAL-RECONCILE",
        cloud_project_id=project.id,
        sequence_number=4,
        title="Recover terminal message",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-terminal-reconcile",
            prompt="请开始执行任务",
        ),
    )
    message = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == response.message_id)
        .one()
    )
    message.status = "completed"
    message.message_type = "text"
    message.content = "任务已完成"
    test_db.commit()

    values = loop_item_service.response_values(test_db, task, test_user.id)

    assert values["status"] == "in_review"
    assert values["ai_state"]["run_id"] == response.metadata["run_id"]
    assert values["ai_state"]["status"] == "completed"
    assert values["ai_state"]["lease_expires_at"] is None


def test_response_completed_extracts_openai_response_output_text(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-response-shape",
        ),
    )

    completed = project_chat_service.project_runtime_event(
        test_db,
        device_id="local-device",
        runtime_task_id="runtime-task-response-shape",
        event_name="response.completed",
        payload={
            "data": {
                "response": {
                    "output": [
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "Completed from response",
                                }
                            ]
                        }
                    ]
                }
            }
        },
    )

    assert completed is not None
    assert completed[0].message_id == response.message_id
    assert completed[0].content == "Completed from response"
    assert completed[0].status == "completed"


def test_device_runtime_projection_accepts_local_task_id(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = create_project(test_db, test_user)
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="local-task-1",
        ),
    )

    @contextmanager
    def same_session():
        yield test_db

    monkeypatch.setattr(
        "app.api.ws.device_namespace.get_db_session",
        same_session,
    )

    projected = _project_chat_runtime_event_sync(
        "local-device",
        {
            "event": "runtime.task.completed",
            "payload": {
                "localTaskId": "local-task-1",
                "data": {"value": "Completed through localTaskId"},
            },
        },
    )

    assert projected is not None
    assert projected["mode"] == "snapshot"
    assert projected["message"]["messageId"] == response.message_id
    assert projected["message"]["status"] == "completed"
    assert projected["message"]["content"] == "Completed through localTaskId"


def test_subscribe_reconciles_streaming_message_from_terminal_task_ai_state(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        id="CHAT-3",
        cloud_project_id=project.id,
        sequence_number=3,
        title="Recover stale run",
        description="",
        status="in_progress",
        assignee_agent_id="12",
        created_by_user_id=test_user.id,
    )
    test_db.add(task)
    test_db.commit()
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-recovered",
        ),
    )
    task.metadata_json = {
        **task.metadata_json,
        "ai_state": {
            **task.metadata_json["ai_state"],
            "status": "completed",
        },
    }
    test_db.commit()

    messages = project_chat_service.subscribe(
        test_db,
        user_id=test_user.id,
        request=ProjectChatSubscribe(projectId=project.id, taskId=task.id),
    )

    assert messages[-1].message_id == response.message_id
    assert messages[-1].status == "completed"
    assert messages[-1].metadata["run_status"] == "completed"
    stored_message = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == response.message_id)
        .one()
    )
    assert stored_message.status == "completed"
    test_db.refresh(task)
    assert task.status == "in_review"


def test_reply_thread_resolves_root_and_carries_reply_to(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    root = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="Root comment",
        ),
    ).message
    reply = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="First reply",
            replyToMessageId=root.message_id,
        ),
    ).message
    nested = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="Reply to a reply",
            replyToMessageId=reply.message_id,
        ),
    ).message

    assert root.reply_to_message_id is None
    assert root.root_message_id is None
    assert reply.reply_to_message_id == root.message_id
    assert reply.root_message_id == root.message_id
    assert nested.reply_to_message_id == reply.message_id
    assert nested.root_message_id == root.message_id


def test_agent_response_copies_trigger_thread_context(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    root = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="Root comment",
        ),
    ).message
    reply = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            content="Reply",
            replyToMessageId=root.message_id,
        ),
    ).message
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            triggerMessageId=reply.message_id,
            agentId="12",
            runtimeDeviceId="device-1",
            runtimeTaskId="runtime-task-1",
        ),
    )

    assert response.reply_to_message_id == reply.message_id
    assert response.root_message_id == root.message_id


def test_reply_target_must_live_in_the_same_task(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    first_task = LoopItem(
        cloud_project_id=project.id,
        title="First",
        description="",
        created_by_user_id=test_user.id,
    )
    second_task = LoopItem(
        cloud_project_id=project.id,
        title="Second",
        description="",
        created_by_user_id=test_user.id,
    )
    test_db.add_all([first_task, second_task])
    test_db.commit()
    test_db.refresh(first_task)
    test_db.refresh(second_task)

    root = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            taskId=first_task.id,
            content="Root comment",
        ),
    ).message
    with pytest.raises(HTTPException) as exc:
        project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=ProjectChatSend(
                clientMessageId=str(uuid.uuid4()),
                projectId=project.id,
                taskId=second_task.id,
                content="Wrong task reply",
                replyToMessageId=root.message_id,
            ),
        )
    assert exc.value.status_code == 422


def test_reply_target_missing_raises_404(test_db: Session, test_user: User) -> None:
    project = create_project(test_db, test_user)
    with pytest.raises(HTTPException) as exc:
        project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=ProjectChatSend(
                clientMessageId=str(uuid.uuid4()),
                projectId=project.id,
                content="Missing target reply",
                replyToMessageId="missing-message",
            ),
        )
    assert exc.value.status_code == 404


def test_subscribe_reconciles_stale_run_metadata_from_terminal_message(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            agentId="12",
            runtimeDeviceId="local-device",
            runtimeTaskId="runtime-task-metadata-stale",
        ),
    )
    stored_message = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == response.message_id)
        .one()
    )
    stored_message.status = "completed"
    stored_message.message_type = "text"
    stored_message.content = "任务已执行完成。"
    stored_message.metadata_json = {
        **stored_message.metadata_json,
        "run_status": "running",
    }
    test_db.commit()

    messages = project_chat_service.subscribe(
        test_db,
        user_id=test_user.id,
        request=ProjectChatSubscribe(projectId=project.id),
    )

    assert messages[-1].message_id == response.message_id
    assert messages[-1].status == "completed"
    assert messages[-1].metadata["run_status"] == "completed"


def test_agent_response_dedup_matches_mysql_empty_trigger_sentinel(
    test_db: Session, test_user: User
) -> None:
    """Queue-dispatched runs have no trigger message; repeated starts for the
    same runtime task must reuse the streaming row instead of duplicating it
    (MySQL stores the unset trigger as an empty string, not NULL)."""

    project = create_project(test_db, test_user)
    request = ProjectChatAgentStart(
        projectId=project.id,
        agentId="12",
        runtimeDeviceId="device-1",
        runtimeTaskId="runtime-task-1",
        model="gpt-5.5-codex",
    )
    first = project_chat_service.start_agent_response(
        test_db, user_id=test_user.id, request=request
    )
    second = project_chat_service.start_agent_response(
        test_db, user_id=test_user.id, request=request
    )

    assert first.message_id == second.message_id
    rows = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.agent_id == "12",
            ProjectChatMessage.runtime_task_id == "runtime-task-1",
            ProjectChatMessage.runtime_device_id == "device-1",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .all()
    )
    assert len(rows) == 1
