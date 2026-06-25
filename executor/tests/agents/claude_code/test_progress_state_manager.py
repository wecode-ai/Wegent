# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Claude Code progress workbench git monitoring."""

import subprocess
from unittest.mock import MagicMock

from git import GitCommandError

from executor.agents.claude_code import progress_state_manager
from executor.agents.claude_code.progress_state_manager import ProgressStateManager
from shared.models.execution import ExecutionRequest


def test_git_file_changes_skip_repository_without_head(tmp_path, monkeypatch):
    """Unborn Git repositories should not log git diff failures every poll."""
    repo_path = tmp_path / "repo"
    repo_path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo_path, check=True)

    warning_calls = []
    monkeypatch.setattr(
        progress_state_manager.logger,
        "warning",
        lambda *args, **kwargs: warning_calls.append((args, kwargs)),
    )

    manager = ProgressStateManager(
        thinking_manager=MagicMock(),
        task_data=ExecutionRequest(task_id=1, subtask_id=2),
        report_progress_callback=MagicMock(),
        project_path=str(repo_path),
    )

    assert manager._get_git_file_changes() == []
    assert warning_calls == []


def test_git_file_changes_treat_git_command_error_as_unavailable(tmp_path, monkeypatch):
    """Auxiliary polling should not warn every time git diff is unavailable."""
    repo_path = tmp_path / "repo"
    repo_path.mkdir()

    class FakeIndex:
        def diff(self, *args, **kwargs):
            raise GitCommandError("git diff", 128)

    class FakeRepo:
        def __init__(self, path):
            self.path = path
            self.index = FakeIndex()

    warning_calls = []
    monkeypatch.setattr(progress_state_manager, "Repo", FakeRepo)
    monkeypatch.setattr(
        progress_state_manager.logger,
        "warning",
        lambda *args, **kwargs: warning_calls.append((args, kwargs)),
    )

    manager = ProgressStateManager(
        thinking_manager=MagicMock(),
        task_data=ExecutionRequest(task_id=1, subtask_id=2),
        report_progress_callback=MagicMock(),
        project_path=str(repo_path),
    )

    assert manager._get_git_file_changes() == []
    assert warning_calls == []
