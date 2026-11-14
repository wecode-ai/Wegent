# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise cloud-device branch comparisons against real isolated repositories."""

import shlex
import subprocess
from pathlib import Path

import pytest

from app.services.device.git_diff_commands import (
    GIT_BRANCH_DIFF_COMMAND,
    GIT_BRANCH_DIFF_SHORTSTAT_COMMAND,
)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.name", "Tests")
    git(tmp_path, "config", "user.email", "tests@example.com")
    (tmp_path / "base.txt").write_text("base\n")
    git(tmp_path, "add", "--all")
    git(tmp_path, "commit", "-qm", "base")
    git(tmp_path, "checkout", "-qb", "comparison")
    (tmp_path / "comparison.txt").write_text("comparison\n")
    git(tmp_path, "add", "--all")
    git(tmp_path, "commit", "-qm", "comparison")
    git(tmp_path, "update-ref", "refs/remotes/origin/comparison", "HEAD")
    git(tmp_path, "checkout", "-qb", "feature/test")
    (tmp_path / "feature.txt").write_text("feature\n")
    git(tmp_path, "add", "--all")
    git(tmp_path, "commit", "-qm", "feature")
    return tmp_path


def run(repo: Path, command: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [*shlex.split(command), *args], cwd=repo, capture_output=True, text=True
    )


def test_selected_baseline_includes_worktree_and_untracked(repository: Path) -> None:
    (repository / "feature.txt").write_text("feature\nworking\n")
    (repository / "untracked space.txt").write_text("new\n")
    default = run(repository, GIT_BRANCH_DIFF_COMMAND)
    selected = run(repository, GIT_BRANCH_DIFF_COMMAND, "origin/comparison")
    assert default.returncode == selected.returncode == 0
    assert "comparison.txt" in default.stdout
    assert "comparison.txt" not in selected.stdout
    assert "+working" in selected.stdout
    assert "untracked space.txt" in selected.stdout
    assert "+new" in selected.stdout


def test_shortstat_uses_same_explicit_baseline(repository: Path) -> None:
    selected = run(repository, GIT_BRANCH_DIFF_SHORTSTAT_COMMAND, "comparison")
    assert selected.returncode == 0
    assert "1 file changed" in selected.stdout
    assert "1 insertion(+)" in selected.stdout


@pytest.mark.parametrize(
    "command", [GIT_BRANCH_DIFF_COMMAND, GIT_BRANCH_DIFF_SHORTSTAT_COMMAND]
)
@pytest.mark.parametrize(
    "ref", ["", "--output=leak", "missing", "HEAD~1", "main;touch pwn", "@"]
)
def test_invalid_explicit_ref_fails_without_default_diff(
    repository: Path, command: str, ref: str
) -> None:
    result = run(repository, command, ref)
    assert result.returncode != 0
    assert result.stdout == ""
    assert not (repository / "pwn").exists()


def test_unrelated_baseline_fails_instead_of_defaulting(repository: Path) -> None:
    git(repository, "checkout", "--orphan", "unrelated")
    git(repository, "rm", "-rf", ".")
    (repository / "other.txt").write_text("other\n")
    git(repository, "add", "--all")
    git(repository, "commit", "-qm", "unrelated")
    git(repository, "checkout", "feature/test")
    result = run(repository, GIT_BRANCH_DIFF_COMMAND, "unrelated")
    assert result.returncode != 0
    assert result.stdout == ""


def test_explicit_comparison_uses_a_registered_read_only_command() -> None:
    from app.services.device.command_registry import resolve_local_device_command
    from app.services.device.command_service import REMOTE_READ_ONLY_COMMAND_KEYS

    definition = resolve_local_device_command("git_compare_branch_diff", {})
    assert definition is not None
    assert definition.command == GIT_BRANCH_DIFF_COMMAND
    assert "git_compare_branch_diff" in REMOTE_READ_ONLY_COMMAND_KEYS
