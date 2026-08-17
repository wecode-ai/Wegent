# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.api.endpoints import users as users_endpoint
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.adapters.team_kinds import team_kinds_service
from app.stores.tasks import task_store


class _FakeQuery:
    def __init__(self, result):
        self._result = result

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._result


class _FakeDb:
    def __init__(self, system_config):
        self._system_config = system_config

    def query(self, _model):
        return _FakeQuery(self._system_config)


def _team(team_id: int, *, user_id: int = 7, updated_offset: int = 0) -> dict:
    return {
        "id": team_id,
        "user_id": user_id,
        "name": f"team-{team_id}",
        "displayName": f"Team {team_id}",
        "namespace": "default",
        "recommended_mode": "chat",
        "agent_type": "claude",
        "updated_at": datetime(2026, 1, 1) + timedelta(days=updated_offset),
    }


def _task(
    task_id: int,
    *,
    user_id: int = 7,
    updated_offset: int = 0,
    team_name: str | None = None,
    team_owner_id: int | None = None,
    task_type: str = "chat",
) -> TaskResource:
    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "kind": "Task",
            "metadata": {
                "name": f"task-{task_id}",
                "namespace": "default",
                "labels": {"taskType": task_type},
            },
            "spec": {
                "teamRef": {
                    "name": team_name or f"team-{task_id}",
                    "namespace": "default",
                    "user_id": team_owner_id if team_owner_id is not None else user_id,
                }
            },
        },
        is_active=TaskResource.STATE_ACTIVE,
        is_group_chat=False,
        updated_at=datetime(2026, 1, 1) + timedelta(days=updated_offset),
    )


def _team_kind(
    user_id: int,
    name: str,
    *,
    updated_offset: int = 0,
    bot_name: str | None = None,
) -> Kind:
    timestamp = datetime(2026, 1, 1) + timedelta(days=updated_offset)
    members = []
    if bot_name:
        members.append(
            {
                "name": bot_name,
                "botRef": {"name": bot_name, "namespace": "default"},
            }
        )
    return Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {
                "name": name,
                "namespace": "default",
                "displayName": name.title(),
            },
            "spec": {
                "members": members,
                "collaborationModel": "pipeline",
                "bind_mode": ["chat"],
            },
            "status": {"state": "Available"},
        },
        is_active=True,
        created_at=timestamp,
        updated_at=timestamp,
    )


def _message(
    message_id: int,
    *,
    task_id: int,
    created_offset: int,
    role: SubtaskRole = SubtaskRole.USER,
    status: SubtaskStatus = SubtaskStatus.COMPLETED,
) -> Subtask:
    return Subtask(
        id=message_id,
        user_id=7,
        task_id=task_id,
        team_id=task_id,
        title=f"message-{message_id}",
        bot_ids=[],
        role=role,
        prompt="hello",
        message_id=message_id,
        parent_id=0,
        status=status,
        progress=100,
        created_at=datetime(2026, 2, 1) + timedelta(days=created_offset),
    )


@pytest.mark.asyncio
async def test_quick_access_keeps_favorites_and_recommendations(monkeypatch):
    system_config = SimpleNamespace(version=2, config_value={"teams": [101]})
    db = _FakeDb(system_config)
    current_user = SimpleNamespace(
        id=7,
        preferences=json.dumps({"quick_access": {"version": 1, "teams": [99]}}),
    )
    monkeypatch.setattr(
        users_endpoint.kind_service,
        "get_team_by_id",
        lambda team_id: {
            "id": team_id,
            "metadata": {
                "name": f"team-{team_id}",
                "displayName": f"Team {team_id}",
            },
            "spec": {"recommended_mode": "chat"},
            "agent_type": "claude",
        },
    )

    response = await users_endpoint.get_user_quick_access(
        db=db,
        current_user=current_user,
    )

    assert response.user_version == 1
    assert response.show_system_recommended is True
    assert [(team.id, team.is_system) for team in response.teams] == [
        (99, False),
        (101, True),
    ]


