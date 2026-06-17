# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from chat_shell.compression.summary_compactor import (
    SUMMARY_METADATA_FLAG,
    SUMMARY_PREFIX,
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
