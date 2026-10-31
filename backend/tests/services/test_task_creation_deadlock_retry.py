# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task creation must survive transient MySQL deadlocks."""

from unittest.mock import MagicMock

import pymysql
import pytest
from sqlalchemy.exc import OperationalError

from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import task_kinds_service


def _deadlock_error() -> OperationalError:
    return OperationalError(
        "UPDATE tasks SET kind=%(kind)s WHERE tasks.id = %(tasks_id)s",
        {"kind": "Task", "tasks_id": 1},
        pymysql.err.OperationalError(
            1213, "Deadlock found when trying to get lock; try restarting transaction"
        ),
    )


def _build_task_create() -> TaskCreate:
    return TaskCreate(
        prompt="deadlock retry",
        team_id=1,
        type="offline",
        task_type="task",
        source="web",
    )


def test_create_task_or_append_retries_the_whole_transaction(monkeypatch):
    db = MagicMock()
    db.commit.side_effect = [_deadlock_error(), None]
    user = MagicMock(id=1)
    task = MagicMock(id=42)
    team = MagicMock()
    created_rows = []

    def fake_create_rows(*_args, **_kwargs):
        created_rows.append(1)
        return task, team

    monkeypatch.setattr(
        task_kinds_service, "_create_task_rows", fake_create_rows, raising=False
    )
    monkeypatch.setattr(
        "app.services.adapters.task_kinds.operations.convert_to_task_dict",
        lambda *_args, **_kwargs: {"id": 42},
    )
    monkeypatch.setattr(
        "app.services.adapters.task_kinds.operations.time.sleep",
        lambda _seconds: None,
    )

    result = task_kinds_service.create_task_or_append(
        db=db, obj_in=_build_task_create(), user=user, task_id=1
    )

    assert result == {"id": 42}
    assert len(created_rows) == 2
    assert db.rollback.call_count == 1
    assert db.commit.call_count == 2


def test_create_task_or_append_raises_after_exhausting_deadlock_retries(monkeypatch):
    db = MagicMock()
    db.commit.side_effect = OperationalError(
        "UPDATE tasks", {}, pymysql.err.OperationalError(1213, "Deadlock found")
    )
    user = MagicMock(id=1)

    monkeypatch.setattr(
        task_kinds_service,
        "_create_task_rows",
        lambda *_args, **_kwargs: (MagicMock(id=42), MagicMock()),
    )
    monkeypatch.setattr(
        "app.services.adapters.task_kinds.operations.time.sleep",
        lambda _seconds: None,
    )

    with pytest.raises(OperationalError):
        task_kinds_service.create_task_or_append(
            db=db, obj_in=_build_task_create(), user=user, task_id=1
        )

    assert db.commit.call_count == 3
    assert db.rollback.call_count == 3


def test_create_task_or_append_does_not_retry_other_database_errors(monkeypatch):
    db = MagicMock()
    db.commit.side_effect = OperationalError(
        "UPDATE tasks", {}, pymysql.err.OperationalError(1205, "Lock wait timeout")
    )
    user = MagicMock(id=1)

    monkeypatch.setattr(
        task_kinds_service,
        "_create_task_rows",
        lambda *_args, **_kwargs: (MagicMock(id=42), MagicMock()),
    )

    with pytest.raises(OperationalError):
        task_kinds_service.create_task_or_append(
            db=db, obj_in=_build_task_create(), user=user, task_id=1
        )

    assert db.commit.call_count == 1
