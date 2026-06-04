# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from executor.agents.codex.codex_agent import CodeXAgent
from executor.agents.codex.config_builder import CodeXConfig

from shared.models.execution import ExecutionRequest


def _agent(runtime_session_id=None, *, new_session=False):
    emitter = SimpleNamespace()
    task_data = ExecutionRequest(
        task_id=1664,
        subtask_id=1,
        auth_token="task-token",
        new_session=new_session,
        runtime_session_id=runtime_session_id,
        runtime_session_provider="codex",
    )
    agent = CodeXAgent(task_data, emitter)
    agent.project_path = "/tmp/wegent-test"
    agent.codex_config = CodeXConfig(
        codex_bin="codex",
        model="gpt-5.5",
        model_provider=None,
        config_overrides=(),
        thread_config={},
        effort=None,
        summary=None,
    )
    agent._build_thread_kwargs = lambda developer_instructions: {}
    return agent


@pytest.mark.asyncio
async def test_codex_first_turn_starts_thread_and_saves_runtime_session():
    agent = _agent()
    agent._codex = SimpleNamespace(
        thread_start=AsyncMock(return_value=SimpleNamespace(id="thread-new")),
        thread_resume=AsyncMock(),
    )
    agent._save_runtime_session = AsyncMock()

    await agent._open_thread()

    agent._codex.thread_start.assert_awaited_once()
    agent._codex.thread_resume.assert_not_called()
    agent._save_runtime_session.assert_awaited_once_with("thread-new")


@pytest.mark.asyncio
async def test_codex_existing_turn_resumes_without_saving_existing_session():
    agent = _agent("thread-existing")
    agent._codex = SimpleNamespace(
        thread_start=AsyncMock(),
        thread_resume=AsyncMock(return_value=SimpleNamespace(id="thread-existing")),
    )
    agent._save_runtime_session = AsyncMock()

    await agent._open_thread()

    agent._codex.thread_resume.assert_awaited_once_with("thread-existing")
    agent._codex.thread_start.assert_not_called()
    agent._save_runtime_session.assert_not_called()


@pytest.mark.asyncio
async def test_codex_resume_failure_does_not_start_replacement_session():
    agent = _agent("thread-stale")
    agent._codex = SimpleNamespace(
        thread_start=AsyncMock(return_value=SimpleNamespace(id="thread-new")),
        thread_resume=AsyncMock(side_effect=RuntimeError("missing thread")),
    )
    agent._save_runtime_session = AsyncMock()

    with pytest.raises(RuntimeError, match="missing thread"):
        await agent._open_thread()

    agent._codex.thread_resume.assert_awaited_once_with("thread-stale")
    agent._codex.thread_start.assert_not_called()
    agent._save_runtime_session.assert_not_called()


@pytest.mark.asyncio
async def test_codex_resume_rejects_mismatched_thread_id():
    agent = _agent("thread-existing")
    agent._codex = SimpleNamespace(
        thread_start=AsyncMock(),
        thread_resume=AsyncMock(return_value=SimpleNamespace(id="thread-other")),
    )
    agent._save_runtime_session = AsyncMock()

    with pytest.raises(RuntimeError, match="different session"):
        await agent._open_thread()

    agent._codex.thread_resume.assert_awaited_once_with("thread-existing")
    agent._codex.thread_start.assert_not_called()
    agent._save_runtime_session.assert_not_called()


@pytest.mark.asyncio
async def test_codex_new_session_ignores_existing_session_and_saves_new_thread():
    agent = _agent("thread-existing", new_session=True)
    agent._codex = SimpleNamespace(
        thread_start=AsyncMock(return_value=SimpleNamespace(id="thread-new")),
        thread_resume=AsyncMock(),
    )
    agent._save_runtime_session = AsyncMock()

    await agent._open_thread()

    agent._codex.thread_start.assert_awaited_once()
    agent._codex.thread_resume.assert_not_called()
    agent._save_runtime_session.assert_awaited_once_with("thread-new")
