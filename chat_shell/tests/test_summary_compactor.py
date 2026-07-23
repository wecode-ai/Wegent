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
    first_history = llm.calls[0][1:-1]
    second_history = llm.calls[1][1:-1]
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
    assert [msg.content for msg in llm.calls[-1][1:-1]] == [
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
    # O(n): one count per original message + one framing count (+1 slack),
    # NOT O(n^2).
    assert call_count["n"] <= original_len + 2


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
