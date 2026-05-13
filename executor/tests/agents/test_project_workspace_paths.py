# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from executor.agents.base import Agent
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


def test_session_manager_uses_project_session_root_when_set(tmp_path):
    project_root = tmp_path / "repo"
    SessionManager.set_task_session_root(1001, str(project_root))

    try:
        path = SessionManager.get_session_id_file_path(1001)
    finally:
        SessionManager.set_task_session_root(1001, None)

    assert path == str(
        project_root / ".wegent" / "sessions" / "1001" / ".claude_session_id"
    )
