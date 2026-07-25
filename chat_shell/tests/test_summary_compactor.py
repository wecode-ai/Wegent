# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from chat_shell.compression.summary_compactor import (
    SUMMARY_METADATA_FLAG,
    SUMMARY_PREFIX,
    SummaryCompactNotApplicable,
    SummaryCompactor,
)
from chat_shell.compression.token_counter import TokenCounter


class _FakeLLM:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    async def ainvoke(self, messages):
        self.calls.append(messages)
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


@pytest.mark.asyncio
async def test_compact_retries_after_context_too_long_by_removing_oldest_history_item():
    llm = _FakeLLM(
        [
            RuntimeError("context length exceeded"),
            AIMessage(content="Current objective:\nretry ok"),
        ]
    )
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=llm, token_counter=counter)

    messages = [
        SystemMessage(content="system"),
        HumanMessage(content="old user"),
        AIMessage(content="assistant"),
        HumanMessage(content="latest user"),
    ]

    result = await compactor.compact(messages, preserve_initial_context=True)

    assert result.removed_history_items == 1
    assert len(llm.calls) == 2
    first_history = llm.calls[0][:-1]
    second_history = llm.calls[1][:-1]
    assert [msg.content for msg in first_history] == [
        "system",
        "old user",
        "assistant",
        "latest user",
    ]
    assert [msg.content for msg in second_history] == [
        "system",
        "assistant",
        "latest user",
    ]
    assert isinstance(result.replacement_history[0], SystemMessage)
    assert result.replacement_history[-1].content.startswith(SUMMARY_PREFIX)


@pytest.mark.asyncio
async def test_compact_continues_trimming_until_only_current_user_floor_remains():
    llm = _FakeLLM(
        [
            RuntimeError("context length exceeded"),
            RuntimeError("context length exceeded"),
            AIMessage(content="Current objective:\ntrimmed to floor"),
        ]
    )
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=llm, token_counter=counter)

    current_user = HumanMessage(content="latest user")
    messages = [
        SystemMessage(content="system"),
        HumanMessage(content="old user"),
        AIMessage(content="assistant"),
        current_user,
    ]

    result = await compactor.compact(messages, preserve_initial_context=True)

    assert result.removed_history_items == 2
    assert len(llm.calls) == 3
    assert [msg.content for msg in llm.calls[-1][:-1]] == [
        "system",
        "latest user",
    ]
    retained_user_messages = [
        message.content
        for message in result.replacement_history
        if isinstance(message, HumanMessage)
        and message.additional_kwargs.get(SUMMARY_METADATA_FLAG) is not True
    ]
    assert retained_user_messages == ["latest user"]


@pytest.mark.asyncio
async def test_compact_caps_overflow_retries_and_sheds_in_batches():
    from chat_shell.compression.summary_compactor import (
        MAX_SUMMARY_OVERFLOW_RETRIES,
    )

    # Always overflow so the retry cap (not success) terminates the loop.
    llm = _FakeLLM(
        [RuntimeError("context length exceeded")] * (MAX_SUMMARY_OVERFLOW_RETRIES + 1)
    )
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=llm, token_counter=counter)

    current_user = HumanMessage(content="latest user")
    messages = (
        [SystemMessage(content="system")]
        + [AIMessage(content=f"a{i}") for i in range(20)]
        + [current_user]
    )

    with pytest.raises(RuntimeError, match="context length exceeded"):
        await compactor.compact(messages, preserve_initial_context=True)

    # Initial attempt + MAX retries, then it raises into the guard fallback
    # instead of grinding a further retry.
    assert len(llm.calls) == MAX_SUMMARY_OVERFLOW_RETRIES + 1
    # Each retry sheds a batch (>1 for a large history), not a single item.
    first_history_len = len(llm.calls[0][:-1])
    second_history_len = len(llm.calls[1][:-1])
    assert first_history_len - second_history_len > 1


def test_remove_oldest_history_items_batches_and_protects_current_user():
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=_FakeLLM([]), token_counter=counter)
    current_user = HumanMessage(content="cu")
    messages = [
        SystemMessage(content="system"),
        AIMessage(content="a1"),
        AIMessage(content="a2"),
        AIMessage(content="a3"),
        current_user,
    ]

    dropped = compactor._remove_oldest_history_items(
        messages, current_user=current_user, count=2
    )

    assert dropped == 2
    assert [msg.content for msg in messages] == ["system", "a3", "cu"]


