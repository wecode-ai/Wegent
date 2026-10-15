# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.models.user import User
from app.services.adapters.task_kinds import queries, task_kinds_service
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore


def _task(
    user_id: int,
    task_id: int,
    title: str,
    *,
    project_id: int = 0,
) -> TaskResource:
    timestamp = datetime(2026, 6, 1) + timedelta(seconds=task_id)
    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"search-task-{task_id}",
        namespace="default",
        project_id=project_id,
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": f"search-task-{task_id}", "namespace": "default"},
            "spec": {
                "title": title,
                "prompt": title,
                "teamRef": {"name": "chat", "namespace": "default"},
                "workspaceRef": {"name": "workspace", "namespace": "default"},
            },
            "status": {"status": "COMPLETED", "progress": 100},
        },
        created_at=timestamp,
        updated_at=timestamp,
    )


def test_title_search_pages_all_matches_including_old_project_tasks_without_subtasks(
    test_db: Session, test_user: User
) -> None:
    matches = [
        _task(test_user.id, task_id, "Pagination target", project_id=101)
        for task_id in range(8101, 8104)
    ]
    newer_tasks = [
        _task(test_user.id, task_id, "New conversation", project_id=101)
        for task_id in range(8200, 8320)
    ]
    test_db.add_all([*matches, *newer_tasks])
    test_db.commit()

    with patch.object(
        queries, "load_tasks_by_ids", wraps=queries.load_tasks_by_ids
    ) as load_page:
        first, first_total = task_kinds_service.get_user_tasks_by_title_with_pagination(
            test_db,
            user_id=test_user.id,
            title="pagination",
            skip=0,
            limit=2,
        )
        second, second_total = (
            task_kinds_service.get_user_tasks_by_title_with_pagination(
                test_db,
                user_id=test_user.id,
                title="pagination",
                skip=2,
                limit=2,
            )
        )
        empty, empty_total = task_kinds_service.get_user_tasks_by_title_with_pagination(
            test_db,
            user_id=test_user.id,
            title="pagination",
            skip=4,
            limit=2,
        )

    assert [task["id"] for task in first] == [8103, 8102]
    assert [task["id"] for task in second] == [8101]
    assert all(task["project_id"] == 101 for task in [*first, *second])
    assert first_total == second_total == empty_total == 3
    assert empty == []
    assert [call.args[1] for call in load_page.call_args_list] == [
        [8103, 8102],
        [8101],
    ]


def test_title_search_retains_owner_visibility_and_state_filters(
    test_db: Session, test_user: User
) -> None:
    matching = _task(test_user.id, 8401, "Target", project_id=101)
    other_client = _task(test_user.id, 8402, "Target")
    other_client.client_origin = "wework"
    interacted = _task(test_user.id, 8403, "Target")
    interacted.json["metadata"]["labels"] = {
        "type": "subscription",
        "userInteracted": "true",
    }
    other_owner = _task(test_user.id + 1, 8410, "Target", project_id=101)
    deleted = _task(test_user.id, 8411, "Target")
    deleted.is_active = TaskResource.STATE_DELETED
    archived = _task(test_user.id, 8412, "Target")
    archived.is_active = TaskResource.STATE_ARCHIVED
    deleted_status = _task(test_user.id, 8413, "Target")
    deleted_status.json["status"]["status"] = "DELETE"
    system = _task(test_user.id, 8414, "Target")
    system.namespace = "system"
    workspace = _task(test_user.id, 8415, "Target")
    workspace.kind = "Workspace"
    subscription = _task(test_user.id, 8416, "Target")
    subscription.json["metadata"]["labels"] = {"type": "subscription"}
    inactive_subscription = _task(test_user.id, 8417, "Target")
    inactive_subscription.is_active = TaskResource.STATE_SUBSCRIPTION
    test_db.add_all(
        [
            matching,
            other_client,
            interacted,
            other_owner,
            deleted,
            archived,
            deleted_status,
            system,
            workspace,
            subscription,
            inactive_subscription,
        ]
    )
    test_db.commit()

    task_ids, total = SqlAlchemyTaskStore().list_owned_task_ids(
        test_db, user_id=test_user.id, title="target", skip=0, limit=20, extra_limit=0
    )

    assert task_ids == [8403, 8402, 8401]
    assert total == 3


@pytest.mark.parametrize("keyword", ["%", "_", "/", "PAGINATION", "分页"])
def test_title_search_treats_keywords_as_literal_case_insensitive_substrings(
    test_db: Session, test_user: User, keyword: str
) -> None:
    matching = _task(test_user.id, 8501, f"Test {keyword.lower()} target")
    nonmatching = _task(test_user.id, 8502, "Other conversation")
    test_db.add_all([matching, nonmatching])
    test_db.commit()

    task_ids, total = SqlAlchemyTaskStore().list_owned_task_ids(
        test_db, user_id=test_user.id, title=keyword, skip=0, limit=20, extra_limit=0
    )

    assert task_ids == [matching.id]
    assert total == 1
