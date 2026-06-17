# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import gzip
import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from executor.services.turn_file_changes import (
    TurnFileChangeTracker,
    WorkspaceBusyError,
)


def run_git(repo: Path, *args: str, input_bytes: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        input=input_bytes,
    ).stdout


def init_repo(path: Path, *, with_head: bool = True) -> Path:
    repo = path / "repo"
    repo.mkdir()
    run_git(repo, "init", "-q")
    run_git(repo, "config", "user.email", "tests@example.com")
    run_git(repo, "config", "user.name", "Tests")
    if with_head:
        write(repo / ".gitkeep", "")
        commit_all(repo, "initial")
    return repo


def write(path: Path, content: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")


def commit_all(repo: Path, message: str) -> None:
    run_git(repo, "add", "--all")
    run_git(repo, "commit", "-qm", message)


def file_changes(summary: dict) -> dict:
    return summary["file_changes"]


@pytest.mark.asyncio
async def test_tracker_excludes_changes_that_preexist_the_turn(tmp_path):
    repo = init_repo(tmp_path)
    write(repo / "existing.txt", "base\n")
    commit_all(repo, "tracked")
    write(repo / "existing.txt", "user dirty\n")
    write(repo / "untracked.txt", "before\n")

    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=10,
        subtask_id=20,
        executor_home=tmp_path / "executor-home",
    )
    assert await tracker.start() is True

    write(repo / "agent.txt", "created by agent\n")
    summary = await tracker.finalize()

    assert [item["path"] for item in file_changes(summary)["files"]] == ["agent.txt"]


@pytest.mark.asyncio
async def test_tracker_counts_modified_created_deleted_and_renamed_files(tmp_path):
    repo = init_repo(tmp_path)
    write(repo / "modified.txt", "old\n")
    write(repo / "deleted.txt", "gone\n")
    write(repo / "old-name.txt", "rename me\n")
    commit_all(repo, "fixtures")
    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
        device_id="device-1",
    )
    await tracker.start()

    write(repo / "modified.txt", "new\nextra\n")
    write(repo / "created.txt", "created\n")
    (repo / "deleted.txt").unlink()
    (repo / "old-name.txt").rename(repo / "new-name.txt")
    changes = file_changes(await tracker.finalize())

    by_path = {item["path"]: item for item in changes["files"]}
    assert changes["file_count"] == 4
    assert changes["additions"] == 3
    assert changes["deletions"] == 2
    assert by_path["created.txt"]["change_type"] == "created"
    assert by_path["deleted.txt"]["change_type"] == "deleted"
    assert by_path["modified.txt"]["change_type"] == "modified"
    assert by_path["new-name.txt"]["change_type"] == "renamed"
    assert by_path["new-name.txt"]["old_path"] == "old-name.txt"
    assert changes["device_id"] == "device-1"


@pytest.mark.asyncio
async def test_tracker_supports_repository_without_head(tmp_path):
    repo = init_repo(tmp_path, with_head=False)
    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
    )
    await tracker.start()

    write(repo / "first.txt", "first\n")
    changes = file_changes(await tracker.finalize())

    assert changes["files"][0]["path"] == "first.txt"
    assert changes["files"][0]["change_type"] == "created"


@pytest.mark.asyncio
async def test_tracker_marks_binary_files_without_line_counts(tmp_path):
    repo = init_repo(tmp_path)
    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
    )
    await tracker.start()

    write(repo / "image.bin", b"\x00\x01\x02\x03")
    changes = file_changes(await tracker.finalize())

    assert changes["files"][0] == {
        "old_path": None,
        "path": "image.bin",
        "change_type": "created",
        "additions": 0,
        "deletions": 0,
        "binary": True,
    }


@pytest.mark.asyncio
async def test_tracker_writes_gzip_patch_and_metadata_checksum(tmp_path):
    repo = init_repo(tmp_path)
    executor_home = tmp_path / "home"
    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=12,
        subtask_id=34,
        executor_home=executor_home,
    )
    await tracker.start()
    write(repo / "hello.txt", "hello\n")

    changes = file_changes(await tracker.finalize())
    artifact_dir = executor_home / "artifacts" / "turn-file-changes" / "12" / "34"
    patch = gzip.decompress((artifact_dir / "changes.patch.gz").read_bytes())
    metadata = json.loads((artifact_dir / "metadata.json").read_text())

    assert changes["artifact_id"] == "turn-file-changes/12/34"
    assert patch.startswith(b"diff --git a/hello.txt b/hello.txt")
    assert metadata["checksum"] == hashlib.sha256(patch).hexdigest()
    assert metadata["workspace_path"] == str(repo.resolve())


