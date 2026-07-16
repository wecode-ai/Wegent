# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest


class FakeOrmSession:
    """Minimal ORM session stub for execution loader lifecycle tests."""

    def __init__(
        self,
        *,
        task_id: int,
        assistant_subtask_id: int,
        team_id: int,
        user_id: int,
        device_id: str | None = None,
    ):
        self.task_id = task_id
        self.assistant_subtask_id = assistant_subtask_id
        self.team_id = team_id
        self.user_id = user_id
        self.device_id = device_id
        self.rolled_back = False
        self.closed = False

    def query(self, model):
        return FakeOrmQuery(model, self)

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


class FakeOrmQuery:
    """Minimal query stub keyed by model class name."""

    def __init__(self, model, session: FakeOrmSession):
        self.model = model
        self.session = session

    def filter(self, *args):
        return self

    def first(self):
        model_name = self.model.__name__
        if model_name == "TaskResource":
            return SimpleNamespace(
                id=self.session.task_id,
                kind="Task",
                json={"spec": {"device_id": self.session.device_id}},
            )
        if model_name == "Subtask":
            return SimpleNamespace(id=self.session.assistant_subtask_id)
        if model_name == "Kind":
            return SimpleNamespace(
                id=self.session.team_id,
                kind="Team",
                json={},
            )
        if model_name == "User":
            return SimpleNamespace(id=self.session.user_id, user_name="test-user")
        return None


@pytest.fixture
def fake_orm_session_factory():
    return FakeOrmSession
