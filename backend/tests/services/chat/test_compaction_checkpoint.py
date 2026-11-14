# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from app.models.subtask import SubtaskRole, SubtaskStatus


def _assistant(msg_id, chain, status=SubtaskStatus.COMPLETED):
    return SimpleNamespace(
        role=SubtaskRole.ASSISTANT,
        status=status,
        message_id=msg_id,
        id=msg_id,
        created_at=None,
        result={"messages_chain": chain},
    )


def test_scope_to_latest_checkpoint():
    from app.services.chat.compaction_checkpoint import (
        scope_to_latest_checkpoint,
        subtask_has_summary_checkpoint,
    )

    plain = _assistant(1, [{"role": "assistant", "content": "hi"}])
    ckpt = _assistant(
        2,
        [
            {
                "role": "user",
                "content": "q",
                "additional_kwargs": {"checkpoint_retained": True},
            },
            {
                "role": "user",
                "content": "[COMPACT SUMMARY] ...",
                "additional_kwargs": {"summary_compacted": True},
            },
            {"role": "assistant", "content": "final"},
        ],
    )
    after = _assistant(3, [{"role": "assistant", "content": "later"}])

    assert not subtask_has_summary_checkpoint(plain)
    assert subtask_has_summary_checkpoint(ckpt)

    sliced, idx = scope_to_latest_checkpoint([plain, ckpt, after])
    assert idx == 1
    assert sliced == [ckpt, after]

    unchanged, none_idx = scope_to_latest_checkpoint([plain, after])
    assert none_idx is None and unchanged == [plain, after]


def test_event_without_marker_is_not_checkpoint():
    from app.services.chat.compaction_checkpoint import subtask_has_summary_checkpoint

    # Chain has NO summary_compacted marker even though a compaction event exists.
    st = _assistant(9, [{"role": "assistant", "content": "no marker here"}])
    st.result["context_compactions"] = [{"status": "completed"}]
    assert not subtask_has_summary_checkpoint(st)


def test_checkpoint_chain_preserves_summary_and_suffix():
    from app.services.chat.compaction_checkpoint import (
        scope_to_latest_checkpoint,
        subtask_has_summary_checkpoint,
    )

    chain = [
        {
            "role": "user",
            "content": "keep me",
            "additional_kwargs": {"checkpoint_retained": True},
        },
        {
            "role": "user",
            "content": "[COMPACT SUMMARY] body",
            "additional_kwargs": {"summary_compacted": True},
        },
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "t1",
                    "type": "function",
                    "function": {"name": "exec", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "content": "tool result", "tool_call_id": "t1"},
        {"role": "assistant", "content": "final answer"},
    ]
    ckpt = _assistant(1, chain)
    assert subtask_has_summary_checkpoint(ckpt)
    sliced, idx = scope_to_latest_checkpoint([ckpt])
    assert idx == 0 and sliced == [ckpt]
    # The persisted chain itself carries retained-user + summary + full suffix
    # (tool_call, matching tool_result, final answer) — nothing is sliced out.
    roles = [m["role"] for m in ckpt.result["messages_chain"]]
    assert roles == ["user", "user", "assistant", "tool", "assistant"]
    assert ckpt.result["messages_chain"][2]["tool_calls"][0]["id"] == "t1"
    assert ckpt.result["messages_chain"][3]["tool_call_id"] == "t1"


def test_from_latest_compaction_limit_keeps_checkpoint():
    from app.services.chat.compaction_checkpoint import (
        apply_checkpoint_limit,
        scope_to_latest_checkpoint,
    )

    def st(i, is_ckpt=False):
        chain = [{"role": "assistant", "content": f"t{i}"}]
        if is_ckpt:
            chain = [
                {
                    "role": "user",
                    "content": "[COMPACT SUMMARY]",
                    "additional_kwargs": {"summary_compacted": True},
                },
            ]
        node = _assistant(i, chain)
        node.is_ckpt = is_ckpt
        return node

    subtasks = [st(0), st(1, True), st(2), st(3), st(4)]

    scoped, idx = scope_to_latest_checkpoint(subtasks)
    assert idx == 1

    # limit=2 must keep the checkpoint (index 0 of scoped) + last (limit-1) tail.
    kept = apply_checkpoint_limit(scoped, limit=2, from_latest_compaction=True)
    assert kept[0].is_ckpt is True
    assert kept[-1].message_id == 4
    assert len(kept) == 2


def test_resolve_history_subtasks_is_single_pipeline(monkeypatch):
    from app.services.chat import compaction_checkpoint as cc

    def st(i, is_ckpt=False):
        chain = [{"role": "assistant", "content": f"t{i}"}]
        if is_ckpt:
            chain = [
                {
                    "role": "user",
                    "content": "[COMPACT SUMMARY]",
                    "additional_kwargs": {"summary_compacted": True},
                }
            ]
        return _assistant(i, chain)

    items = [
        SimpleNamespace(subtask=st(0)),
        SimpleNamespace(subtask=st(1, True)),
        SimpleNamespace(subtask=st(2)),
    ]
    monkeypatch.setattr(
        cc.task_fork_history_resolver, "resolve_for_task", lambda *a, **k: items
    )

    out = cc.resolve_history_subtasks(
        db=None,
        task_id=1,
        user_id=1,
        before_message_id=None,
        limit=None,
        from_latest_compaction=True,
        statuses=None,
    )
    assert [s.message_id for s in out] == [1, 2]


