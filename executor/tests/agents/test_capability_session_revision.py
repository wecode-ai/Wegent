# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from executor.agents.claude_code.session_manager import SessionManager
from executor.agents.codex.session_store import CodeXSessionStore


def test_claude_session_is_invalidated_when_capability_revision_changes(tmp_path):
    SessionManager.set_task_session_root(1001, str(tmp_path / "sessions"))
    try:
        SessionManager.save_session_id(
            1001,
            "claude-session-old",
            bot_id=2002,
            capability_revision=1,
        )

        assert (
            SessionManager.load_saved_session_id(
                1001,
                bot_id=2002,
                capability_revision=1,
            )
            == "claude-session-old"
        )
        assert (
            SessionManager.load_saved_session_id(
                1001,
                bot_id=2002,
                capability_revision=2,
            )
            is None
        )
    finally:
        SessionManager.set_task_session_root(1001, None)


def test_codex_thread_is_invalidated_when_capability_revision_changes(tmp_path):
    store = CodeXSessionStore(root=tmp_path / "codex")
    store.save(
        task_id=1001,
        bot_id=2002,
        thread_id="codex-thread-old",
        capability_revision=1,
    )

    assert (
        store.load(
            task_id=1001,
            bot_id=2002,
            new_session=False,
            capability_revision=1,
        )
        == "codex-thread-old"
    )
    assert (
        store.load(
            task_id=1001,
            bot_id=2002,
            new_session=False,
            capability_revision=2,
        )
        is None
    )
