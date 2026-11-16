# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execute the Backend push command against real local Git repositories."""

import shlex
import subprocess
from pathlib import Path

import pytest

from app.services.device.command_registry import GIT_PUSH_COMMAND


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    git(tmp_path, "init", "--bare", "origin.git")
    git(tmp_path, "init", "work")
    repo = tmp_path / "work"
    git(repo, "checkout", "-b", "feature/topic")
    git(repo, "config", "user.name", "Git portability test")
    git(repo, "config", "user.email", "git-test@example.invalid")
    (repo / "README.md").write_text("Git portability\n", encoding="utf-8")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "test: initial commit")
    git(repo, "remote", "add", "origin", str(tmp_path / "origin.git"))
    return repo


def push(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        shlex.split(GIT_PUSH_COMMAND), cwd=repo, capture_output=True, text=True
    )


def test_push_publishes_current_branch_and_sets_upstream(repository: Path) -> None:
    result = push(repository)
    assert result.returncode == 0, result.stderr
    assert (
        git(repository, "rev-parse", "--abbrev-ref", "@{u}") == "origin/feature/topic"
    )
    assert git(
        repository.parent / "origin.git", "rev-parse", "refs/heads/feature/topic"
    ) == git(repository, "rev-parse", "HEAD")


def test_push_rejects_detached_head_without_publishing(repository: Path) -> None:
    git(repository, "checkout", "--detach")
    result = push(repository)
    assert result.returncode == 64
    assert "Cannot push detached HEAD" in result.stderr
    assert git(repository.parent / "origin.git", "for-each-ref", "refs/heads/") == ""


def test_push_preserves_remote_failure(repository: Path) -> None:
    git(repository, "remote", "remove", "origin")
    result = push(repository)
    assert result.returncode not in {0, 64}, result.stderr
    assert "Cannot push detached HEAD" not in result.stderr
