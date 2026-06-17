# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local device command RPC service."""

import gzip
import hashlib
import json
import os
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


def _run_git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    ).stdout


def _create_turn_file_changes_artifact(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _run_git(repo, "init", "-q")
    _run_git(repo, "config", "user.email", "tests@example.com")
    _run_git(repo, "config", "user.name", "Tests")
    changed_file = repo / "changed.txt"
    changed_file.write_text("before\n", encoding="utf-8")
    _run_git(repo, "add", "--all")
    _run_git(repo, "commit", "-qm", "initial")
    changed_file.write_text("after\n", encoding="utf-8")
    patch = _run_git(repo, "diff", "--binary", "HEAD")
    executor_home = tmp_path / "executor-home"
    artifact_dir = executor_home / "artifacts" / "turn-file-changes" / "10" / "20"
    artifact_dir.mkdir(parents=True)
    (artifact_dir / "changes.patch.gz").write_bytes(gzip.compress(patch))
    (artifact_dir / "metadata.json").write_text(
        json.dumps(
            {
                "version": 1,
                "task_id": 10,
                "subtask_id": 20,
                "workspace_path": str(repo.resolve()),
                "checksum": hashlib.sha256(patch).hexdigest(),
            }
        ),
        encoding="utf-8",
    )
    return repo, executor_home


def test_turn_file_changes_commands_are_registered():
    from app.services.device.command_registry import resolve_local_device_command

    review = resolve_local_device_command("turn_file_changes_review", {})
    revert = resolve_local_device_command("turn_file_changes_revert", {})

    assert review is not None
    assert revert is not None
    assert review.post_processor == "json"
    assert revert.post_processor == "json"


@pytest.mark.parametrize(
    "artifact_id",
    [
        "../../etc/passwd",
        "turn-file-changes/1/2/../../../secret",
    ],
)
def test_turn_file_changes_command_rejects_invalid_artifact_id(
    tmp_path,
    artifact_id,
):
    from app.services.device.command_registry import TURN_FILE_CHANGES_SCRIPT

    result = subprocess.run(
        ["python3", "-c", TURN_FILE_CHANGES_SCRIPT, "review", artifact_id],
        cwd=tmp_path,
        env={**os.environ, "WEGENT_EXECUTOR_HOME": str(tmp_path / "home")},
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid artifact id" in result.stdout


def test_turn_file_changes_review_returns_validated_diff(tmp_path):
    from app.services.device.command_registry import TURN_FILE_CHANGES_SCRIPT

    repo, executor_home = _create_turn_file_changes_artifact(tmp_path)
    result = subprocess.run(
        [
            "python3",
            "-c",
            TURN_FILE_CHANGES_SCRIPT,
            "review",
            "turn-file-changes/10/20",
        ],
        cwd=repo,
        env={**os.environ, "WEGENT_EXECUTOR_HOME": str(executor_home)},
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["success"] is True
    assert payload["diff"].startswith("diff --git a/changed.txt b/changed.txt")


def test_turn_file_changes_revert_is_conflict_safe(tmp_path):
    from app.services.device.command_registry import TURN_FILE_CHANGES_SCRIPT

    repo, executor_home = _create_turn_file_changes_artifact(tmp_path)
    (repo / "changed.txt").write_text("later change\n", encoding="utf-8")
    result = subprocess.run(
        [
            "python3",
            "-c",
            TURN_FILE_CHANGES_SCRIPT,
            "revert",
            "turn-file-changes/10/20",
        ],
        cwd=repo,
        env={**os.environ, "WEGENT_EXECUTOR_HOME": str(executor_home)},
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout)["status"] == "conflicted"
    assert (repo / "changed.txt").read_text(encoding="utf-8") == "later change\n"


def test_turn_file_changes_revert_applies_reverse_patch(tmp_path):
    from app.services.device.command_registry import TURN_FILE_CHANGES_SCRIPT

    repo, executor_home = _create_turn_file_changes_artifact(tmp_path)
    result = subprocess.run(
        [
            "python3",
            "-c",
            TURN_FILE_CHANGES_SCRIPT,
            "revert",
            "turn-file-changes/10/20",
        ],
        cwd=repo,
        env={**os.environ, "WEGENT_EXECUTOR_HOME": str(executor_home)},
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == {"success": True, "status": "reverted"}
    assert (repo / "changed.txt").read_text(encoding="utf-8") == "before\n"


def test_local_device_command_registry_default_includes_diagnostic_commands():
    """Default command registry should include basic diagnostic commands."""
    from app.core.config import Settings
    from app.services.device.command_registry import resolve_local_device_command

    settings = Settings()

    pwd_definition = resolve_local_device_command("pwd", settings.LOCAL_DEVICE_COMMANDS)
    ls_definition = resolve_local_device_command("ls_a", settings.LOCAL_DEVICE_COMMANDS)
    home_dir_definition = resolve_local_device_command(
        "home_dir", settings.LOCAL_DEVICE_COMMANDS
    )
    project_workspace_root_definition = resolve_local_device_command(
        "project_workspace_root", settings.LOCAL_DEVICE_COMMANDS
    )
    ls_dirs_definition = resolve_local_device_command(
        "ls_dirs", settings.LOCAL_DEVICE_COMMANDS
    )
    mkdir_definition = resolve_local_device_command(
        "mkdir_p", settings.LOCAL_DEVICE_COMMANDS
    )
    path_exists_definition = resolve_local_device_command(
        "path_exists", settings.LOCAL_DEVICE_COMMANDS
    )
    git_clone_definition = resolve_local_device_command(
        "git_clone", settings.LOCAL_DEVICE_COMMANDS
    )
    git_is_worktree_definition = resolve_local_device_command(
        "git_is_worktree", settings.LOCAL_DEVICE_COMMANDS
    )
    find_worktree_dirs_definition = resolve_local_device_command(
        "find_worktree_dirs", settings.LOCAL_DEVICE_COMMANDS
    )
    git_worktree_remove_definition = resolve_local_device_command(
        "git_worktree_remove", settings.LOCAL_DEVICE_COMMANDS
    )
    remove_worktree_dir_definition = resolve_local_device_command(
        "remove_worktree_dir", settings.LOCAL_DEVICE_COMMANDS
    )
    git_branch_definition = resolve_local_device_command(
        "git_branch", settings.LOCAL_DEVICE_COMMANDS
    )
    git_branch_list_definition = resolve_local_device_command(
        "git_branch_list", settings.LOCAL_DEVICE_COMMANDS
    )
    git_checkout_definition = resolve_local_device_command(
        "git_checkout", settings.LOCAL_DEVICE_COMMANDS
    )
    git_checkout_new_definition = resolve_local_device_command(
        "git_checkout_new", settings.LOCAL_DEVICE_COMMANDS
    )
    git_diff_shortstat_definition = resolve_local_device_command(
        "git_diff_shortstat", settings.LOCAL_DEVICE_COMMANDS
    )
    git_diff_definition = resolve_local_device_command(
        "git_diff", settings.LOCAL_DEVICE_COMMANDS
    )
    git_branch_diff_shortstat_definition = resolve_local_device_command(
        "git_branch_diff_shortstat", settings.LOCAL_DEVICE_COMMANDS
    )
    git_remote_url_definition = resolve_local_device_command(
        "git_remote_url", settings.LOCAL_DEVICE_COMMANDS
    )
    git_add_all_definition = resolve_local_device_command(
        "git_add_all", settings.LOCAL_DEVICE_COMMANDS
    )
    git_commit_definition = resolve_local_device_command(
        "git_commit", settings.LOCAL_DEVICE_COMMANDS
    )
    ls_skills_definition = resolve_local_device_command(
        "ls_skills", settings.LOCAL_DEVICE_COMMANDS
    )
    setup_shared_skills_definition = resolve_local_device_command(
        "setup_shared_skills", settings.LOCAL_DEVICE_COMMANDS
    )
    open_terminal_definition = resolve_local_device_command(
        "open_terminal", settings.LOCAL_DEVICE_COMMANDS
    )
    sync_runtime_auth_file_definition = resolve_local_device_command(
        "sync_runtime_auth_file", settings.LOCAL_DEVICE_COMMANDS
    )
    read_runtime_auth_file_definition = resolve_local_device_command(
        "read_runtime_auth_file", settings.LOCAL_DEVICE_COMMANDS
    )

    assert pwd_definition is not None
    assert pwd_definition.command == "pwd"
    assert pwd_definition.post_processor is None
    assert ls_definition is not None
    assert ls_definition.command == "ls -a"
    assert ls_definition.post_processor == "file_list"
    assert home_dir_definition is not None
    assert home_dir_definition.command == "printenv HOME"
    assert home_dir_definition.post_processor is None
    assert project_workspace_root_definition is not None
    assert "WEGENT_EXECUTOR_PROJECTS_DIR" in project_workspace_root_definition.command
    assert "WECODE_HOME" in project_workspace_root_definition.command
    assert project_workspace_root_definition.post_processor is None
    assert ls_dirs_definition is not None
    assert ls_dirs_definition.command == "ls -a -p"
    assert ls_dirs_definition.post_processor == "directory_list"
    assert mkdir_definition is not None
    assert mkdir_definition.command == "mkdir -p"
    assert mkdir_definition.post_processor is None
    assert path_exists_definition is not None
    assert path_exists_definition.command == "test -e"
    assert path_exists_definition.post_processor is None
    assert git_clone_definition is not None
    assert git_clone_definition.command == "git clone"
    assert git_clone_definition.post_processor is None
    assert git_is_worktree_definition is not None
    assert "rev-parse --is-inside-work-tree" in git_is_worktree_definition.command
    assert git_is_worktree_definition.post_processor is None
    assert find_worktree_dirs_definition is not None
    assert "find" in find_worktree_dirs_definition.command
    assert "mindepth 2" in find_worktree_dirs_definition.command
    assert find_worktree_dirs_definition.post_processor == "file_list"
    assert git_worktree_remove_definition is not None
    assert "worktree remove --force" in git_worktree_remove_definition.command
    assert git_worktree_remove_definition.post_processor is None
    assert remove_worktree_dir_definition is not None
    assert "rm -rf" in remove_worktree_dir_definition.command
    assert "refusing unsafe worktree path" in remove_worktree_dir_definition.command
    assert remove_worktree_dir_definition.post_processor is None
    assert git_branch_definition is not None
    assert git_branch_definition.command == "git branch --show-current"
    assert git_branch_definition.post_processor is None
    assert git_branch_list_definition is not None
    assert git_branch_list_definition.command == "git branch --format=%(refname:short)"
    assert git_branch_list_definition.post_processor is None
    assert git_checkout_definition is not None
    assert git_checkout_definition.command == "git checkout"
    assert git_checkout_definition.post_processor is None
    assert git_checkout_new_definition is not None
    assert git_checkout_new_definition.command == "git checkout -b"
    assert git_checkout_new_definition.post_processor is None
    assert git_diff_shortstat_definition is not None
    assert git_diff_shortstat_definition.command == "git diff --shortstat"
    assert git_diff_shortstat_definition.post_processor is None
    assert git_diff_definition is not None
    assert "git diff --binary HEAD --" in git_diff_definition.command
    assert "git ls-files --others --exclude-standard" in git_diff_definition.command
    assert git_diff_definition.post_processor is None
    assert git_branch_diff_shortstat_definition is not None
    assert "git merge-base" in git_branch_diff_shortstat_definition.command
    assert "git diff --shortstat" in git_branch_diff_shortstat_definition.command
    assert (
        "git diff --shortstat HEAD --" in git_branch_diff_shortstat_definition.command
    )
    assert git_branch_diff_shortstat_definition.post_processor is None
    assert git_remote_url_definition is not None
    assert git_remote_url_definition.command == "git remote get-url origin"
    assert git_remote_url_definition.post_processor is None
    assert git_add_all_definition is not None
    assert git_add_all_definition.command == "git add --all"
    assert git_add_all_definition.post_processor is None
    assert git_commit_definition is not None
    assert git_commit_definition.command == "git commit"
    assert git_commit_definition.post_processor is None
    assert ls_skills_definition is not None
    assert "python3 -c" in ls_skills_definition.command
    assert ".claude" in ls_skills_definition.command
    assert ".codex" in ls_skills_definition.command
    assert ".agents" in ls_skills_definition.command
    assert "plugins" in ls_skills_definition.command
    assert ls_skills_definition.post_processor == "json"
    assert setup_shared_skills_definition is not None
    assert "python3 -c" in setup_shared_skills_definition.command
    assert ".agents" in setup_shared_skills_definition.command
    assert ".codex" in setup_shared_skills_definition.command
    assert ".claude" in setup_shared_skills_definition.command
    assert setup_shared_skills_definition.post_processor == "json"
    assert open_terminal_definition is not None
    assert "open -a Terminal" in open_terminal_definition.command
    assert "x-terminal-emulator" in open_terminal_definition.command
    assert open_terminal_definition.post_processor is None
    assert sync_runtime_auth_file_definition is not None
    assert "WEGENT_RUNTIME_CONFIG_CONTENT" in sync_runtime_auth_file_definition.command
    assert sync_runtime_auth_file_definition.post_processor == "json"
    assert read_runtime_auth_file_definition is not None
    assert (
        "WEGENT_RUNTIME_CONFIG_TARGET_PATH" in read_runtime_auth_file_definition.command
    )
    assert read_runtime_auth_file_definition.post_processor == "json"


def test_local_device_command_registry_default_includes_workspace_file_commands():
    """Workspace file commands should be narrow JSON-producing commands."""
    from app.services.device.command_registry import resolve_local_device_command

    tree_definition = resolve_local_device_command("workspace_tree", {})
    read_definition = resolve_local_device_command("workspace_read_text_file", {})

    assert tree_definition is not None
    assert tree_definition.post_processor == "json"
    assert "json.dumps" in tree_definition.command

    assert read_definition is not None
    assert read_definition.post_processor == "json"
    assert "MAX_BYTES = 262144" in read_definition.command


def test_workspace_tree_script_lists_files_and_directories(
    tmp_path, monkeypatch, capsys
):
    """workspace_tree should emit stable JSON metadata for direct children."""
    import json

    from app.services.device.command_registry import WORKSPACE_TREE_SCRIPT

    (tmp_path / "backend").mkdir()
    (tmp_path / "README.md").write_text("hello", encoding="utf-8")
    monkeypatch.setenv("WEGENT_WORKSPACE_ROOTS", str(tmp_path))
    monkeypatch.chdir(tmp_path)

    exec(WORKSPACE_TREE_SCRIPT, {"__name__": "__main__"})
    output = json.loads(capsys.readouterr().out)

    assert output["path"] == str(tmp_path.resolve())
    assert output["entries"][0]["name"] == "backend"
    assert output["entries"][0]["is_directory"] is True
    assert output["entries"][1]["name"] == "README.md"
    assert output["entries"][1]["is_directory"] is False
    assert output["entries"][1]["size"] == 5


def test_workspace_tree_script_allows_configured_executor_projects_dir(
    tmp_path, monkeypatch, capsys
):
    """workspace_tree should allow the same custom projects root as project_workspace_root."""
    import json

    from app.services.device.command_registry import WORKSPACE_TREE_SCRIPT

    projects_root = tmp_path / "custom-projects"
    project_dir = projects_root / "Wegent"
    project_dir.mkdir(parents=True)
    (project_dir / "README.md").write_text("hello", encoding="utf-8")
    monkeypatch.delenv("WEGENT_WORKSPACE_ROOTS", raising=False)
    monkeypatch.setenv("WEGENT_EXECUTOR_PROJECTS_DIR", str(projects_root))
    monkeypatch.chdir(project_dir)

    exec(WORKSPACE_TREE_SCRIPT, {"__name__": "__main__"})
    output = json.loads(capsys.readouterr().out)

    assert output["path"] == str(project_dir.resolve())
    assert [entry["name"] for entry in output["entries"]] == ["README.md"]


def test_workspace_tree_script_does_not_classify_symlinked_directory_as_directory(
    tmp_path, monkeypatch, capsys
):
    """workspace_tree should not expose symlinked directories as traversable."""
    import json

    from app.services.device.command_registry import WORKSPACE_TREE_SCRIPT

    external_dir = tmp_path.parent / "external"
    external_dir.mkdir()
    (tmp_path / "linked-dir").symlink_to(external_dir, target_is_directory=True)
    monkeypatch.setenv("WEGENT_WORKSPACE_ROOTS", str(tmp_path))
    monkeypatch.chdir(tmp_path)

    exec(WORKSPACE_TREE_SCRIPT, {"__name__": "__main__"})
    output = json.loads(capsys.readouterr().out)

    linked_entry = next(
        entry for entry in output["entries"] if entry["name"] == "linked-dir"
    )
    assert linked_entry["is_directory"] is False


def test_workspace_tree_script_rejects_non_workspace_cwd(tmp_path, monkeypatch, capsys):
    """workspace_tree should reject arbitrary directories outside workspace roots."""
    import json

    from app.services.device.command_registry import WORKSPACE_TREE_SCRIPT

    monkeypatch.delenv("WEGENT_WORKSPACE_ROOTS", raising=False)
    monkeypatch.chdir(tmp_path)

    try:
        exec(WORKSPACE_TREE_SCRIPT, {"__name__": "__main__"})
    except SystemExit as exc:
        assert exc.code == 64
    else:
        raise AssertionError("workspace_tree should reject non-workspace cwd")

    output = json.loads(capsys.readouterr().out)
    assert output == {
        "success": False,
        "error": "workspace path is outside allowed workspace roots",
    }


def test_workspace_tree_script_rejects_external_git_repository(
    tmp_path, monkeypatch, capsys
):
    """workspace_tree should not treat arbitrary Git repositories as workspaces."""
    import json

    from app.services.device.command_registry import WORKSPACE_TREE_SCRIPT

    repository_dir = tmp_path / "external-repo"
    repository_dir.mkdir()
    (repository_dir / ".git").mkdir()
    (repository_dir / "README.md").write_text("hello", encoding="utf-8")
    monkeypatch.delenv("WEGENT_WORKSPACE_ROOTS", raising=False)
    monkeypatch.delenv("WEGENT_EXECUTOR_PROJECTS_DIR", raising=False)
    monkeypatch.setenv("WECODE_HOME", str(tmp_path / "wecode-home"))
    monkeypatch.chdir(repository_dir)

    try:
        exec(WORKSPACE_TREE_SCRIPT, {"__name__": "__main__"})
    except SystemExit as exc:
        assert exc.code == 64
    else:
        raise AssertionError("workspace_tree should reject external git repositories")

    output = json.loads(capsys.readouterr().out)
    assert output == {
        "success": False,
        "error": "workspace path is outside allowed workspace roots",
    }


def test_workspace_tree_script_keeps_lstat_operations_guarded(
    tmp_path, monkeypatch, capsys
):
    """workspace_tree should skip lstat failures without unguarded stat calls."""
    import json
    from pathlib import Path

    from app.services.device.command_registry import WORKSPACE_TREE_SCRIPT

    (tmp_path / "backend").mkdir()
    (tmp_path / "README.md").write_text("hello", encoding="utf-8")
    (tmp_path / "blocked.txt").write_text("skip", encoding="utf-8")
    monkeypatch.setenv("WEGENT_WORKSPACE_ROOTS", str(tmp_path))
    monkeypatch.chdir(tmp_path)

    workspace_root = tmp_path.resolve()
    original_is_dir = Path.is_dir
    original_lstat = Path.lstat
    tracked_names = {"backend", "README.md"}
    lstat_calls = {name: 0 for name in tracked_names}

    def fail_for_workspace_children(self):
        if self.parent == workspace_root and self.name in {
            *tracked_names,
            "blocked.txt",
        }:
            raise AssertionError("workspace_tree should not call Path.is_dir")
        return original_is_dir(self)

    def guarded_lstat(self):
        if self.parent != workspace_root:
            return original_lstat(self)
        if self.name == "blocked.txt":
            raise OSError("lstat is unavailable")
        if self.name in lstat_calls:
            lstat_calls[self.name] += 1
            if lstat_calls[self.name] > 1:
                raise OSError("workspace_tree should not lstat children twice")
        return original_lstat(self)

    monkeypatch.setattr(Path, "is_dir", fail_for_workspace_children)
    monkeypatch.setattr(Path, "lstat", guarded_lstat)

    exec(WORKSPACE_TREE_SCRIPT, {"__name__": "__main__"})
    output = json.loads(capsys.readouterr().out)

    assert [entry["name"] for entry in output["entries"]] == ["backend", "README.md"]
    assert output["entries"][0]["is_directory"] is True
    assert output["entries"][1]["is_directory"] is False
    assert lstat_calls == {"backend": 1, "README.md": 1}


def test_workspace_read_text_file_script_reads_text_and_reports_truncation(
    tmp_path, monkeypatch, capsys
):
    """workspace_read_text_file should read only the first 256 KiB."""
    import json
    import sys

    from app.services.device.command_registry import WORKSPACE_READ_TEXT_FILE_SCRIPT

    content = "a" * (262144 + 8)
    (tmp_path / "large.py").write_text(content, encoding="utf-8")
    monkeypatch.setenv("WEGENT_WORKSPACE_ROOTS", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["workspace_read_text_file", "large.py"])

    exec(WORKSPACE_READ_TEXT_FILE_SCRIPT, {"__name__": "__main__"})
    output = json.loads(capsys.readouterr().out)

    assert output["path"] == str((tmp_path / "large.py").resolve())
    assert output["content"] == "a" * 262144
    assert output["truncated"] is True
    assert output["size"] == 262152


def test_workspace_read_text_file_script_reads_at_most_limit_plus_one(
    tmp_path, monkeypatch, capsys
):
    """workspace_read_text_file should cap file I/O before decoding content."""
    import json
    import sys
    from pathlib import Path

    from app.services.device.command_registry import WORKSPACE_READ_TEXT_FILE_SCRIPT

    file_path = tmp_path / "large.py"
    file_path.write_text("a" * (262144 + 8), encoding="utf-8")
    resolved_file_path = file_path.resolve()
    monkeypatch.setenv("WEGENT_WORKSPACE_ROOTS", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["workspace_read_text_file", "large.py"])

    original_open = Path.open
    original_read_bytes = Path.read_bytes
    read_sizes = []

    class RecordingFile:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            self.handle.__enter__()
            return self

        def __exit__(self, exc_type, exc, traceback):
            return self.handle.__exit__(exc_type, exc, traceback)

        def read(self, size=-1):
            read_sizes.append(size)
            return self.handle.read(size)

    def fail_read_bytes(self):
        if self == resolved_file_path:
            raise AssertionError("workspace_read_text_file should not read all bytes")
        return original_read_bytes(self)

    def recording_open(self, *args, **kwargs):
        handle = original_open(self, *args, **kwargs)
        if self == resolved_file_path and args and args[0] == "rb":
            return RecordingFile(handle)
        return handle

    monkeypatch.setattr(Path, "read_bytes", fail_read_bytes)
    monkeypatch.setattr(Path, "open", recording_open)

    exec(WORKSPACE_READ_TEXT_FILE_SCRIPT, {"__name__": "__main__"})
    output = json.loads(capsys.readouterr().out)

    assert read_sizes == [262145]
    assert output["content"] == "a" * 262144
    assert output["truncated"] is True


def test_workspace_read_text_file_script_rejects_non_workspace_cwd(
    tmp_path, monkeypatch, capsys
):
    """workspace_read_text_file should reject arbitrary directories."""
    import json
    import sys

    from app.services.device.command_registry import WORKSPACE_READ_TEXT_FILE_SCRIPT

    (tmp_path / "README.md").write_text("hello", encoding="utf-8")
    monkeypatch.delenv("WEGENT_WORKSPACE_ROOTS", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["workspace_read_text_file", "README.md"])

    try:
        exec(WORKSPACE_READ_TEXT_FILE_SCRIPT, {"__name__": "__main__"})
    except SystemExit as exc:
        assert exc.code == 64
    else:
        raise AssertionError("workspace_read_text_file should reject non-workspace cwd")

    output = json.loads(capsys.readouterr().out)
    assert output == {
        "success": False,
        "error": "workspace path is outside allowed workspace roots",
    }


def test_local_device_command_registry_supports_inline_post_processor():
    """One command config object should contain command and post processor."""
    from app.services.device.command_registry import resolve_local_device_command

    definition = resolve_local_device_command(
        "repo_files",
        {
            "repo_files": {
                "command": "ls -a",
                "post_processor": "file_list",
            }
        },
    )

    assert definition is not None
    assert definition.command == "ls -a"
    assert definition.post_processor == "file_list"


def test_local_device_command_registry_keeps_default_processor_for_string_override():
    """A simple string override should not drop a built-in post processor."""
    from app.services.device.command_registry import resolve_local_device_command

    definition = resolve_local_device_command("ls_a", {"ls_a": "ls -a"})

    assert definition is not None
    assert definition.command == "ls -a"
    assert definition.post_processor == "file_list"


def test_local_device_command_registry_builds_argv_with_request_args():
    """Command argv should append request args without shell string concatenation."""
    from app.services.device.command_registry import build_local_device_command_argv

    argv = build_local_device_command_argv("ls -a", ["backend", "docs"])

    assert argv == ["ls", "-a", "backend", "docs"]


def test_local_device_command_registry_builds_git_clone_argv():
    """git_clone should support repository URL and target directory args."""
    from app.services.device.command_registry import (
        build_local_device_command_argv,
        resolve_local_device_command,
    )

    definition = resolve_local_device_command("git_clone")

    assert definition is not None
    assert build_local_device_command_argv(
        definition.command,
        ["https://github.com/wecode-ai/Wegent.git", "Wegent"],
    ) == ["git", "clone", "https://github.com/wecode-ai/Wegent.git", "Wegent"]


def test_local_device_command_registry_builds_git_worktree_add_argv():
    """git_worktree_add should bind args to the fixed worktree subcommand."""
    from app.services.device.command_registry import (
        build_local_device_command_argv,
        resolve_local_device_command,
    )

    definition = resolve_local_device_command("git_worktree_add")

    assert definition is not None
    assert build_local_device_command_argv(
        definition.command,
        ["/workspace/projects/d837/Wegent", "/workspace/worktrees/1386/Wegent"],
    ) == [
        "sh",
        "-c",
        'if [ -n "$3" ]; then git -C "$1" worktree add --detach "$2" "$3"; else git -C "$1" worktree add --detach "$2"; fi',
        "--",
        "/workspace/projects/d837/Wegent",
        "/workspace/worktrees/1386/Wegent",
    ]


def test_local_device_command_registry_builds_git_worktree_add_argv_with_branch():
    """git_worktree_add should accept an optional source branch ref."""
    from app.services.device.command_registry import (
        build_local_device_command_argv,
        resolve_local_device_command,
    )

    definition = resolve_local_device_command("git_worktree_add")

    assert definition is not None
    assert build_local_device_command_argv(
        definition.command,
        [
            "/workspace/projects/d837/Wegent",
            "/workspace/worktrees/1386/Wegent",
            "develop",
        ],
    ) == [
        "sh",
        "-c",
        'if [ -n "$3" ]; then git -C "$1" worktree add --detach "$2" "$3"; else git -C "$1" worktree add --detach "$2"; fi',
        "--",
        "/workspace/projects/d837/Wegent",
        "/workspace/worktrees/1386/Wegent",
        "develop",
    ]


def test_local_device_command_registry_builds_git_worktree_remove_argv():
    """git_worktree_remove should bind args to the fixed remove subcommand."""
    from app.services.device.command_registry import (
        build_local_device_command_argv,
        resolve_local_device_command,
    )

    definition = resolve_local_device_command("git_worktree_remove")

    assert definition is not None
    assert build_local_device_command_argv(
        definition.command,
        ["/workspace/projects/d837/Wegent", "/workspace/worktrees/1386/Wegent"],
    ) == [
        "sh",
        "-c",
        'git -C "$1" worktree remove --force "$2"',
        "--",
        "/workspace/projects/d837/Wegent",
        "/workspace/worktrees/1386/Wegent",
    ]


def test_file_list_post_processor_filters_special_entries():
    """file_list post processor should return a clean file name list."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": ".\n..\n.env\nbackend\n\n",
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "file_list")

    assert processed["stdout"] == [".env", "backend"]


def test_directory_list_post_processor_keeps_only_directories():
    """directory_list post processor should return clean directory names."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": "./\n../\n.env\nbackend/\nfrontend/\nREADME.md\n",
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "directory_list")

    assert processed["stdout"] == ["backend", "frontend"]


def test_json_post_processor_parses_structured_output():
    """json post processor should return parsed command output."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": '[{"name": "env-context", "source": "codex"}]',
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "json")

    assert processed["stdout"] == [{"name": "env-context", "source": "codex"}]


def test_json_post_processor_reports_parse_failure():
    """json post processor should mark malformed JSON results as failed."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": "not-json",
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "json")

    assert processed["success"] is False
    assert "Failed to parse command JSON output" in processed["error"]


def test_json_post_processor_promotes_failed_json_error():
    """json post processor should expose JSON error payloads from failed commands."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": False,
        "exit_code": 64,
        "stdout": '{"success": false, "error": "workspace path is outside allowed workspace roots"}',
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "json")

    assert processed["success"] is False
    assert processed["stdout"] == {
        "success": False,
        "error": "workspace path is outside allowed workspace roots",
    }
    assert processed["error"] == "workspace path is outside allowed workspace roots"


def test_json_post_processor_reports_truncated_output():
    """json post processor should fail early when stdout was truncated."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": '[{"name": "skill-a", "description": "very long',
        "stderr": "",
        "duration": 0.5,
        "stdout_truncated": True,
    }

    processed = apply_command_post_processor(result, "json")

    assert processed["success"] is False
    assert "truncated" in processed["error"]


def test_ls_skills_command_parses_yaml_block_description(tmp_path):
    """ls_skills should parse YAML block scalars without keeping the marker."""
    from app.services.device.command_registry import LS_SKILLS_SCRIPT

    skill_dir = tmp_path / ".codex" / "skills" / "chronicle"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        """---
name: chronicle
description: |
  Allows you to view the user's screen as well as several hours of history.

  Use when the user refers to recent work.
metadata:
  short-description: |
    Screen history context.
---

# Chronicle
""",
        encoding="utf-8",
    )

    env = {**os.environ, "HOME": str(tmp_path)}
    result = subprocess.run(
        ["python3", "-c", LS_SKILLS_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    skills = json.loads(result.stdout)

    assert skills == [
        {
            "name": "chronicle",
            "description": (
                "Allows you to view the user's screen as well as several hours "
                "of history. Use when the user refers to recent work."
            ),
            "short_description": "Screen history context.",
            "path": str(skill_dir / "SKILL.md"),
            "source": "codex",
            "origin": "local",
            "mtime": skills[0]["mtime"],
        }
    ]
    assert "|" not in skills[0]["description"]


def test_ls_skills_command_prefers_shared_agents_source(tmp_path):
    """ls_skills should expose unified shared skills as agents skills."""
    from app.services.device.command_registry import LS_SKILLS_SCRIPT

    skill_dir = tmp_path / ".agents" / "skills" / "shared-context"
    skill_dir.mkdir(parents=True)
    (tmp_path / ".codex").mkdir()
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".codex" / "skills").symlink_to(
        tmp_path / ".agents" / "skills",
        target_is_directory=True,
    )
    (tmp_path / ".claude" / "skills").symlink_to(
        tmp_path / ".agents" / "skills",
        target_is_directory=True,
    )
    (skill_dir / "SKILL.md").write_text(
        """---
name: shared-context
description: Shared local context.
---

# Shared Context
""",
        encoding="utf-8",
    )

    env = {**os.environ, "HOME": str(tmp_path)}
    result = subprocess.run(
        ["python3", "-c", LS_SKILLS_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    skills = json.loads(result.stdout)

    assert len(skills) == 1
    assert skills[0]["name"] == "shared-context"
    assert skills[0]["source"] == "agents"
    assert skills[0]["path"] == str(skill_dir / "SKILL.md")


def test_setup_shared_skills_command_migrates_legacy_skill_dirs(tmp_path):
    """setup_shared_skills should move existing skills and link legacy dirs."""
    from app.services.device.command_registry import SETUP_SHARED_SKILLS_SCRIPT

    codex_skill_dir = tmp_path / ".codex" / "skills" / "shared"
    claude_skill_dir = tmp_path / ".claude" / "skills" / "shared"
    codex_skill_dir.mkdir(parents=True)
    claude_skill_dir.mkdir(parents=True)
    (codex_skill_dir / "SKILL.md").write_text("# Codex\n", encoding="utf-8")
    (claude_skill_dir / "SKILL.md").write_text("# Claude\n", encoding="utf-8")

    env = {**os.environ, "HOME": str(tmp_path)}
    result = subprocess.run(
        ["python3", "-c", SETUP_SHARED_SKILLS_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    shared_dir = tmp_path / ".agents" / "skills"

    assert payload["success"] is True
    assert payload["status"] == "configured"
    assert payload["shared_path"] == str(shared_dir)
    assert payload["moved_count"] == 2
    assert (shared_dir / "shared" / "SKILL.md").read_text(
        encoding="utf-8"
    ) == "# Codex\n"
    assert (shared_dir / "shared-claude" / "SKILL.md").read_text(
        encoding="utf-8"
    ) == "# Claude\n"
    assert (tmp_path / ".codex" / "skills").is_symlink()
    assert (tmp_path / ".claude" / "skills").is_symlink()
    assert (tmp_path / ".codex" / "skills").resolve() == shared_dir
    assert (tmp_path / ".claude" / "skills").resolve() == shared_dir


def test_setup_shared_skills_command_is_idempotent(tmp_path):
    """setup_shared_skills should be safe to run after links already exist."""
    from app.services.device.command_registry import SETUP_SHARED_SKILLS_SCRIPT

    shared_dir = tmp_path / ".agents" / "skills"
    shared_dir.mkdir(parents=True)
    (tmp_path / ".codex").mkdir()
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".codex" / "skills").symlink_to(
        shared_dir,
        target_is_directory=True,
    )
    (tmp_path / ".claude" / "skills").symlink_to(
        shared_dir,
        target_is_directory=True,
    )

    env = {**os.environ, "HOME": str(tmp_path)}
    result = subprocess.run(
        ["python3", "-c", SETUP_SHARED_SKILLS_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)

    assert payload["success"] is True
    assert payload["moved_count"] == 0
    assert {link["status"] for link in payload["links"]} == {"already_configured"}


def test_sync_runtime_auth_file_command_writes_json_object(tmp_path):
    """sync_runtime_auth_file should create auth JSON with private permissions."""
    from app.services.device.command_registry import SYNC_RUNTIME_AUTH_FILE_SCRIPT

    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "WEGENT_RUNTIME_CONFIG_RUNTIME": "codex",
        "WEGENT_RUNTIME_CONFIG_TARGET_PATH": "~/.codex/auth.json",
        "WEGENT_RUNTIME_CONFIG_CONTENT": '{"token":"secret","account":{"id":"u1"}}',
    }
    result = subprocess.run(
        ["python3", "-c", SYNC_RUNTIME_AUTH_FILE_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    target = tmp_path / ".codex" / "auth.json"

    assert payload == {
        "status": "written",
        "runtime": "codex",
        "path": "~/.codex/auth.json",
    }
    assert json.loads(target.read_text(encoding="utf-8")) == {
        "account": {"id": "u1"},
        "token": "secret",
    }
    assert target.stat().st_mode & 0o777 == 0o600


def test_sync_runtime_auth_file_command_does_not_overwrite_existing_file(tmp_path):
    """sync_runtime_auth_file should skip when auth JSON already exists."""
    from app.services.device.command_registry import SYNC_RUNTIME_AUTH_FILE_SCRIPT

    target = tmp_path / ".codex" / "auth.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"token":"existing"}\n', encoding="utf-8")
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "WEGENT_RUNTIME_CONFIG_RUNTIME": "codex",
        "WEGENT_RUNTIME_CONFIG_TARGET_PATH": "~/.codex/auth.json",
        "WEGENT_RUNTIME_CONFIG_CONTENT": '{"token":"new"}',
    }
    result = subprocess.run(
        ["python3", "-c", SYNC_RUNTIME_AUTH_FILE_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == {
        "status": "skipped_existing",
        "runtime": "codex",
        "path": "~/.codex/auth.json",
    }
    assert target.read_text(encoding="utf-8") == '{"token":"existing"}\n'


def test_read_runtime_auth_file_command_returns_existing_json(tmp_path):
    """read_runtime_auth_file should return the auth JSON content."""
    from app.services.device.command_registry import READ_RUNTIME_AUTH_FILE_SCRIPT

    target = tmp_path / ".codex" / "auth.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"token":"existing"}\n', encoding="utf-8")
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "WEGENT_RUNTIME_CONFIG_RUNTIME": "codex",
        "WEGENT_RUNTIME_CONFIG_TARGET_PATH": "~/.codex/auth.json",
    }
    result = subprocess.run(
        ["python3", "-c", READ_RUNTIME_AUTH_FILE_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == {
        "status": "read",
        "runtime": "codex",
        "path": "~/.codex/auth.json",
        "content": '{"token":"existing"}\n',
    }


def test_ls_skills_command_includes_plugin_skills(tmp_path):
    """ls_skills should include skills bundled by installed Claude and Codex plugins."""
    from app.services.device.command_registry import LS_SKILLS_SCRIPT

    claude_skill_dir = (
        tmp_path
        / ".claude"
        / "plugins"
        / "cache"
        / "claude-plugins-official"
        / "superpowers"
        / "5.0.7"
        / "skills"
        / "test-driven-development"
    )
    codex_skill_dir = (
        tmp_path
        / ".codex"
        / "plugins"
        / "cache"
        / "openai-curated"
        / "github"
        / "83d1f0d2"
        / "skills"
        / "github"
    )
    claude_skill_dir.mkdir(parents=True)
    codex_skill_dir.mkdir(parents=True)
    manifest_path = tmp_path / ".wegent-executor" / "capabilities.json"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(
        json.dumps(
            {
                "version": 1,
                "revision": 1,
                "skills": {},
                "plugins": {
                    "superpowers@claude-plugins-official": {
                        "installed_plugin_id": 9,
                        "managed": True,
                    }
                },
                "mcps": {},
            }
        ),
        encoding="utf-8",
    )
    (claude_skill_dir / "SKILL.md").write_text(
        """---
name: test-driven-development
description: Use when implementing features.
---

# TDD
""",
        encoding="utf-8",
    )
    (codex_skill_dir / "SKILL.md").write_text(
        """---
name: github
description: Inspect repositories and pull requests.
metadata:
  short-description: GitHub workflow support.
---

# GitHub
""",
        encoding="utf-8",
    )

    env = {**os.environ, "HOME": str(tmp_path)}
    result = subprocess.run(
        ["python3", "-c", LS_SKILLS_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    skills = json.loads(result.stdout)

    assert {
        (
            skill["name"],
            skill["source"],
            skill["origin"],
            skill["plugin_name"],
            skill["path"],
        )
        for skill in skills
    } == {
        (
            "test-driven-development",
            "claude-plugin",
            "wegent",
            "superpowers",
            str(claude_skill_dir / "SKILL.md"),
        ),
        (
            "github",
            "codex-plugin",
            "local",
            "github",
            str(codex_skill_dir / "SKILL.md"),
        ),
    }
    assert (
        next(skill for skill in skills if skill["name"] == "github")[
            "short_description"
        ]
        == "GitHub workflow support."
    )


@pytest.mark.asyncio
async def test_execute_command_calls_registered_device_socket(monkeypatch):
    """Service should send command RPC to the target device socket."""
    from app.services.device import command_service

    mock_sio = AsyncMock()
    mock_sio.call.return_value = {
        "success": True,
        "exit_code": 0,
        "stdout": "ok\n",
        "stderr": "",
        "duration": 0.01,
        "timed_out": False,
    }

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-123"}),
    )
    monkeypatch.setattr(command_service, "get_sio", lambda: mock_sio)

    result = await command_service.local_device_command_service.execute_command(
        user_id=7,
        device_id="device-abc",
        command="pwd",
        path="/tmp",
        args=["-P"],
        env={"A": "B"},
        timeout_seconds=5,
        max_output_bytes=1024,
    )

    assert result["success"] is True
    assert result["stdout"] == "ok\n"
    mock_sio.call.assert_awaited_once_with(
        "device:execute_command",
        {
            "command": "pwd",
            "cwd": "/tmp",
            "args": ["-P"],
            "argv": ["pwd", "-P"],
            "env": {"A": "B"},
            "timeout_seconds": 5,
            "max_output_bytes": 1024,
        },
        to="socket-123",
        namespace="/local-executor",
        timeout=10,
    )


@pytest.mark.asyncio
async def test_execute_command_reports_socket_timeout_with_actionable_detail(
    monkeypatch,
):
    """Socket.IO timeout errors should not produce an empty API detail."""
    from socketio.exceptions import TimeoutError as SocketTimeoutError

    from app.services.device import command_service

    mock_sio = AsyncMock()
    mock_sio.call.side_effect = SocketTimeoutError()

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-123"}),
    )
    monkeypatch.setattr(command_service, "get_sio", lambda: mock_sio)

    with pytest.raises(command_service.DeviceCommandError) as exc_info:
        await command_service.local_device_command_service.execute_command(
            user_id=7,
            device_id="device-abc",
            command="printenv HOME",
            timeout_seconds=10,
            max_output_bytes=4096,
        )

    message = str(exc_info.value)
    assert "timed out after 15 seconds" in message
    assert "device-abc" in message
    assert "device:execute_command" in message
    assert "Reconnect or upgrade" in message
    assert message != "Command RPC failed: "


@pytest.mark.asyncio
async def test_execute_command_rejects_offline_device(monkeypatch):
    """Service should reject devices without online socket information."""
    from app.services.device import command_service

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info",
        AsyncMock(return_value=None),
    )

    with pytest.raises(command_service.DeviceCommandError) as exc_info:
        await command_service.local_device_command_service.execute_command(
            user_id=7,
            device_id="offline-device",
            command="pwd",
        )

    assert "offline" in str(exc_info.value)


@pytest.mark.asyncio
async def test_execute_configured_device_command_resolves_executes_and_post_processes(
    monkeypatch,
):
    """Internal service API should resolve key, execute command, and post-process."""
    from app.services.device import command_service

    execute_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": ".\n..\nbackend\n",
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        command_service.local_device_command_service,
        "execute_command",
        execute_mock,
    )

    result = await command_service.execute_configured_device_command(
        db=object(),
        user_id=7,
        device_id="device-abc",
        command_key="repo_files",
        path="/tmp",
        args=["backend"],
        env={"A": "B"},
        timeout_seconds=5,
        max_output_bytes=1024,
        command_config={
            "repo_files": {
                "command": "ls -a",
                "post_processor": "file_list",
            }
        },
    )

    assert result["stdout"] == ["backend"]
    execute_mock.assert_awaited_once_with(
        user_id=7,
        device_id="device-abc",
        command="ls -a",
        path="/tmp",
        args=["backend"],
        env={"A": "B"},
        timeout_seconds=5,
        max_output_bytes=1024,
    )


@pytest.mark.asyncio
async def test_execute_configured_device_command_rejects_unowned_device(monkeypatch):
    """Internal service API should reject devices the user does not own."""
    from app.services.device import command_service

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: None,
    )

    with pytest.raises(command_service.DeviceCommandNotFoundError):
        await command_service.execute_configured_device_command(
            db=object(),
            user_id=7,
            device_id="device-abc",
            command_key="pwd",
        )


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_maps_request_to_service(monkeypatch):
    """Endpoint should delegate HTTP request data to the internal service API."""
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": "ok",
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)
    db = object()

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(
            command_key="repo_status",
            path="/tmp",
            args=["--short"],
            env={"A": "B"},
            timeout_seconds=5,
            max_output_bytes=1024,
        ),
        db=db,
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    assert response.stdout == "ok"
    service_mock.assert_awaited_once_with(
        db=db,
        user_id=7,
        device_id="device-abc",
        command_key="repo_status",
        path="/tmp",
        args=["--short"],
        env={"A": "B"},
        timeout_seconds=5,
        max_output_bytes=1024,
    )


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_allows_wework_local_project_workspace(
    monkeypatch,
    test_db,
):
    """Workspace file commands should allow active Wework local-path project roots."""
    from app.api.endpoints import devices
    from app.core.constants import CLIENT_ORIGIN_WEWORK
    from app.models.project import Project
    from app.schemas.device import DeviceCommandRequest

    test_db.add(
        Project(
            user_id=7,
            name="Repo",
            client_origin=CLIENT_ORIGIN_WEWORK,
            is_active=True,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "local",
                    "deviceId": "device-abc",
                },
                "workspace": {
                    "source": "local_path",
                    "localPath": "/Users/test/projects/repo",
                },
            },
        )
    )
    test_db.commit()
    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": {"path": "/Users/test/projects/repo/src", "entries": []},
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(
            command_key="workspace_tree",
            path="/Users/test/projects/repo/src",
            env={"EXISTING": "1"},
        ),
        db=test_db,
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    service_mock.assert_awaited_once()
    _, kwargs = service_mock.await_args
    assert kwargs["env"]["EXISTING"] == "1"
    assert kwargs["env"]["WEGENT_WORKSPACE_ROOTS"] == "/Users/test/projects/repo"


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_does_not_trust_client_workspace_roots(
    monkeypatch,
    test_db,
):
    """Workspace file commands should not accept client-provided workspace roots."""
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    service_mock = AsyncMock(
        return_value={
            "success": False,
            "exit_code": 64,
            "stdout": {
                "success": False,
                "error": "workspace path is outside allowed workspace roots",
            },
            "stderr": "",
            "error": "workspace path is outside allowed workspace roots",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(
            command_key="workspace_tree",
            path="/etc",
            env={"WEGENT_WORKSPACE_ROOTS": "/", "EXISTING": "1"},
        ),
        db=test_db,
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is False
    service_mock.assert_awaited_once()
    _, kwargs = service_mock.await_args
    assert kwargs["env"] == {"EXISTING": "1"}


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_allows_explicit_root_project_workspace(
    monkeypatch,
    test_db,
):
    """Workspace file commands should allow root when the project explicitly uses it."""
    from app.api.endpoints import devices
    from app.core.constants import CLIENT_ORIGIN_WEWORK
    from app.models.project import Project
    from app.schemas.device import DeviceCommandRequest

    test_db.add(
        Project(
            user_id=7,
            name="Root",
            client_origin=CLIENT_ORIGIN_WEWORK,
            is_active=True,
            config={
                "mode": "workspace",
                "execution": {
                    "targetType": "local",
                    "deviceId": "device-abc",
                },
                "workspace": {
                    "source": "local_path",
                    "localPath": "/",
                },
            },
        )
    )
    test_db.commit()
    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": {"path": "/etc", "entries": []},
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(
            command_key="workspace_tree",
            path="/etc",
            env={"EXISTING": "1"},
        ),
        db=test_db,
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    service_mock.assert_awaited_once()
    _, kwargs = service_mock.await_args
    assert kwargs["env"] == {"EXISTING": "1", "WEGENT_WORKSPACE_ROOTS": "/"}


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_applies_configured_post_processor(
    monkeypatch,
):
    """Endpoint should return post-processed internal service results."""
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": [".env", "backend"],
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(command_key="repo_files"),
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    assert response.stdout == [".env", "backend"]


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_returns_structured_stdout(monkeypatch):
    """Endpoint should allow command processors to return object lists."""
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    skills = [
        {
            "name": "env-context",
            "description": "Environment facts.",
            "short_description": "Environment facts.",
            "path": "/Users/crystal/.codex/skills/env-context/SKILL.md",
            "source": "codex",
            "mtime": 1780462034.0,
        }
    ]
    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": skills,
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(command_key="ls_skills"),
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    assert response.stdout == skills


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_returns_dict_stdout(monkeypatch):
    """Endpoint should allow JSON processors to return object stdout."""
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    workspace_tree = {"path": "/workspace/project", "entries": []}
    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": workspace_tree,
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(command_key="workspace_tree"),
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    assert response.stdout == workspace_tree


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_rejects_unknown_command_key(monkeypatch):
    """Endpoint should reject command keys missing from backend configuration."""
    from fastapi import HTTPException

    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    async def raise_unknown_key(**kwargs):
        raise devices.DeviceCommandUnknownKeyError(
            "Device command key 'repo_status' is not configured"
        )

    monkeypatch.setattr(devices, "execute_configured_device_command", raise_unknown_key)

    with pytest.raises(HTTPException) as exc_info:
        await devices.execute_device_command(
            device_id="device-abc",
            request=DeviceCommandRequest(command_key="repo_status"),
            db=object(),
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 400
    assert "not configured" in exc_info.value.detail
