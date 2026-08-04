# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for the shared project chat persistence service."""

import uuid
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.project_chat import (
    ProjectChatAgentStart,
    ProjectChatSend,
    ProjectChatSubscribe,
)
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
