# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import MagicMock, patch

from executor.agents.base import Agent
from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.agents.claude_code.session_manager import SessionManager
from executor.agents.claude_code.skill_deployer import setup_coordinate_mode
from executor.agents.codex.codex_agent import CodeXAgent
from shared.models.execution import ExecutionRequest


def _enable_standalone_chats(monkeypatch):
    monkeypatch.setenv("WEGENT_EXECUTOR_STANDALONE_CHATS_ENABLED", "true")


def test_git_project_path_uses_project_workspace_root_when_project_id_present():
    request = ExecutionRequest(
        task_id=1001,
        subtask_id=2001,
        project_id=42,
        git_url="https://github.com/example/repo.git",
    )
    agent = Agent(request, MagicMock())

    with patch(
        "executor.agents.base.config.get_workspace_root", return_value="/workspace"
    ):
        path = agent._resolve_git_project_path("repo")

    assert path == "/workspace/projects/42/repo"


def test_git_project_path_honors_explicit_relative_checkout_path():
    request = ExecutionRequest(
        task_id=1001,
        subtask_id=2001,
        project_id=42,
        project_workspace_path="custom/repo",
        git_url="https://github.com/example/repo.git",
    )
    agent = Agent(request, MagicMock())

    with patch(
        "executor.agents.base.config.get_workspace_root", return_value="/workspace"
    ):
        path = agent._resolve_git_project_path("repo")

    assert path == "/workspace/custom/repo"


def test_session_manager_uses_executor_session_root_when_set(tmp_path):
    session_root = tmp_path / ".wegent-executor" / "sessions"
    SessionManager.set_task_session_root(1001, str(session_root))

    try:
        path = SessionManager.get_session_id_file_path(1001)
    finally:
        SessionManager.set_task_session_root(1001, None)

    assert path == str(session_root / "1001" / ".claude_session_id")


def test_project_workspace_sets_session_root_outside_workspace(tmp_path):
    request = ExecutionRequest(
        task_id=1001,
        subtask_id=2001,
        project_id=42,
        workspace_source="git",
        git_url="https://github.com/example/repo.git",
    )
    agent = ClaudeCodeAgent.__new__(ClaudeCodeAgent)
    agent.task_data = request
    agent.task_id = request.task_id
    agent.options = {}
    agent.project_path = None

    executor_home = tmp_path / ".wegent-executor"
    with (
        patch(
            "executor.agents.claude_code.claude_code_agent.config.get_workspace_root",
            return_value=str(tmp_path / "workspace"),
        ),
        patch(
            "executor.agents.claude_code.claude_code_agent.config.WEGENT_EXECUTOR_HOME",
            str(executor_home),
        ),
        patch.object(SessionManager, "set_task_session_root") as set_session_root,
    ):
        agent._prepare_project_workspace()

    set_session_root.assert_called_once_with(1001, str(executor_home / "sessions"))
    assert ".wegent" not in agent.project_path


def test_standalone_workspace_path_sets_cwd_without_project_id(tmp_path):
    standalone_workspace = tmp_path / "chats" / "2026-05-29" / "hello"
    request = ExecutionRequest(
        task_id=1002,
        subtask_id=2002,
        workspace_source="local_path",
        project_workspace_path=str(standalone_workspace),
    )
    agent = ClaudeCodeAgent.__new__(ClaudeCodeAgent)
    agent.task_data = request
    agent.task_id = request.task_id
    agent.options = {}
    agent.project_path = None

    executor_home = tmp_path / ".wegent-executor"
    with (
        patch(
            "executor.agents.claude_code.claude_code_agent.config.WEGENT_EXECUTOR_HOME",
            str(executor_home),
        ),
        patch.object(SessionManager, "set_task_session_root") as set_session_root,
    ):
        agent._prepare_project_workspace()

    assert agent.options["cwd"] == str(standalone_workspace)
    assert standalone_workspace.exists()
    set_session_root.assert_called_once_with(1002, str(executor_home / "sessions"))


def test_initial_standalone_chat_prepares_request_named_cwd(tmp_path, monkeypatch):
    workspace_root = tmp_path / "workspace"
    task_dir = workspace_root / "1003"
    (task_dir / ".claude").mkdir(parents=True)
    chats_root = tmp_path / "chats"
    request = ExecutionRequest(
        task_id=1003,
        subtask_id=2003,
        project_id=0,
        standalone_chat_workspace=True,
        prompt="hello-new-wework",
    )
    agent = ClaudeCodeAgent.__new__(ClaudeCodeAgent)
    agent.task_data = request
    agent.task_id = request.task_id
    agent.prompt = request.prompt
    agent.options = {}
    agent.project_path = None
    agent._claude_config_dir = str(task_dir / ".claude")

    executor_home = tmp_path / ".wegent-executor"
    _enable_standalone_chats(monkeypatch)
    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    with (
        patch(
            "executor.agents.claude_code.claude_code_agent.config.get_workspace_root",
            return_value=str(workspace_root),
        ),
        patch(
            "executor.agents.claude_code.standalone_chat_workspace.config.get_workspace_root",
            return_value=str(workspace_root),
        ),
        patch(
            "executor.agents.claude_code.claude_code_agent.config.WEGENT_EXECUTOR_HOME",
            str(executor_home),
        ),
        patch(
            "executor.agents.claude_code.claude_code_agent.config.EXECUTOR_MODE",
            "local",
        ),
        patch.object(SessionManager, "set_task_session_root") as set_session_root,
    ):
        agent._prepare_project_workspace()

    target = chats_root / datetime.now().strftime("%Y-%m-%d") / "hello-new-wework"
    assert request.workspace_source == "local_path"
    assert request.project_workspace_path == str(target)
    assert agent.options["cwd"] == str(target)
    assert agent.project_path == str(target)
    assert agent._claude_config_dir == str(task_dir / ".claude")
    assert not (target / ".claude").exists()
    assert (task_dir / ".claude").exists()
    assert target.exists()
    set_session_root.assert_called_once_with(1003, str(executor_home / "sessions"))


