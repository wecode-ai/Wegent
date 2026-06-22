# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.adapters.task_kinds.queries import TaskQueryMixin
from app.services.task_fork_history import ForkHistoryItem


class _TaskQueryService(TaskQueryMixin):
    def get_task_by_id(self, db, *, task_id, user_id, client_origin=None):
        return {
            "id": task_id,
            "user_id": 7,
            "team_id": None,
        }


def _subtask(message_id: int):
    return SimpleNamespace(
        id=message_id,
        task_id=1,
        team_id=2,
        title="assistant",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        prompt=None,
        executor_namespace="",
        executor_name="",
        message_id=message_id,
        parent_id=message_id - 1,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        result={"value": "done"},
        error_message=None,
        user_id=7,
        created_at=None,
        updated_at=None,
        completed_at=None,
        contexts=[],
        sender_type=None,
        sender_user_id=None,
        sender_user_name=None,
        reply_to_subtask_id=None,
    )


def test_get_task_detail_uses_fork_history_resolver(monkeypatch):
    item = ForkHistoryItem(
        subtask=_subtask(9),
        inherited=True,
        origin_task_id=1,
        origin_subtask_id=9,
    )

    monkeypatch.setattr(
        "app.services.adapters.task_kinds.queries.task_store.get_by_id",
        lambda db, *, task_id, owner_user_id=None: None,
    )
    monkeypatch.setattr(
        "app.services.readers.users.userReader.get_by_id",
        lambda db, user_id: None,
    )
    monkeypatch.setattr(
        "app.services.subtask.subtask_service.get_by_task",
        lambda **kwargs: pytest.fail("task detail should use fork history resolver"),
    )
    monkeypatch.setattr(
        "app.services.task_fork_history.task_fork_history_resolver.resolve_for_task",
        lambda db, *, task_id, user_id, limit=None: [item],
    )
    monkeypatch.setattr(
        "app.services.adapters.task_kinds.queries.add_group_chat_info_to_task",
        lambda db, *, task_id, task_dict, user_id: None,
    )

    result = _TaskQueryService().get_task_detail(
        db=None,
        task_id=2,
        user_id=7,
        client_origin="wework",
    )

    assert result["subtasks"][0]["inherited"] is True
    assert result["subtasks"][0]["origin_task_id"] == 1
    assert result["subtasks"][0]["origin_subtask_id"] == 9