def test_remove_oldest_history_items_keeps_at_least_one_without_current_user():
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=_FakeLLM([]), token_counter=counter)
    messages = [
        SystemMessage(content="system"),
        AIMessage(content="a1"),
        AIMessage(content="a2"),
    ]

    dropped = compactor._remove_oldest_history_items(
        messages, current_user=None, count=99
    )

    # The newest non-system message is protected even with no current user turn.
    assert dropped == 1
    assert [msg.content for msg in messages] == ["system", "a2"]


@pytest.mark.asyncio
async def test_ephemeral_control_message_not_treated_as_user_or_retained():
    from chat_shell.compression.summary_compactor import EPHEMERAL_CONTROL_FLAG

    llm = _FakeLLM([AIMessage(content="Current objective:\ngo")])
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=llm, token_counter=counter)

    real_user = HumanMessage(content="analyze my data")
    ephemeral = HumanMessage(
        content="[SYSTEM ERROR] truncated, retry",
        additional_kwargs={EPHEMERAL_CONTROL_FLAG: True},
    )
    messages = [real_user, AIMessage(content="partial"), ephemeral]

    result = await compactor.compact(messages, preserve_initial_context=False)

    retained = [
        message.content
        for message in result.replacement_history
        if isinstance(message, HumanMessage)
        and message.additional_kwargs.get(SUMMARY_METADATA_FLAG) is not True
    ]
    assert "analyze my data" in retained  # real user retained as checkpoint
    assert all(
        "[SYSTEM ERROR]" not in content for content in retained
    )  # not the control msg
    # The control message was never handed to the summary LLM either.
    summary_source = llm.calls[0]
    assert all(
        "[SYSTEM ERROR]" not in _content_text(message) for message in summary_source
    )


def _content_text(message) -> str:
    content = getattr(message, "content", "")
    return content if isinstance(content, str) else str(content)


@pytest.mark.asyncio
async def test_compact_builds_summary_message_with_compacted_metadata():
    llm = _FakeLLM([AIMessage(content="Current objective:\nship it")])
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=llm, token_counter=counter)

    result = await compactor.compact(
        [HumanMessage(content="please continue")],
        preserve_initial_context=False,
    )

    summary = result.replacement_history[-1]
    assert isinstance(summary, HumanMessage)
    assert summary.additional_kwargs["compacted"] is True
    assert summary.additional_kwargs[SUMMARY_METADATA_FLAG] is True
    assert summary.content == f"{SUMMARY_PREFIX}\n\nCurrent objective:\nship it"


@pytest.mark.asyncio
async def test_recent_user_messages_truncate_boundary_message_to_fit_budget():
    llm = _FakeLLM([AIMessage(content="Current objective:\ncontinue")])
    counter = TokenCounter(model_name="gpt-4")
    newest = HumanMessage(content="newest user message with extra detail")
    older = HumanMessage(content="older user message that should be truncated")
    newer_tokens = counter.count_messages([{"role": "user", "content": newest.content}])
    limit = newer_tokens + 4
    compactor = SummaryCompactor(
        llm=llm,
        token_counter=counter,
        recent_user_token_limit=limit,
    )

    result = await compactor.compact(
        [older, AIMessage(content="assistant"), newest],
        preserve_initial_context=False,
    )

    retained_user_messages = [
        message.content
        for message in result.replacement_history
        if isinstance(message, HumanMessage)
        and message.additional_kwargs.get(SUMMARY_METADATA_FLAG) is not True
    ]
    assert len(retained_user_messages) == 2
    assert retained_user_messages[1] == newest.content
    assert retained_user_messages[0] != older.content
    assert retained_user_messages[0]


@pytest.mark.asyncio
async def test_compact_sanitizes_orphan_tool_messages_before_llm_call():
    llm = _FakeLLM([AIMessage(content="Current objective:\ncontinue")])
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=llm, token_counter=counter)

    messages = [
        SystemMessage(content="system"),
        AIMessage(
            content="I will use tools",
            tool_calls=[
                {"id": "call-1", "name": "read_file", "args": {"path": "a"}},
                {"id": "call-2", "name": "read_file", "args": {"path": "b"}},
            ],
        ),
        ToolMessage(content="result a", tool_call_id="call-1", name="read_file"),
        HumanMessage(content="latest user"),
    ]

    await compactor.compact(messages, preserve_initial_context=True)

    compact_history = llm.calls[0][1:-1]
    assistant_message = next(
        message for message in compact_history if isinstance(message, AIMessage)
    )
    tool_messages = [
        message for message in compact_history if isinstance(message, ToolMessage)
    ]

    assert [tool_call["id"] for tool_call in assistant_message.tool_calls] == ["call-1"]
    assert len(tool_messages) == 1
    assert tool_messages[0].tool_call_id == "call-1"


