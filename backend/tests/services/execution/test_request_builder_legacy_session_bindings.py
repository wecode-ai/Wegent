# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.services.execution.request_builder import TaskRequestBuilder
from app.stores.tasks import subtask_store


def _session(**overrides):
    return {"agent": "CodeX", "botId": 23, "threadId": "old-thread", **overrides}


@pytest.mark.parametrize("deleted", [False, True])
def test_owner_query_supplies_bindings_without_expanding_inheritance(
    monkeypatch, deleted
):
    builder = TaskRequestBuilder(Mock())
    session = _session()
    query = Mock(return_value=[SimpleNamespace(result={"executor_session": session})])
    monkeypatch.setattr(subtask_store, "list_assistant_by_task", query)
    fork = _session(threadId="fork-thread", botId=99)

    inherited, bindings = builder._build_session_context(
        task=SimpleNamespace(id=123, user_id=7),
        user=SimpleNamespace(id=7),
        bot_configs=[{"id": 23, "shell_type": "Codex"}],
        fork_sessions=[fork],
        executor_deleted=deleted,
        new_session=False,
    )

    query.assert_called_once_with(builder.db, task_id=123, owner_user_id=7)
    assert inherited == ([fork, session] if deleted else [fork])
    assert bindings == [{**session, "task_id": 123, "user_id": 7}]


@pytest.mark.parametrize(
    ("user_id", "new_session", "shell"),
    [(8, False, "Codex"), (7, True, "Codex"), (7, False, "Chat")],
)
def test_no_bindings_for_other_user_new_session_or_non_coding_shell(
    monkeypatch, user_id, new_session, shell
):
    builder = TaskRequestBuilder(Mock())
    query = Mock()
    monkeypatch.setattr(subtask_store, "list_assistant_by_task", query)

    inherited, bindings = builder._build_session_context(
        task=SimpleNamespace(id=123, user_id=7),
        user=SimpleNamespace(id=user_id),
        bot_configs=[{"id": 23, "shell_type": shell}],
        fork_sessions=[],
        executor_deleted=False,
        new_session=new_session,
    )

    query.assert_not_called()
    assert inherited == []
    assert bindings == []


@pytest.mark.parametrize(
    "session",
    [
        _session(botId=None),
        _session(botId=24),
        _session(agent="ClaudeCode", sessionId="claude-session"),
        _session(threadId="../outside"),
        _session(threadId=""),
        _session(threadId=23),
    ],
)
def test_binding_requires_explicit_matching_bot_engine_and_safe_id(session):
    bindings = TaskRequestBuilder._build_legacy_session_bindings(
        SimpleNamespace(id=123, user_id=7),
        SimpleNamespace(id=7),
        [{"id": 23, "shell_type": "Codex"}],
        [session],
    )
    assert bindings == []


def test_binding_normalizes_persisted_aliases_and_uses_current_task_identity():
    persisted = TaskRequestBuilder._extract_persisted_sessions(
        [
            SimpleNamespace(
                result={
                    "executor_session": {
                        "agent": "Claude Code",
                        "bot_id": "23",
                        "session_id": "claude-session",
                        "task_id": 999,
                        "user_id": 999,
                    }
                }
            )
        ]
    )
    bindings = TaskRequestBuilder._build_legacy_session_bindings(
        SimpleNamespace(id=123, user_id=7),
        SimpleNamespace(id=7),
        [{"id": 23, "shell_type": "ClaudeCode"}],
        persisted,
    )
    assert bindings == [
        {
            "agent": "Claude Code",
            "botId": "23",
            "sessionId": "claude-session",
            "task_id": 123,
            "user_id": 7,
        }
    ]


def test_binding_rejects_non_owner_even_if_sessions_were_provided():
    assert (
        TaskRequestBuilder._build_legacy_session_bindings(
            SimpleNamespace(id=123, user_id=7),
            SimpleNamespace(id=8),
            [{"id": 23, "shell_type": "Codex"}],
            [_session()],
        )
        == []
    )
