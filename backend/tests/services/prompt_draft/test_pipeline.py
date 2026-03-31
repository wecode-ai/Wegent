# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.prompt_draft.pipeline import build_generation_messages


def test_build_generation_messages_for_initial_generation_uses_conversation_material():
    messages = build_generation_messages(
        conversation_blocks=[("user", "用户原始需求"), ("assistant", "历史回复")]
    )

    assert len(messages) == 2
    assert messages[0]["role"] == "user"
    assert "<conversation>" in messages[0]["content"]
    assert "用户原始需求" in messages[0]["content"]
    assert messages[1]["role"] == "user"
    assert "只输出最终 prompt 正文" in messages[1]["content"]


def test_build_generation_messages_for_regenerate_appends_current_prompt_and_feedback():
    messages = build_generation_messages(
        conversation_blocks=[("user", "用户原始需求"), ("assistant", "历史回复")],
        current_prompt="你是产品协作助手，负责沉淀协作规范。",
        regenerate=True,
    )

    assert messages[-2] == {
        "role": "assistant",
        "content": "你是产品协作助手，负责沉淀协作规范。",
    }
    assert messages[-1]["role"] == "user"
    assert "我对当前方案不满意" in messages[-1]["content"]
    assert "重新编写一个更好的 prompt" in messages[-1]["content"]
