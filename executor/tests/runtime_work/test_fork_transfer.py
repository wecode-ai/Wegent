# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import sqlite3
import subprocess
import tarfile
import threading
import time

import pytest

from executor.runtime_work import fork_transfer


def test_direct_transfer_defaults_to_all_interfaces(monkeypatch):
    monkeypatch.setattr(
        fork_transfer.config, "RUNTIME_TRANSFER_BIND_HOST", None, raising=False
    )

    assert fork_transfer._direct_transfer_bind_host() == "0.0.0.0"


def test_direct_transfer_uses_backend_supplied_hosts():
    assert fork_transfer._candidate_hosts(
        "0.0.0.0",
        direct_hosts=["10.0.0.11", "10.0.0.11", "127.0.0.1"],
    ) == ["10.0.0.11", "127.0.0.1"]


def test_direct_transfer_does_not_guess_hosts_when_backend_supplies_empty_list():
    assert fork_transfer._candidate_hosts("0.0.0.0", direct_hosts=[]) == []


def test_direct_archive_urls_use_backend_hosts_without_token(tmp_path):
    archive_path = tmp_path / "archive.tar.gz"
    archive_path.write_bytes(b"archive")

    urls = fork_transfer.register_direct_archive(
        "transfer-1",
        archive_path,
        "secret-token",
        direct_hosts=["10.0.0.11"],
    )

    assert urls
    assert urls[0].startswith("http://10.0.0.11:")
    assert "token=" not in urls[0]
    assert fork_transfer._transfer_proof("transfer-1", "secret-token")
    fork_transfer._cleanup_transfer("transfer-1")


def _archive_members(archive_path):
    with tarfile.open(archive_path, "r:gz") as archive:
        return {
            member.name: archive.extractfile(member).read()
            for member in archive.getmembers()
            if member.isfile()
        }


def _run_git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _init_git_repo(workspace):
    _run_git(workspace, "init")
    _run_git(workspace, "config", "user.email", "test@example.com")
    _run_git(workspace, "config", "user.name", "Test User")


