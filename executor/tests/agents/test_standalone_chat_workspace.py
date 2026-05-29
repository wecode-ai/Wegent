# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace

from executor.agents.claude_code import standalone_chat_workspace as workspace


def test_slugify_response_uses_alphanumeric_words():
    assert workspace.slugify_response("Hello, Codex 2026!") == "hello-codex-2026"
    assert workspace.slugify_response("只有中文") == "new-chat"
    assert (
        workspace.slugify_response("abcdefghijklmnopqrstuvwxyz")
        == "abcdefghijklmnopqrst"
    )


def test_finalize_standalone_chat_workspace_moves_initial_task_workspace(
    tmp_path,
    monkeypatch,
):
    workspace_root = tmp_path / "workspace"
    source = workspace_root / "123"
    source.mkdir(parents=True)
    (source / "keep.txt").write_text("content", encoding="utf-8")
    (source / ".claude_session_id").write_text("session-id", encoding="utf-8")
    chats_root = tmp_path / "chats"
    executor_home = tmp_path / ".wegent-executor"
    task_data = SimpleNamespace(
        task_id=123,
        project_id=None,
        project_workspace_path=None,
        git_url=None,
    )

    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    monkeypatch.setattr(
        workspace.config, "get_workspace_root", lambda: str(workspace_root)
    )
    monkeypatch.setattr(workspace.config, "WEGENT_EXECUTOR_HOME", str(executor_home))

    result = workspace.finalize_standalone_chat_workspace(
        task_data,
        "Hello, Codex 2026!",
    )

    target = chats_root / datetime.now().strftime("%Y-%m-%d") / "hello-codex-2026"
    assert result == str(target)
    assert not source.exists()
    assert (target / "keep.txt").read_text(encoding="utf-8") == "content"
    assert (executor_home / "sessions" / "123" / ".claude_session_id").read_text(
        encoding="utf-8"
    ) == "session-id"


def test_finalize_standalone_chat_workspace_adds_duplicate_suffix(
    tmp_path,
    monkeypatch,
):
    workspace_root = tmp_path / "workspace"
    source = workspace_root / "124"
    source.mkdir(parents=True)
    chats_root = tmp_path / "chats"
    existing = chats_root / datetime.now().strftime("%Y-%m-%d") / "hello"
    existing.mkdir(parents=True)
    task_data = SimpleNamespace(
        task_id=124,
        project_id=None,
        project_workspace_path=None,
        git_url=None,
    )

    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    monkeypatch.setattr(
        workspace.config, "get_workspace_root", lambda: str(workspace_root)
    )

    result = workspace.finalize_standalone_chat_workspace(task_data, "Hello")

    assert result == str(existing.parent / "hello-1")


def test_duplicate_suffix_counts_toward_twenty_character_limit(
    tmp_path,
    monkeypatch,
):
    workspace_root = tmp_path / "workspace"
    source = workspace_root / "125"
    source.mkdir(parents=True)
    chats_root = tmp_path / "chats"
    date_dir = chats_root / datetime.now().strftime("%Y-%m-%d")
    existing = date_dir / "abcdefghijklmnopqrst"
    existing.mkdir(parents=True)
    task_data = SimpleNamespace(
        task_id=125,
        project_id=None,
        project_workspace_path=None,
        git_url=None,
    )

    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    monkeypatch.setattr(
        workspace.config, "get_workspace_root", lambda: str(workspace_root)
    )

    result = workspace.finalize_standalone_chat_workspace(
        task_data,
        "abcdefghijklmnopqrstuvwxyz",
    )

    target_name = "abcdefghijklmnopqr-1"
    assert result == str(date_dir / target_name)
    assert len(target_name) == 20
