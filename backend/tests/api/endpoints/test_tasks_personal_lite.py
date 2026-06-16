# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.api.endpoints.adapter.tasks import get_personal_tasks_lite
from app.core.constants import CLIENT_ORIGIN_FRONTEND, CLIENT_ORIGIN_WEWORK
from app.models.task import TaskResource
from app.models.user import User


def _task_json(task_id: int, title: str, *, project_id: int | None = None) -> dict:
    labels = {"taskType": "code", "type": "offline"}
    if project_id is not None:
        labels["projectId"] = str(project_id)
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": f"task-{task_id}",
            "namespace": "default",
            "labels": labels,
        },
        "spec": {
            "title": title,
            "prompt": title,
            "teamRef": {"name": "coder", "namespace": "default"},
            "workspaceRef": {"name": f"workspace-{task_id}", "namespace": "default"},
        },
        "status": {"status": "COMPLETED"},
    }


def _task(
    *,
    task_id: int,
    user_id: int,
    title: str,
    project_id: int = 0,
    label_project_id: int | None = None,
    client_origin: str = CLIENT_ORIGIN_WEWORK,
) -> TaskResource:
    now = datetime.now() + timedelta(seconds=task_id)
    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json=_task_json(task_id, title, project_id=label_project_id),
        is_active=TaskResource.STATE_ACTIVE,
        project_id=project_id,
        client_origin=client_origin,
        created_at=now,
        updated_at=now,
    )


def test_wework_personal_lite_returns_projectless_conversations_without_label_filter(
    test_db: Session,
    test_user: User,
) -> None:
    standalone = _task(
        task_id=1501,
        user_id=test_user.id,
        title="Standalone chat",
    )
    project_task = _task(
        task_id=1502,
        user_id=test_user.id,
        title="Project chat",
        project_id=700,
        label_project_id=700,
    )
    stale_project_task = _task(
        task_id=1503,
        user_id=test_user.id,
        title="Stale project chat",
        label_project_id=700,
    )
    test_db.add_all([standalone, project_task, stale_project_task])
    test_db.commit()

    result = get_personal_tasks_lite(
        page=1,
        limit=20,
        types="online,offline",
        client_origin=CLIENT_ORIGIN_WEWORK,
        current_user=test_user,
        db=test_db,
    )

    assert result["total"] == 2
    assert [item["id"] for item in result["items"]] == [
        stale_project_task.id,
        standalone.id,
    ]


def test_frontend_personal_lite_returns_history_without_active_project_tasks(
    test_db: Session,
    test_user: User,
) -> None:
    standalone = _task(
        task_id=1511,
        user_id=test_user.id,
        title="Standalone frontend chat",
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )
    active_project_task = _task(
        task_id=1512,
        user_id=test_user.id,
        title="Active project frontend chat",
        project_id=700,
        label_project_id=700,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )
    cleared_project_history = _task(
        task_id=1513,
        user_id=test_user.id,
        title="Cleared project frontend chat",
        label_project_id=700,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )
    test_db.add_all([standalone, active_project_task, cleared_project_history])
    test_db.commit()

    result = get_personal_tasks_lite(
        page=1,
        limit=20,
        types="online,offline",
        client_origin=CLIENT_ORIGIN_FRONTEND,
        current_user=test_user,
        db=test_db,
    )

    item_ids = {item["id"] for item in result["items"]}
    assert result["total"] == 2
    assert item_ids == {standalone.id, cleared_project_history.id}
    assert active_project_task.id not in item_ids
