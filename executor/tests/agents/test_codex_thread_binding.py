# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor.agents.codex.codex_agent import CodeXAgent
from executor.agents.codex.config_builder import CodeXConfig
from executor.agents.codex.session_store import CodeXSessionStore
from shared.models.execution import ExecutionRequest
from shared.status import TaskStatus


def _request(**overrides):
    fields = {
        "task_id": 1548,
        "subtask_id": 1972,
        "prompt": "hello",
        "model_config": {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "https://copilot.weibo.com/v1",
            "api_key": "token",
            "api_format": "responses",
        },
    }
    fields.update(overrides)
    return ExecutionRequest(**fields)


def _agent(session_root, **request_overrides):
    agent = CodeXAgent(_request(**request_overrides), MagicMock())
    agent.codex_config = CodeXConfig(
        codex_bin="/bin/codex",
        model="gpt-5.5",
        model_provider="wecode-openai",
        config_overrides=(),
        thread_config={},
        effort=None,
        summary=None,
    )
    agent._session_store = CodeXSessionStore(session_root)
    return agent


def _thread(thread_id):
    return SimpleNamespace(id=thread_id, turn=AsyncMock())


async def _empty_event_stream():
    if False:
        yield None


@pytest.mark.asyncio
async def test_local_codex_thread_id_resumes_exact_thread_and_saves_session(tmp_path):
    agent = _agent(tmp_path, local_codex_thread_id="thread-local-1")
    agent.project_path = "/tmp/project"
    agent._codex = SimpleNamespace(
        thread_resume=AsyncMock(return_value=_thread("thread-local-1")),
        thread_start=AsyncMock(),
    )

    await agent._open_thread()

    agent._codex.thread_resume.assert_awaited_once()
    resume_args, resume_kwargs = agent._codex.thread_resume.await_args
    assert resume_args == ("thread-local-1",)
    assert resume_kwargs["cwd"] == "/tmp/project"
    agent._codex.thread_start.assert_not_awaited()
    assert agent.thread_id == "thread-local-1"
    assert agent._session_store.load(agent.task_id, agent._bot_id, False) == (
        "thread-local-1"
    )


@pytest.mark.asyncio
async def test_bound_thread_resume_failure_does_not_start_new_thread(tmp_path):
    agent = _agent(tmp_path, local_codex_thread_id="thread-local-2")
    agent._codex = SimpleNamespace(
        thread_resume=AsyncMock(side_effect=RuntimeError("resume failed")),
        thread_start=AsyncMock(),
    )

    with pytest.raises(RuntimeError, match="resume failed"):
        await agent._open_thread()

    agent._codex.thread_resume.assert_awaited_once()
    agent._codex.thread_start.assert_not_awaited()


@pytest.mark.asyncio
async def test_bound_thread_resume_omits_cwd_when_project_path_is_empty(tmp_path):
    agent = _agent(tmp_path, local_codex_thread_id="thread-local-3")
    agent.project_path = None
    agent._codex = SimpleNamespace(
        thread_resume=AsyncMock(return_value=_thread("thread-local-3")),
        thread_start=AsyncMock(),
    )

    await agent._open_thread()

    resume_kwargs = agent._codex.thread_resume.await_args.kwargs
    assert "cwd" not in resume_kwargs


def test_thread_kwargs_accepts_sdk_without_thread_option_enums(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "openai_codex", ModuleType("openai_codex"))
    agent = _agent(tmp_path)

    kwargs = agent._build_thread_kwargs()

    assert kwargs["approval_mode"] == "deny_all"
    assert kwargs["sandbox"] == "full-access"


@pytest.mark.asyncio
async def test_local_codex_thread_source_does_not_create_default_workspace(tmp_path):
    agent = _agent(tmp_path, workspace_source="local_codex_thread")

    with patch.object(agent, "download_code", AsyncMock()):
        status, error = await agent.pre_execute()

    assert status == TaskStatus.SUCCESS
    assert error is None
    assert agent.project_path is None


@pytest.mark.asyncio
async def test_file_change_tracking_is_skipped_without_project_path(tmp_path):
    agent = _agent(tmp_path, device_id="device-1")
    agent.project_path = None
    agent._codex = SimpleNamespace(close=AsyncMock())
    agent._thread = SimpleNamespace(
        turn=AsyncMock(
            return_value=SimpleNamespace(stream=lambda: _empty_event_stream())
        )
    )

    with (
        patch.object(agent, "_start_codex_client", AsyncMock()),
        patch.object(agent, "_open_thread", AsyncMock()),
        patch.object(agent, "_notify_client_created", AsyncMock()),
        patch.object(agent, "_process_attachments_for_codex"),
        patch.object(agent, "_build_turn_input", return_value="hello"),
        patch.object(agent, "_build_reasoning_params", return_value=(None, None)),
        patch.object(agent, "_sandbox_full_access", return_value="full-access"),
        patch(
            "executor.agents.codex.codex_agent.NativeTurnFileChangeTracker"
        ) as tracker_class,
    ):
        status = await agent.execute_async()

    assert status == TaskStatus.FAILED
    tracker_class.assert_not_called()
    agent.emitter.set_completion_fields_provider.assert_called_with(None)


@pytest.mark.asyncio
async def test_unbound_codex_session_store_resume_falls_back_to_start(tmp_path):
    agent = _agent(tmp_path)
    agent._session_store.save(agent.task_id, agent._bot_id, "thread-stored")
    new_thread = _thread("thread-new")
    agent._codex = SimpleNamespace(
        thread_resume=AsyncMock(side_effect=RuntimeError("missing thread")),
        thread_start=AsyncMock(return_value=new_thread),
    )

    await agent._open_thread()

    agent._codex.thread_resume.assert_awaited_once()
    agent._codex.thread_start.assert_awaited_once()
    assert agent._session_store.load(agent.task_id, agent._bot_id, False) == (
        "thread-new"
    )
