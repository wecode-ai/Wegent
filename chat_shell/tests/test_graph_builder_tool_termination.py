# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from langchain_core.messages import AIMessage, ToolMessage

from chat_shell.agents.graph_builder import _has_unexecuted_tool_calls


def test_return_direct_tool_result_is_not_unexecuted() -> None:
    final_message = ToolMessage(
        content="card created",
        tool_call_id="call-1",
        name="create_async_video_card",
    )

    assert not _has_unexecuted_tool_calls(final_message, last_model_end_tool_calls=1)


def test_replaced_tool_call_is_unexecuted() -> None:
    final_message = AIMessage(content="Sorry, need more steps.")

    assert _has_unexecuted_tool_calls(final_message, last_model_end_tool_calls=1)


def test_pending_ai_tool_call_is_unexecuted() -> None:
    final_message = AIMessage(
        content="",
        tool_calls=[
            {
                "id": "call-1",
                "name": "create_async_video_card",
                "args": {},
            }
        ],
    )

    assert _has_unexecuted_tool_calls(final_message, last_model_end_tool_calls=0)
