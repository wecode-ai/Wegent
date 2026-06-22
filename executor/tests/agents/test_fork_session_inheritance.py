# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.agents.claude_code.session_manager import SessionManager
from executor.agents.codex.codex_agent import CodeXAgent
from executor.agents.codex.session_store import CodeXSessionStore
from shared.models.execution import ExecutionRequest


def _emitter() -> MagicMock:
    emitter = MagicMock()
    emitter.in_progress = AsyncMock()
    emitter.start = AsyncMock()
    emitter.done = AsyncMock()
    emitter.error = AsyncMock()
    emitter.text_delta = AsyncMock()
    return emitter


def test_claude_code_seeds_forked_task_session_from_inherited_session(tmp_path):
    request = ExecutionRequest(
        task_id=200,
        subtask_id=300,
        bot=[{"id": 987, "shell_type": "ClaudeCode"}],
        inherited_sessions=[
            {
                "agent": "ClaudeCode",
                "sourceTaskId": 100,
                "botId": 987,
                "sessionId": "source-claude-session",
            }
        ],
    )
    agent = ClaudeCodeAgent(request, _emitter())

    SessionManager.set_task_session_root(200, str(tmp_path / "sessions"))
    try:
        seeded = agent._seed_inherited_session()

        assert seeded is True
        assert (
            Path(SessionManager.get_session_id_file_path(200, 987)).read_text(
                encoding="utf-8"
            )
            == "source-claude-session"
        )
    finally:
        SessionManager.set_task_session_root(200, None)


def test_claude_code_does_not_seed_inherited_session_for_new_session(tmp_path):
    request = ExecutionRequest(
        task_id=201,
        subtask_id=301,
        new_session=True,
        bot=[{"id": 987, "shell_type": "ClaudeCode"}],
        inherited_sessions=[
            {
                "agent": "ClaudeCode",
                "sourceTaskId": 100,
                "botId": 987,
                "sessionId": "source-claude-session",
            }
        ],
    )
    agent = ClaudeCodeAgent(request, _emitter())

    SessionManager.set_task_session_root(201, str(tmp_path / "sessions"))
    try:
        seeded = agent._seed_inherited_session()

        assert seeded is False
        assert not Path(SessionManager.get_session_id_file_path(201, 987)).exists()
    finally:
        SessionManager.set_task_session_root(201, None)


@pytest.mark.asyncio
async def test_codex_resumes_inherited_thread_for_forked_task(tmp_path):
    request = ExecutionRequest(
        task_id=200,
        subtask_id=300,
        bot=[{"id": 654, "shell_type": "CodeX"}],
        inherited_sessions=[
            {
                "agent": "CodeX",
                "sourceTaskId": 100,
                "botId": 654,
                "threadId": "source-codex-thread",
            }
        ],
    )
    agent = CodeXAgent(request, _emitter())
    agent.codex_config = MagicMock(model="gpt-5", model_provider=None)
    agent.project_path = str(tmp_path / "workspace")
    Path(agent.project_path).mkdir()
    agent._session_store = CodeXSessionStore(root=tmp_path / "codex")
    agent._codex = AsyncMock()
    agent._codex.thread_resume = AsyncMock(
        return_value=MagicMock(id="source-codex-thread")
    )

    with patch.object(agent, "_build_thread_kwargs", return_value={}):
        await agent._open_thread()

    agent._codex.thread_resume.assert_awaited_once_with("source-codex-thread")
    assert (
        agent._session_store.load(200, 654, new_session=False) == "source-codex-thread"
    )


@pytest.mark.asyncio
async def test_codex_does_not_resume_inherited_thread_for_new_session(tmp_path):
    request = ExecutionRequest(
        task_id=201,
        subtask_id=301,
        new_session=True,
        bot=[{"id": 654, "shell_type": "CodeX"}],
        inherited_sessions=[
            {
                "agent": "CodeX",
                "sourceTaskId": 100,
                "botId": 654,
                "threadId": "source-codex-thread",
            }
        ],
    )
    agent = CodeXAgent(request, _emitter())
    agent.codex_config = MagicMock(model="gpt-5", model_provider=None)
    agent.project_path = str(tmp_path / "workspace")
    Path(agent.project_path).mkdir()
    agent._session_store = CodeXSessionStore(root=tmp_path / "codex")
    agent._codex = AsyncMock()
    agent._codex.thread_start = AsyncMock(return_value=MagicMock(id="new-thread"))

    with patch.object(agent, "_build_thread_kwargs", return_value={}):
        await agent._open_thread()

    agent._codex.thread_start.assert_awaited_once()
    assert agent._session_store.load(201, 654, new_session=False) == "new-thread"