@pytest.mark.asyncio
async def test_tracker_returns_empty_fields_when_workspace_is_not_git(tmp_path):
    workspace = tmp_path / "plain"
    workspace.mkdir()
    tracker = TurnFileChangeTracker(
        workspace=workspace,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
    )

    assert await tracker.start() is False
    assert await tracker.finalize() == {}


@pytest.mark.asyncio
async def test_tracker_reverse_patch_restores_only_the_turn(tmp_path):
    repo = init_repo(tmp_path)
    write(repo / "existing.txt", "committed\n")
    commit_all(repo, "tracked")
    write(repo / "existing.txt", "dirty before\n")
    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
    )
    await tracker.start()

    write(repo / "agent.txt", "agent\n")
    await tracker.finalize()
    patch = gzip.decompress(
        (
            tmp_path / "home/artifacts/turn-file-changes/1/2/changes.patch.gz"
        ).read_bytes()
    )
    run_git(repo, "apply", "--reverse", "--binary", "-", input_bytes=patch)

    assert (repo / "existing.txt").read_text() == "dirty before\n"
    assert not (repo / "agent.txt").exists()


@pytest.mark.asyncio
async def test_tracker_does_not_change_real_git_index(tmp_path):
    repo = init_repo(tmp_path)
    write(repo / "staged.txt", "base\n")
    commit_all(repo, "tracked")
    write(repo / "staged.txt", "staged\n")
    run_git(repo, "add", "staged.txt")
    before_index = run_git(repo, "ls-files", "--stage")
    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
    )

    await tracker.start()
    write(repo / "agent.txt", "agent\n")
    await tracker.finalize()

    assert run_git(repo, "ls-files", "--stage") == before_index


@pytest.mark.asyncio
async def test_tracker_rejects_concurrent_turns_in_same_workspace(tmp_path):
    repo = init_repo(tmp_path)
    first = TurnFileChangeTracker(
        workspace=repo,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
    )
    second = TurnFileChangeTracker(
        workspace=repo,
        task_id=1,
        subtask_id=3,
        executor_home=tmp_path / "home",
    )
    await first.start()

    with pytest.raises(WorkspaceBusyError):
        await second.start()

    await first.abort()


@pytest.mark.asyncio
async def test_tracker_allows_concurrent_turns_in_distinct_git_worktrees(tmp_path):
    repo = init_repo(tmp_path)
    worktrees_root = tmp_path / "worktrees"
    worktrees_root.mkdir()
    first_workspace = worktrees_root / "101" / "repo"
    second_workspace = worktrees_root / "102" / "repo"
    run_git(repo, "worktree", "add", "-q", "-b", "turn-101", str(first_workspace))
    run_git(repo, "worktree", "add", "-q", "-b", "turn-102", str(second_workspace))
    first = TurnFileChangeTracker(
        workspace=first_workspace,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
    )
    second = TurnFileChangeTracker(
        workspace=second_workspace,
        task_id=1,
        subtask_id=3,
        executor_home=tmp_path / "home",
    )

    await first.start()
    try:
        assert await second.start() is True
    finally:
        await second.abort()
        await first.abort()


@pytest.mark.asyncio
async def test_tracker_removes_stale_same_host_lock(tmp_path):
    repo = init_repo(tmp_path)
    lock_path = repo / ".git" / "wegent-turn-file-changes.lock"
    lock_path.write_text(
        json.dumps(
            {
                "pid": 99999999,
                "hostname": os.uname().nodename,
                "task_id": 9,
                "subtask_id": 9,
            }
        )
    )
    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=1,
        subtask_id=2,
        executor_home=tmp_path / "home",
    )

    assert await tracker.start() is True

    await tracker.abort()
    assert not lock_path.exists()
