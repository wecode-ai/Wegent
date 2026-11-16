# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Per-turn private responses never advance the shared cloud Issue projection."""

from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.api.ws.device_namespace import (
    _execution_runtime_event_sync,
    _project_chat_runtime_event_sync,
)
from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.service import project_chat_service
from tests.services.test_loop_item_executions import (
    _make_bot,
    _make_execution,
    _make_item,
    _make_project,
)

DEVICE = "cloud-device-1"


@pytest.fixture
def shared_execution(test_db: Session, test_user: User, monkeypatch):
    monkeypatch.setattr(
        "app.services.wework_notifications.deliver_notification", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.wework_notifications.deliver_notification_payload", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.project_chat.push.push_project_chat_message",
        lambda *args, **kwargs: None,
    )
    project = _make_project(test_db, test_user)
    agent = _make_bot(test_db, project, test_user)
    issue = _make_item(test_db, project, test_user)
    issue.assignee_agent_id = agent.id
    test_db.commit()
    execution = _make_execution(test_db, issue, agent, test_user)

    @contextmanager
    def same_session() -> Iterator[Session]:
        yield test_db

    monkeypatch.setattr("app.api.ws.device_namespace.get_db_session", same_session)
    monkeypatch.setattr(
        "app.api.ws.device_namespace.publish_loop_item_changed",
        lambda *args, **kwargs: None,
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=agent.id,
        execution_device_id=DEVICE,
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="private-projection-test",
    )
    assert claimed is not None
    assert claimed.id == execution.id
    activity = loop_item_execution_service.open_execution_activity(
        test_db, execution=claimed
    )
    assert activity is not None
    return project.id, issue.id, execution.id, claimed.runtime_task_id


def state(db: Session, shared_execution: tuple[str, str, int, str]) -> dict[str, Any]:
    project_id, issue_id, execution_id, _ = shared_execution
    db.expire_all()

    def columns(row: Any) -> dict[str, Any]:
        return deepcopy(
            {
                column.key: getattr(row, column.key)
                for column in inspect(row).mapper.column_attrs
            }
        )

    return {
        "issue": columns(db.get(LoopItem, issue_id)),
        "execution": columns(db.get(LoopItemExecution, execution_id)),
        "activities": [
            columns(row)
            for row in db.query(ProjectChatMessage)
            .filter_by(project_id=project_id, task_id=issue_id)
            .order_by(ProjectChatMessage.id)
            .all()
        ],
    }


def project_event(
    entry: str, db: Session, user_id: int, event_name: str, payload: dict
) -> Any:
    runtime_task = payload["taskId"]
    if entry == "namespace-chat":
        return _project_chat_runtime_event_sync(
            DEVICE, {"event": event_name, "payload": payload}, user_id
        )
    if entry == "namespace-execution":
        return _execution_runtime_event_sync(
            user_id, DEVICE, runtime_task, event_name, payload
        )
    service = (
        project_chat_service.project_runtime_event
        if entry == "chat-service"
        else loop_item_execution_service.handle_runtime_event
    )
    return service(
        db,
        device_id=DEVICE,
        runtime_task_id=runtime_task,
        event_name=event_name,
        payload=payload,
        owner_user_id=user_id,
    )


@pytest.mark.parametrize(
    "entry",
    ["namespace-chat", "namespace-execution", "chat-service", "execution-service"],
)
def test_private_responses_preserve_shared_truth_and_later_public_responses_project(
    test_db: Session, test_user: User, shared_execution, entry: str
) -> None:
    before = state(test_db, shared_execution)
    runtime_task = shared_execution[3]
    events = [
        ("response.created", {}),
        ("response.output_text.delta", {"delta": "Private delta"}),
        ("response.completed", {"value": "Private final answer"}),
    ]
    for sequence, (event_name, data) in enumerate(events, start=11):
        result = project_event(
            entry,
            test_db,
            test_user.id,
            event_name,
            {
                "taskId": runtime_task,
                "subtaskId": "private-turn",
                "eventSeq": sequence,
                "conversationContext": "private_discussion",
                "data": data,
            },
        )
        assert result is None
        assert state(test_db, shared_execution) == before, event_name

    for sequence, (event_name, data) in enumerate(
        [
            ("response.created", {}),
            ("response.output_text.delta", {"delta": "Public delta"}),
            ("response.completed", {"value": "Public final answer"}),
        ],
        start=14,
    ):
        payload = {
            "taskId": runtime_task,
            "subtaskId": "public-turn",
            "eventSeq": sequence,
            "data": data,
        }
        if entry == "chat-service":
            loop_item_execution_service.handle_runtime_event(
                test_db,
                device_id=DEVICE,
                runtime_task_id=runtime_task,
                event_name=event_name,
                payload=payload,
                owner_user_id=test_user.id,
            )
        project_event(
            entry,
            test_db,
            test_user.id,
            event_name,
            payload,
        )

    after = state(test_db, shared_execution)
    assert after["issue"]["status"] == "in_review"
    assert after["issue"]["version"] > before["issue"]["version"]
    assert len(after["activities"]) == len(before["activities"])
    assert after["activities"][0]["content"] == "Public final answer"
    assert after["activities"][0]["status"] == "completed"
    if entry != "chat-service":
        assert after["execution"]["status"] == "completed"
        assert after["execution"]["last_event_seq"] == 16
    assert "Private delta" not in str(after)
    assert "Private final answer" not in str(after)
