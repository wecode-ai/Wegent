# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from executor.agents.base import Agent
from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.agents.claude_code.session_manager import SessionManager
from shared.models.execution import ExecutionRequest


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
