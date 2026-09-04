# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for keeping chat:send follow-ups on the task's bound team."""

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

import pytest
from pytest import MonkeyPatch

chat_shell_module = ModuleType("chat_shell")
chat_shell_models_module = ModuleType("chat_shell.models")
chat_shell_models_module.LangChainModelFactory = object
chat_shell_module.models = chat_shell_models_module
sys.modules.setdefault("chat_shell", chat_shell_module)
sys.modules.setdefault("chat_shell.models", chat_shell_models_module)
chat_config_module = ModuleType("app.services.chat.config")
chat_config_module.get_team_first_bot_shell_type = Mock()
sys.modules.setdefault("app.services.chat.config", chat_config_module)

import app.stores.tasks as task_stores  # noqa: E402
from app.api.ws import chat_namespace  # noqa: E402
from app.api.ws.chat_namespace import _resolve_existing_task_team  # noqa: E402
from app.api.ws.chat_namespace import _resolve_task_bound_team  # noqa: E402


def _task(team_ref: dict | None) -> SimpleNamespace:
    spec = {"teamRef": team_ref} if team_ref else {}
    return SimpleNamespace(id=390051750105148, user_id=2838, json={"spec": spec})


def _db_returning_team(bound_team: object | None) -> Mock:
    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = bound_team
    return db


def test_bound_team_wins_over_client_team() -> None:
    task = _task(
        {
            "name": "creator-php-workflow",
            "namespace": "default",
            "user_id": 2838,
        }
    )
    bound_team = SimpleNamespace(id=267213, name="creator-php-workflow")
    client_team = SimpleNamespace(id=273960, name="qbird-direct-log")
    db = _db_returning_team(bound_team)

    result = _resolve_task_bound_team(db, task, client_team)

    assert result is bound_team


def test_same_team_returns_bound_team() -> None:
    task = _task(
        {
            "name": "creator-php-workflow",
            "namespace": "default",
            "user_id": 2838,
        }
    )
    bound_team = SimpleNamespace(id=267213, name="creator-php-workflow")
    db = _db_returning_team(bound_team)

    result = _resolve_task_bound_team(db, task, bound_team)

    assert result is bound_team


def test_task_without_team_ref_keeps_client_team() -> None:
    task = _task(None)
    client_team = SimpleNamespace(id=273960, name="qbird-direct-log")
    db = _db_returning_team(None)

    result = _resolve_task_bound_team(db, task, client_team)

    assert result is client_team


def test_team_ref_without_name_keeps_client_team() -> None:
    task = _task({"namespace": "default"})
    client_team = SimpleNamespace(id=273960, name="qbird-direct-log")
    db = _db_returning_team(None)

    result = _resolve_task_bound_team(db, task, client_team)

    assert result is client_team


def test_legacy_team_ref_without_owner_uses_reader(monkeypatch: MonkeyPatch) -> None:
    task = _task(
        {
            "name": "creator-php-workflow",
            "namespace": "default",
        }
    )
    bound_team = SimpleNamespace(id=267213, name="creator-php-workflow")
    reader = Mock(return_value=bound_team)
    monkeypatch.setattr(
        "app.services.readers.kinds.kindReader",
        Mock(get_by_name_and_namespace=reader),
    )
    client_team = SimpleNamespace(id=273960, name="qbird-direct-log")

    result = _resolve_task_bound_team(Mock(), task, client_team)

    assert result is bound_team
    assert reader.call_count == 1
    args = reader.call_args.args
    assert args[1] == 2838
    assert args[3] == "default"
    assert args[4] == "creator-php-workflow"


def test_legacy_team_ref_missing_team_raises(monkeypatch: MonkeyPatch) -> None:
    task = _task(
        {
            "name": "creator-php-workflow",
            "namespace": "default",
        }
    )
    monkeypatch.setattr(
        "app.services.readers.kinds.kindReader",
        Mock(get_by_name_and_namespace=Mock(return_value=None)),
    )
    client_team = SimpleNamespace(id=273960, name="qbird-direct-log")

    with pytest.raises(ValueError, match="no longer exists"):
        _resolve_task_bound_team(Mock(), task, client_team)


def test_missing_bound_team_raises() -> None:
    task = _task(
        {
            "name": "creator-php-workflow",
            "namespace": "default",
            "user_id": 2838,
        }
    )
    client_team = SimpleNamespace(id=273960, name="qbird-direct-log")
    db = _db_returning_team(None)

    with pytest.raises(ValueError, match="no longer exists"):
        _resolve_task_bound_team(db, task, client_team)


def test_no_task_id_keeps_team_and_returns_no_task() -> None:
    team = SimpleNamespace(id=267213, name="creator-php-workflow")

    task, result = _resolve_existing_task_team(Mock(), None, team)

    assert task is None
    assert result is team


def test_missing_task_keeps_client_team(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(
        task_stores.task_store,
        "get_regular_active_task",
        Mock(return_value=None),
    )
    team = SimpleNamespace(id=273960, name="qbird-direct-log")

    task, result = _resolve_existing_task_team(Mock(), 42, team)

    assert task is None
    assert result is team


def test_same_bound_team_keeps_client_team(monkeypatch: MonkeyPatch) -> None:
    existing_task = _task(
        {
            "name": "creator-php-workflow",
            "namespace": "default",
            "user_id": 2838,
        }
    )
    bound_team = SimpleNamespace(id=267213, name="creator-php-workflow")
    monkeypatch.setattr(
        task_stores.task_store,
        "get_regular_active_task",
        Mock(return_value=existing_task),
    )
    monkeypatch.setattr(
        chat_namespace,
        "_resolve_task_bound_team",
        Mock(return_value=bound_team),
    )
    team = SimpleNamespace(id=267213, name="creator-php-workflow")

    task, result = _resolve_existing_task_team(Mock(), existing_task.id, team)

    assert task is existing_task
    assert result is team


def test_different_bound_team_rebinds(monkeypatch: MonkeyPatch) -> None:
    existing_task = _task(
        {
            "name": "creator-php-workflow",
            "namespace": "default",
            "user_id": 2838,
        }
    )
    bound_team = SimpleNamespace(id=267213, name="creator-php-workflow")
    monkeypatch.setattr(
        task_stores.task_store,
        "get_regular_active_task",
        Mock(return_value=existing_task),
    )
    monkeypatch.setattr(
        chat_namespace,
        "_resolve_task_bound_team",
        Mock(return_value=bound_team),
    )
    team = SimpleNamespace(id=273960, name="qbird-direct-log")

    task, result = _resolve_existing_task_team(Mock(), existing_task.id, team)

    assert task is existing_task
    assert result is bound_team