@pytest.mark.asyncio
async def test_recent_teams_are_returned_independently(monkeypatch):
    recent = [_team(202), _team(101, user_id=0)]
    monkeypatch.setattr(
        users_endpoint.team_kinds_service,
        "get_recent_accessible_teams",
        lambda *a, **k: recent,
    )

    response = await users_endpoint.get_user_recent_teams(
        db=SimpleNamespace(),
        current_user=SimpleNamespace(id=7),
    )

    assert [(team.id, team.is_system) for team in response] == [
        (202, False),
        (101, True),
    ]
    assert response[0].display_name == "Team 202"


def test_get_user_quick_access_team_ids_handles_null_user_config():
    current_user = SimpleNamespace(
        id=7,
        preferences=json.dumps({"quick_access": None}),
    )

    assert users_endpoint._get_user_quick_access_team_ids(current_user) == []


def test_recent_teams_are_deduplicated_and_filled_by_latest(test_db):
    teams = [
        _team_kind(7, f"team-{index}", updated_offset=index) for index in range(1, 7)
    ]
    test_db.add_all(
        [
            *teams,
            _task(8101, team_name="team-2", updated_offset=9),
            _task(8102, team_name="team-2", updated_offset=8),
            _task(8103, team_name="team-1", updated_offset=7),
            _message(8201, task_id=8101, created_offset=9),
            _message(8202, task_id=8102, created_offset=8),
            _message(8203, task_id=8103, created_offset=7),
        ]
    )
    test_db.commit()

    result = team_kinds_service.get_recent_accessible_teams(test_db, user_id=7, limit=5)

    assert [team["name"] for team in result] == [
        "team-2",
        "team-1",
        "team-6",
        "team-5",
        "team-4",
    ]


def test_no_history_returns_five_latest_accessible_teams(test_db):
    test_db.add_all(
        [_team_kind(7, f"team-{index}", updated_offset=index) for index in range(1, 7)]
    )
    test_db.commit()

    result = team_kinds_service.get_recent_accessible_teams(test_db, user_id=7, limit=5)

    assert [team["name"] for team in result] == [
        "team-6",
        "team-5",
        "team-4",
        "team-3",
        "team-2",
    ]


def test_recent_teams_distinguish_code_tasks(test_db):
    chat_team = _team_kind(7, "chat-team")
    code_team = _team_kind(7, "code-team")
    test_db.add_all(
        [
            chat_team,
            code_team,
            _task(8101, team_name=chat_team.name, task_type="chat"),
            _task(
                8102,
                team_name=code_team.name,
                task_type="code",
                updated_offset=1,
            ),
        ]
    )
    test_db.commit()

    chat_result = team_kinds_service.get_recent_accessible_teams(
        test_db,
        user_id=7,
        is_code=False,
        limit=1,
    )
    code_result = team_kinds_service.get_recent_accessible_teams(
        test_db,
        user_id=7,
        is_code=True,
        limit=1,
    )

    assert [team["name"] for team in chat_result] == ["chat-team"]
    assert [team["name"] for team in code_result] == ["code-team"]


def test_five_recent_teams_skip_accessible_team_fallback(test_db, monkeypatch):
    teams = [_team_kind(7, f"recent-{index}") for index in range(5)]
    test_db.add_all(
        [
            *teams,
            *[
                _task(
                    8300 + index,
                    team_name=team.name,
                    updated_offset=index,
                )
                for index, team in enumerate(teams)
            ],
        ]
    )
    test_db.commit()

    monkeypatch.setattr(
        team_kinds_service,
        "_build_accessible_teams_query",
        lambda *args, **kwargs: pytest.fail("fallback query should not run"),
    )

    result = team_kinds_service.get_recent_accessible_teams(
        test_db,
        user_id=7,
        limit=5,
    )

    assert [team["name"] for team in result] == [
        "recent-4",
        "recent-3",
        "recent-2",
        "recent-1",
        "recent-0",
    ]