@pytest.mark.asyncio
async def test_compact_short_circuits_when_floor_still_exceeds_compact_budget():
    llm = _FakeLLM([AIMessage(content="should not be used")])
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(
        llm=llm,
        token_counter=counter,
        max_compact_input_tokens=1,
    )

    with pytest.raises(SummaryCompactNotApplicable):
        await compactor.compact(
            [
                SystemMessage(content="system"),
                HumanMessage(content="latest user message"),
            ],
            preserve_initial_context=True,
        )

    assert llm.calls == []


@pytest.mark.asyncio
async def test_compact_raises_when_llm_returns_empty_summary():
    llm = _FakeLLM([AIMessage(content="   ")])
    counter = TokenCounter(model_name="gpt-4")
    compactor = SummaryCompactor(llm=llm, token_counter=counter)

    with pytest.raises(SummaryCompactNotApplicable):
        await compactor.compact(
            [HumanMessage(content="please continue")],
            preserve_initial_context=False,
        )


def test_trim_to_budget_single_pass_counts_each_message_once():
    counter = TokenCounter(model_name="gpt-4")
    call_count = {"n": 0}
    real = counter.count_messages

    def counting(msgs):
        call_count["n"] += 1
        return real(msgs)

    counter.count_messages = counting  # type: ignore[assignment]

    # Budget above the instruction-framing floor but below the full total,
    # so trimming is required and can succeed.
    compactor = SummaryCompactor(
        llm=object(),
        token_counter=counter,
        max_compact_input_tokens=300,
    )
    system = SystemMessage(content="sys")
    current = HumanMessage(content="current question")
    old = [HumanMessage(content="old " * 60) for _ in range(20)]
    messages = [system, *old, current]
    original_len = len(messages)

    removed = compactor._trim_to_budget(messages, current_user=current)

    # Budget met, system + current preserved.
    assert system in messages
    assert current in messages
    assert removed > 0
    # O(n): one priming baseline + one count per original message + one framing
    # count (+1 slack), NOT O(n^2).
    assert call_count["n"] <= original_len + 3


def test_trim_to_budget_uses_exact_prompt_count_no_priming_inflation():
    from chat_shell.compression.summary_compactor import (
        COMPACT_TASK_INSTRUCTION,
        _message_to_counter_dict,
    )

    counter = TokenCounter(model_name="gpt-4")
    msgs = [
        SystemMessage(content="sys"),
        HumanMessage(content="a " * 30),
        HumanMessage(content="b " * 30),
        HumanMessage(content="current"),
    ]
    # Exact tokens of the prompt actually sent (messages + instruction), one call.
    exact = counter.count_messages(
        [_message_to_counter_dict(m) for m in msgs]
        + [_message_to_counter_dict(HumanMessage(content=COMPACT_TASK_INSTRUCTION))]
    )
    compactor = SummaryCompactor(
        llm=object(), token_counter=counter, max_compact_input_tokens=exact
    )
    before = list(msgs)
    removed = compactor._trim_to_budget(msgs, current_user=msgs[-1])
    # Budget == exact prompt size → nothing to trim. The old per-message priming
    # inflation would have over-estimated and deleted messages.
    assert removed == 0
    assert msgs == before


@pytest.mark.asyncio
async def test_compact_sanitizes_orphan_before_budget():
    from chat_shell.compression.summary_compactor import (
        COMPACT_TASK_INSTRUCTION,
        _message_to_counter_dict,
    )

    llm = _FakeLLM([AIMessage(content="Current objective:\nok")])
    counter = TokenCounter(model_name="gpt-4")
    valid = HumanMessage(content="valid old message")
    orphan = ToolMessage(content="x " * 1000, tool_call_id="missing", name="t")
    current = HumanMessage(content="current question")
    # Budget fits only the sanitized prompt (valid + current + instruction); the
    # orphan's tokens would push a raw-based estimate over and wrongly delete the
    # valid message before it.
    exact = counter.count_messages(
        [
            _message_to_counter_dict(valid),
            _message_to_counter_dict(current),
            _message_to_counter_dict(HumanMessage(content=COMPACT_TASK_INSTRUCTION)),
        ]
    )
    compactor = SummaryCompactor(
        llm=llm, token_counter=counter, max_compact_input_tokens=exact
    )

    result = await compactor.compact(
        [valid, orphan, current], preserve_initial_context=False
    )

    assert result.removed_history_items == 0
    sent_contents = [getattr(m, "content", "") for m in llm.calls[0]]
    assert "valid old message" in sent_contents


