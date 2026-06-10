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


def test_prompt_text_for_workspace_extracts_text_blocks():
    prompt = [
        {"type": "input_text", "text": "hello-new-wework"},
        {"type": "input_image", "image_url": "data:image/png;base64,abc"},
        {"type": "message", "content": "run pwd"},
    ]

    assert workspace.prompt_text_for_workspace(prompt) == "hello-new-wework\nrun pwd"


def test_code_task_is_not_a_standalone_chat_even_without_project_or_git_url(
    tmp_path,
    monkeypatch,
):
    """A code task must never be moved into the dated chats tree, even when
    project_id / git_url happen to be empty. This protects the main frontend
    code path from being hijacked into the chats workspace by accident."""
    chats_root = tmp_path / "chats"
    task_data = SimpleNamespace(
        task_id=120,
        task_type="code",
        project_id=None,
        project_workspace_path=None,
        git_url=None,
    )

    # No env var must be set; the feature is always-on for chat tasks and
    # always-off for everything else.
    monkeypatch.delenv("WEGENT_EXECUTOR_STANDALONE_CHATS_ENABLED", raising=False)
    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))

    assert workspace.is_initial_standalone_chat(task_data) is False
    assert workspace.prepare_standalone_chat_workspace(task_data, "hello") is None
    assert not chats_root.exists()


def test_chat_task_with_no_metadata_is_a_standalone_chat(tmp_path, monkeypatch):
    """A chat task with no project/git metadata is the canonical standalone
    chat case and must prepare the dated workspace without any env var."""
    workspace_root = tmp_path / "workspace"
    source = workspace_root / "121"
    source.mkdir(parents=True)
    chats_root = tmp_path / "chats"
    task_data = SimpleNamespace(
        task_id=121,
        task_type="chat",
        project_id=None,
        project_workspace_path=None,
        git_url=None,
    )

    monkeypatch.delenv("WEGENT_EXECUTOR_STANDALONE_CHATS_ENABLED", raising=False)
    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    monkeypatch.setattr(
        workspace.config, "get_workspace_root", lambda: str(workspace_root)
    )

    result = workspace.prepare_standalone_chat_workspace(task_data, "hello")

    target = chats_root / datetime.now().strftime("%Y-%m-%d") / "hello"
    assert result == str(target)
    assert target.exists()


def test_code_task_with_existing_workspace_path_does_not_finalize_into_chats(
    tmp_path,
    monkeypatch,
):
    """Even when a code task already has a `project_workspace_path` set (e.g.
    resumed from a previous round), `finalize_standalone_chat_workspace`
    must not move it into the chats tree."""
    workspace_path = tmp_path / "chats" / "2026-05-29" / "hello"
    workspace_path.mkdir(parents=True)
    task_data = SimpleNamespace(
        task_id=121,
        task_type="code",
        project_id=None,
        project_workspace_path=str(workspace_path),
        git_url=None,
    )

    monkeypatch.delenv("WEGENT_EXECUTOR_STANDALONE_CHATS_ENABLED", raising=False)

    assert workspace.prepared_standalone_chat_workspace_path(task_data) is None
    assert workspace.finalize_standalone_chat_workspace(task_data, "response") is None


def test_prepare_standalone_chat_workspace_uses_request_text_before_execution(
    tmp_path,
    monkeypatch,
):
    workspace_root = tmp_path / "workspace"
    source = workspace_root / "122"
    source.mkdir(parents=True)
    (source / "keep.txt").write_text("content", encoding="utf-8")
    (source / ".claude").mkdir()
    (source / ".claude" / "claude.json").write_text("{}", encoding="utf-8")
    chats_root = tmp_path / "chats"
    task_data = SimpleNamespace(
        task_id=122,
        task_type="chat",
        project_id=None,
        project_workspace_path=None,
        git_url=None,
    )

    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    monkeypatch.setattr(
        workspace.config, "get_workspace_root", lambda: str(workspace_root)
    )

    result = workspace.prepare_standalone_chat_workspace(
        task_data,
        "hello-new-wework",
    )

    target = chats_root / datetime.now().strftime("%Y-%m-%d") / "hello-new-wework"
    assert result == str(target)
    assert (source / ".claude").exists()
    assert (target / "keep.txt").read_text(encoding="utf-8") == "content"
    assert not (target / ".claude").exists()


def test_finalize_returns_prepared_standalone_workspace_path(tmp_path, monkeypatch):
    workspace_path = tmp_path / "chats" / "2026-05-29" / "hello"
    workspace_path.mkdir(parents=True)
    executor_home = tmp_path / ".wegent-executor"
    task_data = SimpleNamespace(
        task_id=121,
        task_type="chat",
        project_id=None,
        project_workspace_path=str(workspace_path),
        git_url=None,
    )

    monkeypatch.setattr(workspace.config, "WEGENT_EXECUTOR_HOME", str(executor_home))

    result = workspace.finalize_standalone_chat_workspace(
        task_data,
        "response text should not rename",
    )

    assert result == str(workspace_path)


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
        task_type="chat",
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
    assert (target / "keep.txt").read_text(encoding="utf-8") == "content"
    assert (executor_home / "sessions" / "123" / ".claude_session_id").read_text(
        encoding="utf-8"
    ) == "session-id"


def test_finalize_standalone_chat_workspace_keeps_existing_session_root(
    tmp_path,
    monkeypatch,
):
    workspace_root = tmp_path / "workspace"
    source = workspace_root / "126"
    source.mkdir(parents=True)
    (source / ".claude_session_id").write_text("stale-session-id", encoding="utf-8")
    chats_root = tmp_path / "chats"
    executor_home = tmp_path / ".wegent-executor"
    session_file = executor_home / "sessions" / "126" / ".claude_session_id"
    session_file.parent.mkdir(parents=True)
    session_file.write_text("current-session-id", encoding="utf-8")
    task_data = SimpleNamespace(
        task_id=126,
        task_type="chat",
        project_id=None,
        project_workspace_path=None,
        git_url=None,
    )

    monkeypatch.setenv("WEGENT_EXECUTOR_CHATS_DIR", str(chats_root))
    monkeypatch.setattr(
        workspace.config, "get_workspace_root", lambda: str(workspace_root)
    )
    monkeypatch.setattr(workspace.config, "WEGENT_EXECUTOR_HOME", str(executor_home))

    workspace.finalize_standalone_chat_workspace(task_data, "Hello")

    assert session_file.read_text(encoding="utf-8") == "current-session-id"


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
        task_type="chat",
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
        task_type="chat",
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