def test_quick_access_teams_use_team_rows_only():
    teams = [
        _team_kind(7, f"team-{index}", bot_name=f"bot-{index}") for index in range(5)
    ]
    rows = [
        SimpleNamespace(
            team_id=index + 1,
            team_user_id=team.user_id,
            team_name=team.name,
            team_namespace=team.namespace,
            team_json=team.json,
            context_user_id=7,
        )
        for index, team in enumerate(teams)
    ]
    result = team_kinds_service._quick_access_team_dicts(rows)

    assert [team["name"] for team in result] == [f"team-{index}" for index in range(5)]
    assert [team["agent_type"] for team in result] == [None] * 5


def test_recent_teams_deduplicate_system_and_personal_copies(test_db):
    system_team = _team_kind(0, "wegent-chat", updated_offset=1)
    personal_team = _team_kind(7, "wegent-chat", updated_offset=2)
    other_teams = [
        _team_kind(7, f"team-{index}", updated_offset=index) for index in range(3, 8)
    ]
    test_db.add_all(
        [
            system_team,
            personal_team,
            *other_teams,
            _task(
                8101,
                team_name="wegent-chat",
                team_owner_id=0,
                updated_offset=9,
            ),
            _task(
                8102,
                team_name="wegent-chat",
                team_owner_id=7,
                updated_offset=8,
            ),
            _message(8201, task_id=8101, created_offset=9),
            _message(8202, task_id=8102, created_offset=8),
        ]
    )
    test_db.commit()

    result = team_kinds_service.get_recent_accessible_teams(test_db, user_id=7, limit=5)

    assert [team["id"] for team in result] == [
        system_team.id,
        other_teams[-1].id,
        other_teams[-2].id,
        other_teams[-3].id,
        other_teams[-4].id,
    ]


def test_recent_team_does_not_fallback_from_explicit_unknown_owner(test_db):
    wrong_owner_candidate = _team_kind(7, "same-name", updated_offset=1)
    latest_team = _team_kind(7, "latest-team", updated_offset=2)
    test_db.add_all(
        [
            wrong_owner_candidate,
            latest_team,
            _task(8101, team_name="same-name", team_owner_id=99),
            _message(8201, task_id=8101, created_offset=9),
        ]
    )
    test_db.commit()

    result = team_kinds_service.get_recent_accessible_teams(test_db, user_id=7, limit=1)

    assert [team["id"] for team in result] == [latest_team.id]


def test_recent_team_is_not_lost_beyond_first_thousand_updated_teams(test_db):
    recent_team = _team_kind(7, "old-recent-team", updated_offset=0)
    newer_teams = [
        _team_kind(7, f"newer-team-{index}", updated_offset=index + 1)
        for index in range(1001)
    ]
    test_db.add_all(
        [
            recent_team,
            *newer_teams,
            _task(8101, team_name=recent_team.name),
            _message(8201, task_id=8101, created_offset=9),
        ]
    )
    test_db.commit()

    result = team_kinds_service.get_recent_accessible_teams(test_db, user_id=7, limit=1)

    assert [team["id"] for team in result] == [recent_team.id]


def test_recent_used_tasks_follow_user_message_time_and_ignore_empty_tasks(test_db):
    old_recently_used = _task(8101, updated_offset=0)
    new_older_message = _task(8102, updated_offset=10)
    empty = _task(8103, updated_offset=20)
    test_db.add_all(
        [
            old_recently_used,
            new_older_message,
            empty,
            _message(8201, task_id=8101, created_offset=4),
            _message(8202, task_id=8101, created_offset=9, status=SubtaskStatus.DELETE),
            _message(8203, task_id=8102, created_offset=2),
            _message(
                8204,
                task_id=8103,
                created_offset=8,
                role=SubtaskRole.ASSISTANT,
            ),
        ]
    )
    test_db.commit()

    result = task_store.list_recent_owner_only_used_tasks(test_db, user_id=7, limit=5)

    assert [task.id for task in result] == [8101, 8102]