async def test_codex_pre_execute_uses_project_workspace_path(tmp_path):
    project_path = tmp_path / "workspace" / "projects" / "hello"
    request = ExecutionRequest(
        task_id=1546,
        subtask_id=1970,
        workspace_source="local_path",
        project_workspace_path=str(project_path),
        model_config={
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "https://copilot.weibo.com/v1",
            "api_key": "token",
            "api_format": "responses",
        },
    )
    agent = CodeXAgent(request, MagicMock())

    status, error = await agent.pre_execute()

    assert error is None
    assert agent.project_path == str(project_path)
    assert project_path.exists()
    assert status.name == "SUCCESS"


def test_codex_project_task_marks_api_project_id():
    request = ExecutionRequest(
        task_id=1546,
        subtask_id=1970,
        project_id=42,
        model_config={
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "https://copilot.weibo.com/v1",
            "api_key": "token",
            "api_format": "responses",
        },
    )
    agent = CodeXAgent(request, MagicMock())

    status = agent.initialize()

    assert status.name == "SUCCESS"
    assert agent.codex_config is not None
    assert (
        'model_providers.wecode-openai.http_headers.wecode-project="42"'
        in agent.codex_config.config_overrides
    )
    assert not any(
        item == 'model_providers.wecode-openai.http_headers.wecode-source="wework"'
        for item in agent.codex_config.config_overrides
    )


async def test_initial_codex_standalone_chat_prepares_request_named_cwd(
    tmp_path, monkeypatch
):
    workspace_root = tmp_path / "workspace"
    task_dir = workspace_root / "1547"
    task_dir.mkdir(parents=True)
    (task_dir / "draft.txt").write_text("hello", encoding="utf-8")
    chats_root = tmp_path / "chats"
    request = ExecutionRequest(
        task_id=1547,
        subtask_id=1971,
        project_id=0,
        standalone_chat_workspace=True,
        prompt="hello codex workspace",
        model_config={
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "https://copilot.weibo.com/v1",
            "api_key": "token",
            "api_format": "responses",
        },
    )
    agent = CodeXAgent(request, MagicMock())

    _enable_standalone_chats(monkeypatch)
    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    with (
        patch(
            "executor.agents.base.config.get_workspace_root",
            return_value=str(workspace_root),
        ),
        patch(
            "executor.agents.claude_code.standalone_chat_workspace.config.get_workspace_root",
            return_value=str(workspace_root),
        ),
    ):
        status, error = await agent.pre_execute()

    target = chats_root / datetime.now().strftime("%Y-%m-%d") / "hello-codex-workspac"
    assert error is None
    assert status.name == "SUCCESS"
    assert request.workspace_source == "local_path"
    assert request.project_workspace_path == str(target)
    assert agent.project_path == str(target)
    assert (target / "draft.txt").read_text(encoding="utf-8") == "hello"
    agent.emitter.set_completion_fields_provider.assert_called_once()
    provider = agent.emitter.set_completion_fields_provider.call_args.args[0]
    assert provider() == {"standalone_chat_workspace_path": str(target)}


def test_initial_standalone_chat_coordinate_mode_keeps_claude_out_of_chat_dir(
    tmp_path,
    monkeypatch,
):
    workspace_root = tmp_path / "workspace"
    task_dir = workspace_root / "1004"
    (task_dir / ".claude").mkdir(parents=True)
    chats_root = tmp_path / "chats"
    request = ExecutionRequest(
        task_id=1004,
        subtask_id=2004,
        project_id=0,
        standalone_chat_workspace=True,
        prompt="coordinate-chat",
        mode="coordinate",
        bot=[
            {"id": 1, "name": "leader", "system_prompt": "Lead"},
            {"id": 2, "name": "worker", "system_prompt": "Work"},
        ],
    )
    agent = ClaudeCodeAgent.__new__(ClaudeCodeAgent)
    agent.task_data = request
    agent.task_id = request.task_id
    agent.prompt = request.prompt
    agent.options = {}
    agent.project_path = None
    agent._claude_config_dir = str(task_dir / ".claude")

    executor_home = tmp_path / ".wegent-executor"
    _enable_standalone_chats(monkeypatch)
    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    with (
        patch(
            "executor.agents.claude_code.claude_code_agent.config.get_workspace_root",
            return_value=str(workspace_root),
        ),
        patch(
            "executor.agents.claude_code.standalone_chat_workspace.config.get_workspace_root",
            return_value=str(workspace_root),
        ),
        patch(
            "executor.agents.claude_code.claude_code_agent.config.WEGENT_EXECUTOR_HOME",
            str(executor_home),
        ),
        patch.object(SessionManager, "set_task_session_root"),
    ):
        agent._prepare_project_workspace()
        setup_coordinate_mode(
            request,
            agent._coordinate_mode_workspace_path(),
            agent.options,
        )

    target = chats_root / datetime.now().strftime("%Y-%m-%d") / "coordinate-chat"
    assert agent.options["cwd"] == str(target)
    assert not (target / ".claude").exists()
    assert (task_dir / ".claude" / "agents" / "worker-2.md").exists()