def _commit_id(workspace, ref="HEAD"):
    return subprocess.run(
        ["git", "rev-parse", ref],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _create_origin_checkout(tmp_path):
    origin = tmp_path / "origin.git"
    source = tmp_path / "source"
    _run_git(tmp_path, "init", "--bare", str(origin))
    _run_git(tmp_path, "clone", str(origin), str(source))
    _run_git(source, "checkout", "-b", "main")
    _run_git(source, "config", "user.email", "test@example.com")
    _run_git(source, "config", "user.name", "Test User")
    return origin, source


def _create_codex_state_db(home, *, thread_id, rollout_path, cwd):
    state_dir = home / ".codex" / "sqlite"
    state_dir.mkdir(parents=True, exist_ok=True)
    db_path = state_dir / "state_5.sqlite"
    connection = sqlite3.connect(db_path)
    try:
        connection.execute(
            """
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                source TEXT NOT NULL,
                model_provider TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT NOT NULL,
                sandbox_policy TEXT NOT NULL,
                approval_mode TEXT NOT NULL,
                tokens_used INTEGER NOT NULL DEFAULT 0,
                has_user_event INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_at INTEGER,
                git_sha TEXT,
                git_branch TEXT,
                git_origin_url TEXT,
                cli_version TEXT NOT NULL DEFAULT '',
                first_user_message TEXT NOT NULL DEFAULT '',
                memory_mode TEXT NOT NULL DEFAULT 'enabled',
                preview TEXT NOT NULL DEFAULT ''
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE thread_dynamic_tools (
                thread_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                input_schema TEXT NOT NULL,
                defer_loading INTEGER NOT NULL DEFAULT 0,
                namespace TEXT,
                PRIMARY KEY(thread_id, position)
            )
            """
        )
        connection.execute(
            """
            INSERT INTO threads (
                id, rollout_path, created_at, updated_at, source, model_provider,
                cwd, title, sandbox_policy, approval_mode, cli_version,
                first_user_message, memory_mode, preview
            ) VALUES (?, ?, 1, 2, 'sdk', 'openai', ?, 'hi', '{}', 'never',
                'test', 'hello', 'enabled', 'hi')
            """,
            (thread_id, str(rollout_path), str(cwd)),
        )
        connection.execute(
            """
            INSERT INTO thread_dynamic_tools (
                thread_id, position, name, description, input_schema
            ) VALUES (?, 0, 'tool', 'desc', '{}')
            """,
            (thread_id,),
        )
        connection.commit()
    finally:
        connection.close()
    return db_path


def _fetch_codex_thread_state(home, thread_id):
    connection = sqlite3.connect(home / ".codex" / "sqlite" / "state_5.sqlite")
    connection.row_factory = sqlite3.Row
    try:
        thread = connection.execute(
            "SELECT * FROM threads WHERE id = ?",
            (thread_id,),
        ).fetchone()
        tools = connection.execute(
            "SELECT * FROM thread_dynamic_tools WHERE thread_id = ?",
            (thread_id,),
        ).fetchall()
        return dict(thread), [dict(row) for row in tools]
    finally:
        connection.close()


def test_runtime_fork_archive_uses_base_commit_patch_and_untracked_overlay(
    tmp_path,
):
    _origin, workspace = _create_origin_checkout(tmp_path)
    (workspace / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
    (workspace / "README.md").write_text("committed\n", encoding="utf-8")
    _run_git(workspace, "add", ".")
    _run_git(workspace, "commit", "-m", "initial")
    _run_git(workspace, "push", "-u", "origin", "main")
    base_commit = _commit_id(workspace, "origin/main")

    (workspace / "local.txt").write_text("local commit\n", encoding="utf-8")
    _run_git(workspace, "add", "local.txt")
    _run_git(workspace, "commit", "-m", "local only")
    (workspace / "README.md").write_text("dirty\n", encoding="utf-8")
    (workspace / "notes.txt").write_text("untracked\n", encoding="utf-8")
    ignored_file = workspace / "frontend" / "node_modules" / "pkg" / "index.js"
    ignored_file.parent.mkdir(parents=True)
    ignored_file.write_text("ignored\n", encoding="utf-8")

    archive_path = fork_transfer.create_runtime_fork_archive(str(workspace))

    members = _archive_members(archive_path)
    metadata = json.loads(members["runtime-fork/metadata.json"].decode("utf-8"))
    assert metadata["type"] == "git_patch"
    assert metadata["baseCommit"] == base_commit
    assert metadata["sourceHead"] != base_commit
    assert b"README.md" in members["runtime-fork/git.patch"]
    assert b"dirty" in members["runtime-fork/git.patch"]
    assert b"local.txt" in members["runtime-fork/git.patch"]
    assert b"local commit" in members["runtime-fork/git.patch"]
    assert members["runtime-fork/untracked/notes.txt"] == b"untracked\n"
    assert all(not name.startswith("workspace/.git/") for name in members)
    assert "runtime-fork/untracked/frontend/node_modules/pkg/index.js" not in members


def test_runtime_fork_archive_requires_remote_base_commit(
    tmp_path,
):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _init_git_repo(workspace)
    (workspace / "README.md").write_text("committed\n", encoding="utf-8")
    _run_git(workspace, "add", ".")
    _run_git(workspace, "commit", "-m", "initial")

    with pytest.raises(ValueError, match="origin"):
        fork_transfer.create_runtime_fork_archive(str(workspace))


def test_restore_runtime_fork_archive_applies_patch_and_untracked_overlay(
    tmp_path,
):
    _origin, source = _create_origin_checkout(tmp_path)
    target = tmp_path / "target"
    (source / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
    (source / "README.md").write_text("committed\n", encoding="utf-8")
    _run_git(source, "add", ".")
    _run_git(source, "commit", "-m", "initial")
    _run_git(source, "push", "-u", "origin", "main")
    _run_git(tmp_path, "clone", str(source), str(target))
    _run_git(target, "config", "user.email", "test@example.com")
    _run_git(target, "config", "user.name", "Test User")

    (source / "README.md").write_text("dirty\n", encoding="utf-8")
    (source / "notes.txt").write_text("untracked\n", encoding="utf-8")
    ignored_file = source / "frontend" / "node_modules" / "pkg" / "index.js"
    ignored_file.parent.mkdir(parents=True)
    ignored_file.write_text("ignored\n", encoding="utf-8")

    archive_path = fork_transfer.create_runtime_fork_archive(str(source))
    fork_transfer.restore_runtime_fork_archive(
        archive_content=archive_path.read_bytes(),
        workspace_path=target,
        home_path=tmp_path / "home",
    )

    assert (target / "README.md").read_text(encoding="utf-8") == "dirty\n"
    assert (target / "notes.txt").read_text(encoding="utf-8") == "untracked\n"
    assert not (target / "frontend" / "node_modules" / "pkg" / "index.js").exists()


def test_runtime_fork_archive_includes_only_explicit_session_file(
    tmp_path,
    monkeypatch,
):
    home = tmp_path / "home"
    _origin, workspace = _create_origin_checkout(tmp_path)
    session_path = home / ".codex" / "sessions" / "2026" / "thread.jsonl"
    other_session_path = home / ".codex" / "sessions" / "2026" / "other.jsonl"
    (workspace / "README.md").write_text("committed\n", encoding="utf-8")
    _run_git(workspace, "add", ".")
    _run_git(workspace, "commit", "-m", "initial")
    _run_git(workspace, "push", "-u", "origin", "main")
    session_path.parent.mkdir(parents=True)
    session_path.write_text("thread\n", encoding="utf-8")
    other_session_path.write_text("other\n", encoding="utf-8")
    monkeypatch.setattr(fork_transfer.Path, "home", lambda: home)

    archive_path = fork_transfer.create_runtime_fork_archive(
        str(workspace),
        session_paths=[str(session_path)],
    )

    members = _archive_members(archive_path)
    assert members["home/.codex/sessions/2026/thread.jsonl"] == b"thread\n"
    assert "home/.codex/sessions/2026/other.jsonl" not in members


def test_runtime_fork_session_only_archive_includes_codex_thread_state(
    tmp_path,
    monkeypatch,
):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    thread_id = "thread-1"
    session_path = home / ".codex" / "sessions" / "2026" / "thread.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text("thread\n", encoding="utf-8")
    _create_codex_state_db(
        home,
        thread_id=thread_id,
        rollout_path=session_path,
        cwd=workspace,
    )
    monkeypatch.setattr(fork_transfer.Path, "home", lambda: home)

    archive_path = fork_transfer.create_runtime_fork_archive(
        str(workspace),
        include_workspace=False,
        codex_thread_id=thread_id,
    )

    members = _archive_members(archive_path)
    metadata = json.loads(members["runtime-fork/metadata.json"].decode("utf-8"))
    codex_state = json.loads(members["runtime-fork/codex-state.json"].decode("utf-8"))
    assert metadata["type"] == "session_only"
    assert members["home/.codex/sessions/2026/thread.jsonl"] == b"thread\n"
    assert codex_state["threadId"] == thread_id
    assert codex_state["thread"]["id"] == thread_id
    assert codex_state["rolloutRelativePath"] == ".codex/sessions/2026/thread.jsonl"
    assert codex_state["threadDynamicTools"][0]["name"] == "tool"


def test_restore_session_only_archive_merges_codex_state_for_target_home(
    tmp_path,
    monkeypatch,
):
    source_home = tmp_path / "source-home"
    source_workspace = tmp_path / "source-workspace"
    source_workspace.mkdir()
    target_home = tmp_path / "target-home"
    target_workspace = tmp_path / "target-workspace"
    target_workspace.mkdir()
    thread_id = "thread-1"
    source_session_path = source_home / ".codex" / "sessions" / "2026" / "thread.jsonl"
    source_session_path.parent.mkdir(parents=True)
    source_session_path.write_text("thread\n", encoding="utf-8")
    _create_codex_state_db(
        source_home,
        thread_id=thread_id,
        rollout_path=source_session_path,
        cwd=source_workspace,
    )
    _create_codex_state_db(
        target_home,
        thread_id="existing",
        rollout_path=target_home / ".codex" / "sessions" / "existing.jsonl",
        cwd=tmp_path / "existing-workspace",
    )
    monkeypatch.setattr(fork_transfer.Path, "home", lambda: source_home)
    archive_path = fork_transfer.create_runtime_fork_archive(
        str(source_workspace),
        include_workspace=False,
        codex_thread_id=thread_id,
    )

    fork_transfer.restore_runtime_fork_archive(
        archive_content=archive_path.read_bytes(),
        workspace_path=target_workspace,
        home_path=target_home,
    )

    restored_session_path = (
        target_home / ".codex" / "sessions" / "2026" / "thread.jsonl"
    )
    thread, tools = _fetch_codex_thread_state(target_home, thread_id)
    assert restored_session_path.read_text(encoding="utf-8") == "thread\n"
    assert thread["cwd"] == str(target_workspace)
    assert thread["rollout_path"] == str(restored_session_path)
    assert tools == [
        {
            "thread_id": thread_id,
            "position": 0,
            "name": "tool",
            "description": "desc",
            "input_schema": "{}",
            "defer_loading": 0,
            "namespace": None,
        }
    ]


@pytest.mark.asyncio
async def test_prepare_archive_transfer_runs_archive_creation_off_event_loop(
    tmp_path,
    monkeypatch,
):
    archive_path = tmp_path / "archive.tar.gz"
    thread_names = []

    def create_runtime_fork_archive(
        _workspace_path,
        *,
        session_paths=None,
        include_workspace=True,
        codex_thread_id=None,
    ):
        thread_names.append(threading.current_thread().name)
        time.sleep(0.05)
        archive_path.write_bytes(b"archive")
        return archive_path

    monkeypatch.setattr(
        fork_transfer,
        "create_runtime_fork_archive",
        create_runtime_fork_archive,
    )
    monkeypatch.setattr(
        fork_transfer,
        "register_direct_archive",
        lambda _transfer_id, _archive_path, _token, direct_hosts=None: [
            "http://127.0.0.1/archive"
        ],
    )

    transfer_task = asyncio.create_task(
        fork_transfer.prepare_archive_transfer(
            workspace_path=str(tmp_path),
            transfer_id="transfer-1",
            upload_url=None,
        )
    )
    ticks = 0
    while not transfer_task.done():
        ticks += 1
        await asyncio.sleep(0.01)

    prepared = await transfer_task

    assert prepared.archive_path == archive_path
    assert prepared.direct_urls == ["http://127.0.0.1/archive"]
    assert prepared.direct_token
    assert ticks > 1
    assert thread_names
    assert thread_names[0] != threading.current_thread().name


@pytest.mark.asyncio
async def test_upload_archive_streams_chunks_with_content_length(
    tmp_path,
    monkeypatch,
):
    archive_path = tmp_path / "archive.tar.gz"
    archive_path.write_bytes(b"a" * (fork_transfer.ARCHIVE_IO_CHUNK_BYTES + 3))
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *, timeout):
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, _exc_type, _exc, _tb):
            return None

        async def put(self, url, *, content, headers):
            chunks = []
            async for chunk in content:
                chunks.append(chunk)
            captured["url"] = url
            captured["headers"] = headers
            captured["chunk_sizes"] = [len(chunk) for chunk in chunks]
            return FakeResponse()

    monkeypatch.setattr(fork_transfer.httpx, "AsyncClient", FakeAsyncClient)

    await fork_transfer.upload_archive("https://storage/upload", archive_path)

    assert captured["url"] == "https://storage/upload"
    assert captured["headers"]["Content-Type"] == "application/gzip"
    assert captured["headers"]["Content-Length"] == str(archive_path.stat().st_size)
    assert captured["chunk_sizes"] == [fork_transfer.ARCHIVE_IO_CHUNK_BYTES, 3]
