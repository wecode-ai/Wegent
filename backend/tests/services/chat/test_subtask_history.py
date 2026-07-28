# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the shared subtask-history service (list + read paging)."""

from types import SimpleNamespace

from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.chat import subtask_history


def _subtask(sid, role, **kw):
    base = dict(
        id=sid,
        task_id=2,
        user_id=7,
        role=role,
        status=SubtaskStatus.COMPLETED,
        message_id=sid,
        prompt=None,
        result=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _patch_get_by_id(monkeypatch, subtask):
    monkeypatch.setattr(
        subtask_history.subtask_store,
        "get_by_id",
        lambda db, *, subtask_id, owner_user_id=None: subtask,
        raising=False,
    )


def test_list_summaries_pagination_and_delete_filter(monkeypatch):
    deleted = _subtask(3, SubtaskRole.ASSISTANT, result={"value": "gone"})
    deleted.status = SubtaskStatus.DELETE
    rows = [
        _subtask(1, SubtaskRole.USER, prompt="a"),
        _subtask(2, SubtaskRole.ASSISTANT, result={"value": "b"}),
        deleted,
        _subtask(4, SubtaskRole.USER, prompt="c"),
    ]
    monkeypatch.setattr(
        subtask_history.subtask_store,
        "list_new_messages_since",
        lambda db, **kw: rows,
        raising=False,
    )

    out = subtask_history.list_subtask_summaries(
        None, task_id=2, user_id=7, limit=2, offset=0
    )

    assert out["total"] == 3  # deleted excluded
    assert [s["id"] for s in out["subtasks"]] == [1, 2]
    assert out["has_more"] is True


def test_read_stops_on_whole_unit_boundary(monkeypatch):
    st = _subtask(
        2,
        SubtaskRole.ASSISTANT,
        result={
            "blocks": [
                {"type": "text", "content": "AAAA"},
                {"type": "text", "content": "BBBB"},
            ]
        },
    )
    _patch_get_by_id(monkeypatch, st)

    # Budget fits one 4-char block but not two -> first page is block A whole.
    page1 = subtask_history.read_subtask_record(
        None, task_id=2, subtask_id=2, user_id=7, max_chars=5
    )
    assert page1["content"] == "AAAA"
    assert page1["next_cursor"] == "1:0"
    assert page1["has_more"] is True

    page2 = subtask_history.read_subtask_record(
        None, task_id=2, subtask_id=2, user_id=7, cursor="1:0", max_chars=5
    )
    assert page2["content"] == "BBBB"
    assert page2["has_more"] is False


def test_read_splits_oversized_single_unit(monkeypatch):
    st = _subtask(
        2,
        SubtaskRole.ASSISTANT,
        result={"blocks": [{"type": "text", "content": "ABCDEFGHIJ"}]},
    )
    _patch_get_by_id(monkeypatch, st)

    page1 = subtask_history.read_subtask_record(
        None, task_id=2, subtask_id=2, user_id=7, max_chars=4
    )
    assert page1["content"] == "ABCD"
    assert page1["next_cursor"] == "0:4"
    assert page1["has_more"] is True

    page_end = subtask_history.read_subtask_record(
        None, task_id=2, subtask_id=2, user_id=7, cursor="0:8", max_chars=4
    )
    assert page_end["content"] == "IJ"
    assert page_end["has_more"] is False


def test_read_renders_tool_block(monkeypatch):
    st = _subtask(
        2,
        SubtaskRole.ASSISTANT,
        result={
            "blocks": [
                {
                    "type": "tool",
                    "tool_name": "Bash",
                    "tool_input": {"cmd": "ls"},
                    "tool_output": "a.txt",
                },
            ]
        },
    )
    _patch_get_by_id(monkeypatch, st)

    out = subtask_history.read_subtask_record(None, task_id=2, subtask_id=2, user_id=7)
    assert "Bash" in out["content"]
    assert "a.txt" in out["content"]


def test_read_user_prompt(monkeypatch):
    st = _subtask(1, SubtaskRole.USER, prompt="the question")
    _patch_get_by_id(monkeypatch, st)

    out = subtask_history.read_subtask_record(None, task_id=2, subtask_id=1, user_id=7)
    assert out["content"] == "the question"
    assert out["role"] == "user"
    assert out["has_more"] is False


def test_read_rejects_deleted_and_foreign(monkeypatch):
    deleted = _subtask(2, SubtaskRole.ASSISTANT, result={"value": "x"})
    deleted.status = SubtaskStatus.DELETE
    _patch_get_by_id(monkeypatch, deleted)
    assert (
        subtask_history.read_subtask_record(None, task_id=2, subtask_id=2, user_id=7)
        is None
    )

    foreign = _subtask(9, SubtaskRole.ASSISTANT, task_id=999, result={"value": "x"})
    _patch_get_by_id(monkeypatch, foreign)
    assert (
        subtask_history.read_subtask_record(None, task_id=2, subtask_id=9, user_id=7)
        is None
    )
