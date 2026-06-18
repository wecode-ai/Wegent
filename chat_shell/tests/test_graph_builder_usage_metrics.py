# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from chat_shell.agents.graph_builder import (
    _extract_model_input_messages,
    _extract_model_input_tokens,
)


def test_extract_model_input_messages_from_callback_event():
    event = {
        "data": {
            "input": {
                "messages": [
                    SystemMessage(content="sys"),
                    HumanMessage(content="hello"),
                ]
            }
        }
    }

    assert _extract_model_input_messages(event) == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
    ]


def test_extract_model_input_tokens_prefers_usage_metadata():
    output = AIMessage(
        content="done",
        usage_metadata={
            "input_tokens": 321,
            "output_tokens": 12,
            "total_tokens": 333,
        },
        response_metadata={"usage": {"input_tokens": 999}},
    )

    assert _extract_model_input_tokens(output) == 321


def test_extract_model_input_tokens_falls_back_to_response_metadata_usage():
    output = AIMessage(
        content="done", response_metadata={"usage": {"input_tokens": 456}}
    )

    assert _extract_model_input_tokens(output) == 456
