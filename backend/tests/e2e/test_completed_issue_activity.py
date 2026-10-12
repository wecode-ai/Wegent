# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise late Runtime callbacks through the public execution API."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
    runtime_task_id_for,
)
from tests.services.test_loop_item_executions import (
    _make_bot,
    _make_execution,
    _make_item,
    _make_project,
)


def _runtime_start(
    client: TestClient, token: str, project_id: int, execution_id: int
) -> None:
    response = client.post(
        f"/api/v1/cloud-projects/{project_id}/executions/{execution_id}/runtime-start",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "runtime_device_id": "cloud-device-1",
            "runtime_task_id": runtime_task_id_for(execution_id),
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["id"] == execution_id


def test_late_runtime_start_does_not_open_activity_for_completed_issue(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    assert claimed is not None and claimed.id == execution.id
    item.status = "completed"
    test_db.commit()

    _runtime_start(test_client, test_token, project.id, execution.id)

    messages = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.task_id == item.id)
        .all()
    )
    assert messages == []
    test_db.refresh(item)
    assert item.status == "completed"


def test_repeated_runtime_start_preserves_terminal_activity(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    assert claimed is not None and claimed.id == execution.id
    _runtime_start(test_client, test_token, project.id, execution.id)
    message = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.task_id == item.id)
        .one()
    )
    message.status = "completed"
    message.content = "Delivered"
    message.metadata_json = {**message.metadata_json, "run_status": "completed"}
    item.status = "completed"
    test_db.commit()

    _runtime_start(test_client, test_token, project.id, execution.id)

    test_db.refresh(message)
    assert message.status == "completed"
    assert message.content == "Delivered"
    assert message.metadata_json["run_status"] == "completed"
    assert (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.task_id == item.id)
        .count()
        == 1
    )