def test_is_context_too_long_error_matches_status_and_chinese():
    from chat_shell.compression.summary_compactor import _is_context_too_long_error

    class Boom(Exception):
        def __init__(self, msg, status=None):
            super().__init__(msg)
            self.status_code = status

    assert _is_context_too_long_error(Boom("输入长度超过最大限制"))
    assert _is_context_too_long_error(Boom("请求体过大", status=413))
    assert _is_context_too_long_error(Boom("token 数量超过上限"))
    assert not _is_context_too_long_error(Boom("temporary network blip"))
    # 413 is unconditional overflow; a bare 400 is not (avoids retry storm).
    assert _is_context_too_long_error(Boom("anything", status=413))
    assert not _is_context_too_long_error(Boom("invalid parameter", status=400))
    # A 400 that also carries a length marker still counts as overflow.
    assert _is_context_too_long_error(Boom("输入长度超过限制", status=400))
    # Generic Chinese "exceeds" phrases about params must NOT be overflow, or a
    # param-validation 400 would trigger a remove-and-retry storm.
    assert not _is_context_too_long_error(Boom("temperature 超过上限", status=400))
    assert not _is_context_too_long_error(Boom("top_p 超过最大允许值", status=400))


@pytest.mark.asyncio
async def test_generate_summary_times_out():
    class HangingLLM:
        async def ainvoke(self, _messages):
            await asyncio.sleep(5)

    compactor = SummaryCompactor(
        llm=HangingLLM(),
        token_counter=TokenCounter(model_name="gpt-4"),
        request_timeout=0.05,
    )
    with pytest.raises((asyncio.TimeoutError, TimeoutError)):
        await compactor._generate_summary([])


@pytest.mark.asyncio
async def test_summary_instruction_is_final_turn():
    from chat_shell.compression.summary_compactor import COMPACT_TASK_INSTRUCTION

    captured = {}

    class CaptureLLM:
        async def ainvoke(self, messages):
            captured["messages"] = messages
            return AIMessage(content="SUMMARY BODY")

    compactor = SummaryCompactor(
        llm=CaptureLLM(), token_counter=TokenCounter(model_name="gpt-4")
    )
    history = [HumanMessage(content="q1"), AIMessage(content="a1")]
    body = await compactor._generate_summary(history)

    assert body == "SUMMARY BODY"
    msgs = captured["messages"]
    # Instruction is the LAST message and a HumanMessage (recency wins).
    assert isinstance(msgs[-1], HumanMessage)
    assert COMPACT_TASK_INSTRUCTION in msgs[-1].content
    # No leading SystemMessage instruction.
    assert getattr(msgs[0], "content", "") != COMPACT_TASK_INSTRUCTION


def test_summary_recognized_by_marker_not_content():
    # A reloaded summary carries the trusted marker (restored from HTTP metadata):
    # it must be excluded from retained recent-user messages, or summaries
    # accumulate each compaction.
    compactor = SummaryCompactor(
        llm=object(), token_counter=TokenCounter(model_name="gpt-4")
    )
    summary = HumanMessage(
        content=f"{SUMMARY_PREFIX}\n\nold objective",
        additional_kwargs={"summary_compacted": True},
    )
    real_user = HumanMessage(content="real question")

    selected = compactor._select_recent_user_messages([summary, real_user])

    assert [m.content for m in selected] == ["real question"]
    assert compactor._find_current_user_message([summary, real_user]) is real_user


def test_user_message_starting_with_marker_is_not_summary():
    # A user may legitimately send text starting with the summary prefix; without
    # the trusted marker it must be treated as a real user message, not dropped.
    compactor = SummaryCompactor(
        llm=object(), token_counter=TokenCounter(model_name="gpt-4")
    )
    prev = HumanMessage(content="previous request")
    spoof = HumanMessage(content="[COMPACT SUMMARY] please review this literal text")

    selected = compactor._select_recent_user_messages([prev, spoof])

    assert any("literal text" in m.content for m in selected)
    assert compactor._find_current_user_message([prev, spoof]) is spoof


def test_replacement_history_marks_retained_user():
    compactor = SummaryCompactor(
        llm=object(), token_counter=TokenCounter(model_name="gpt-4")
    )
    history = [HumanMessage(content="keep me")]
    replacement = compactor._build_replacement_history(
        history, summary_body="S", preserve_initial_context=False
    )
    retained = [
        m
        for m in replacement
        if isinstance(m, HumanMessage)
        and m.additional_kwargs.get("checkpoint_retained") is True
    ]
    assert retained, "retained user message must carry checkpoint_retained"
    assert retained[0].id, "retained user message must have a fresh id"
    # The summary message is separate and keeps its summary marker.
    assert any(
        m.additional_kwargs.get(SUMMARY_METADATA_FLAG) is True for m in replacement
    )