def test_resolve_history_no_checkpoint_uses_plain_limit(monkeypatch):
    from app.services.chat import compaction_checkpoint as cc

    # Five uncompacted turns (no summary_compacted marker anywhere).
    items = [
        SimpleNamespace(
            subtask=_assistant(i, [{"role": "assistant", "content": f"t{i}"}])
        )
        for i in range(5)
    ]
    monkeypatch.setattr(
        cc.task_fork_history_resolver,
        "resolve_for_task",
        lambda *a, **k: (
            [] if k.get("summary_checkpoint_only") else items[-k["limit"] :]
        ),
    )

    out = cc.resolve_history_subtasks(
        db=None,
        task_id=1,
        user_id=1,
        before_message_id=None,
        limit=2,
        from_latest_compaction=True,
        statuses=None,
    )
    # No checkpoint yet -> plain "most recent N", NOT [oldest] + last N-1.
    assert [s.message_id for s in out] == [3, 4]


@pytest.mark.parametrize("limit", [1, 2, 20])
def test_bounded_history_keeps_old_checkpoint_without_loading_all(monkeypatch, limit):
    from app.services.chat import compaction_checkpoint as cc

    checkpoint = _assistant(2, [{"additional_kwargs": {"summary_compacted": True}}])
    subtasks = [_assistant(i, [{"content": str(i)}]) for i in range(1, 50)]
    subtasks[1] = checkpoint
    calls = []

    def resolve(_db, **options):
        calls.append(options)
        eligible = [checkpoint] if options.get("summary_checkpoint_only") else subtasks
        return [
            SimpleNamespace(subtask=subtask)
            for subtask in eligible[-options["limit"] :]
        ]

    monkeypatch.setattr(cc.task_fork_history_resolver, "resolve_for_task", resolve)
    out = cc.resolve_history_subtasks(
        db=None, task_id=1, user_id=7, limit=limit, from_latest_compaction=True
    )

    assert out[0] is checkpoint
    assert len(out) == limit
    assert [call["limit"] for call in calls] == ([1] if limit == 1 else [1, limit - 1])
    assert calls[0]["summary_checkpoint_only"] is True
    if limit > 1:
        assert [row.message_id for row in out[1:]] == list(range(50 - limit + 1, 50))


@pytest.mark.parametrize("limit", [0, -1])
def test_nonpositive_shared_limit_preserves_checkpoint_scope(monkeypatch, limit):
    from app.services.chat import compaction_checkpoint as cc

    monkeypatch.setattr(
        cc.task_fork_history_resolver,
        "resolve_for_task",
        lambda *a, **k: [
            SimpleNamespace(subtask=_assistant(1, [])),
            SimpleNamespace(
                subtask=_assistant(
                    2, [{"additional_kwargs": {"summary_compacted": True}}]
                )
            ),
            SimpleNamespace(subtask=_assistant(3, [])),
        ],
    )
    result = cc.resolve_history_subtasks(
        db=None, task_id=1, user_id=7, limit=limit, from_latest_compaction=True
    )
    assert [row.message_id for row in result] == [2, 3]


@pytest.mark.parametrize("forked", [False, True])
@pytest.mark.parametrize("from_latest_compaction", [False, True])
def test_database_history_only_loads_window_and_latest_valid_checkpoint(
    test_db,
    monkeypatch,
    forked,
    from_latest_compaction,
):
    from app.services.chat import compaction_checkpoint as cc
    from app.services.task_fork_history import subtask_store
    from tests.services.test_task_fork_history import _subtask, _task

    root = _task(1, 8)
    fork = _task(2, 7, fork={"sourceTaskId": 1, "afterMessageId": 70, "rootTaskId": 1})
    rows = [_subtask(i, 1, 8, i, SubtaskRole.ASSISTANT) for i in range(1, 101)]
    for index in [1, 4, 79]:
        rows[index].result = {
            "messages_chain": [{"additional_kwargs": {"summary_compacted": True}}]
        }
    rows[49].status = SubtaskStatus.PENDING
    test_db.add_all([root, fork, *rows])
    test_db.flush()
    test_db.expunge_all()
    loaded = []
    original_load = subtask_store._load_ordered

    def record_load(db, ids):
        loaded.append(list(ids))
        return original_load(db, ids)

    monkeypatch.setattr(subtask_store, "_load_ordered", record_load)
    subtasks = cc.resolve_history_subtasks(
        db=test_db,
        task_id=2 if forked else 1,
        user_id=7 if forked else 8,
        before_message_id=61,
        limit=20,
        from_latest_compaction=from_latest_compaction,
    )

    tail = [i for i in range(1, 61) if i != 50]
    expected = [5] + tail[-19:] if from_latest_compaction else tail[-20:]
    assert [row.id for row in subtasks] == expected
    assert sum(map(len, loaded)) == 20
    assert all(len(ids) <= 20 for ids in loaded)
    assert set(identifier for ids in loaded for identifier in ids) == set(expected)


def test_subtask_to_messages_forwards_summary_marker_via_metadata():
    from app.api.endpoints.internal.chat_storage import subtask_to_messages

    chain = [
        {
            "role": "user",
            "content": "[COMPACT SUMMARY] body",
            "additional_kwargs": {"summary_compacted": True},
        },
        {"role": "assistant", "content": "ok"},
    ]
    st = SimpleNamespace(
        id=1,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.COMPLETED,
        created_at=None,
        result={"messages_chain": chain},
    )
    resps = subtask_to_messages(st, db=None, is_group_chat=False)
    assert resps[0].metadata == {"summary_compacted": True}
    assert resps[1].metadata is None
