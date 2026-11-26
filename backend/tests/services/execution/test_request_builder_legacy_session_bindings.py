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
@pytest.mark.parametrize("shell", ["Codex", "ClaudeCode"])
@pytest.mark.parametrize("explicit_subscription", [False, True])
def test_subscription_reads_bounded_sessions_even_without_chat_history(
    monkeypatch, deleted, shell, explicit_subscription
):
    builder = TaskRequestBuilder(Mock())
    session = (
        _session()
        if shell == "Codex"
        else {"agent": "ClaudeCode", "botId": 23, "sessionId": "old-session"}
    )
    bounded = Mock(return_value=[session, session])
    monkeypatch.setattr(subtask_store, "list_recent_executor_sessions_by_task", bounded)
    unbounded = Mock(side_effect=AssertionError("Must not load assistant payloads"))
    monkeypatch.setattr(subtask_store, "list_assistant_by_task", unbounded)

    inherited, bindings = builder._build_session_context(
        task=SimpleNamespace(
            id=123, user_id=7, is_active=1 if explicit_subscription else 2
        ),
        user=SimpleNamespace(id=7),
        bot_configs=[{"id": 23, "shell_type": shell}],
        fork_sessions=[],
        executor_deleted=deleted,
        new_session=False,
        is_subscription=explicit_subscription,
    )

    bounded.assert_called_once_with(
        builder.db, task_id=123, owner_user_id=7, bot_ids=[23]
    )
    unbounded.assert_not_called()
    assert inherited == ([session] if deleted else [])
    assert bindings == [{**session, "task_id": 123, "user_id": 7}]


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


def test_owned_unproven_continuation_starts_a_new_session(test_db, mocker):
    builder = TaskRequestBuilder(test_db)
    mocker.patch.object(
        builder,
        "_build_session_context",
        return_value=([], []),
    )
    mocker.patch(
        "app.services.execution.request_builder.ExecutionRequest",
        side_effect=lambda **kwargs: SimpleNamespace(
            new_session=kwargs["new_session"],
            legacy_session_fallback=kwargs["legacy_session_fallback"],
            bot=kwargs["bot"],
            skill_configs=[],
            preload_skills=[],
            user_selected_skills=[],
            skill_names=[],
            system_prompt=kwargs["system_prompt"],
            task_id=kwargs["task_id"],
            subtask_id=kwargs["subtask_id"],
            attachments=[],
            auth_token="task-jwt",
            backend_url="http://backend",
        ),
    )
    mocker.patch(
        "app.services.execution.request_builder.Team.model_validate",
        return_value=SimpleNamespace(
            spec=SimpleNamespace(collaborationModel="solo", members=[])
        ),
    )
    mocker.patch.object(
        builder,
        "_get_bot_for_subtask",
        return_value=SimpleNamespace(id=23, name="bot", namespace="default"),
    )
    mocker.patch.object(builder, "_build_user_info", return_value={"id": 7})
    mocker.patch.object(builder, "_get_model_config", return_value={})
    mocker.patch.object(builder, "_get_base_system_prompt", return_value="sys")
    mocker.patch.object(builder, "_inject_conditional_provider_skills", return_value=[])
    mocker.patch.object(builder, "_get_bot_skills", return_value=([], [], [], {}))
    mocker.patch.object(
        builder,
        "_build_bot_config",
        return_value=[{"id": 23, "shell_type": "ClaudeCode"}],
    )
    mocker.patch.object(builder, "_build_mcp_servers", return_value=[])
    mocker.patch.object(builder, "_is_group_chat", return_value=False)
    mocker.patch.object(builder, "_generate_auth_token", return_value="task-jwt")
    mocker.patch.object(
        builder, "_generate_skill_identity_token", return_value="skill-jwt"
    )
    mocker.patch.object(builder, "_build_workspace", return_value={})

    request = builder.build(
        subtask=SimpleNamespace(id=2, message_id=33, executor_deleted_at=False),
        task=SimpleNamespace(
            id=123,
            user_id=7,
            json={"spec": {}},
            project_id=None,
        ),
        user=SimpleNamespace(id=7, user_name="alice"),
        team=SimpleNamespace(
            id=5, user_id=7, name="team", namespace="default", json={}
        ),
        message="continue",
        allow_new_session_fallback=True,
    )

    assert request.new_session is True
    assert request.legacy_session_fallback is True


@pytest.mark.parametrize(
    (
        "allow_fallback",
        "new_session",
        "user_id",
        "shell",
        "inherited",
        "bindings",
        "expected",
    ),
    [
        (True, False, 7, "Codex", [], [], True),
        (False, False, 7, "Codex", [], [], False),
        (True, False, 8, "Codex", [], [], False),
        (True, False, 7, "Chat", [], [], False),
        (True, True, 7, "Codex", [], [], False),
        (True, False, 7, "Codex", [_session()], [], False),
        (True, False, 7, "Codex", [], [_session()], False),
    ],
)
def test_unproven_session_fallback_is_caller_and_context_gated(
    allow_fallback, new_session, user_id, shell, inherited, bindings, expected
):
    should_start = TaskRequestBuilder._should_start_new_session(
        allow_new_session_fallback=allow_fallback,
        new_session=new_session,
        task=SimpleNamespace(id=123, user_id=7),
        user=SimpleNamespace(id=user_id),
        bot_configs=[{"shell_type": shell}],
        inherited_sessions=inherited,
        legacy_session_bindings=bindings,
    )

    assert should_start is expected


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
