# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the history-backtracking wiring helper in chat context."""

from chat_shell.services.context import _history_backtrack_signals


def test_signals_extract_subtask_ids_and_compaction():
    history = [
        {"id": "10", "role": "user", "content": "hi"},
        {
            "id": "11-0",
            "role": "assistant",
            "content": "sum",
            "metadata": {"summary_compacted": True},
        },
        {"id": "11-1", "role": "assistant", "content": "reply"},
        {"role": "assistant", "content": "no id"},
        "not-a-dict",
    ]

    ids, had_compaction = _history_backtrack_signals(history)

    assert ids == frozenset({10, 11})
    assert had_compaction is True


def test_signals_no_compaction_marker():
    history = [{"id": "5", "role": "user", "content": "hi", "metadata": {}}]
    ids, had_compaction = _history_backtrack_signals(history)
    assert ids == frozenset({5})
    assert had_compaction is False
