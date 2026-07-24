# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.models.subtask import SubtaskRole, SubtaskStatus


def _assistant(msg_id, chain, status=SubtaskStatus.COMPLETED):
    return SimpleNamespace(
        role=SubtaskRole.ASSISTANT,
        status=status,
        message_id=msg_id,
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
        cc.task_fork_history_resolver, "resolve_for_task", lambda *a, **k: items
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
