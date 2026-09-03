# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for keeping chat:send follow-ups on the task's bound team."""

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

import pytest

chat_shell_module = ModuleType("chat_shell")
chat_shell_models_module = ModuleType("chat_shell.models")
chat_shell_models_module.LangChainModelFactory = object
chat_shell_module.models = chat_shell_models_module
sys.modules.setdefault("chat_shell", chat_shell_module)
sys.modules.setdefault("chat_shell.models", chat_shell_models_module)
chat_config_module = ModuleType("app.services.chat.config")
chat_config_module.get_team_first_bot_shell_type = Mock()
sys.modules.setdefault("app.services.chat.config", chat_config_module)

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
