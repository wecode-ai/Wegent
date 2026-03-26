# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from chat_shell.history.loader import (
    _build_knowledge_base_text_prefix,
    _extract_user_text,
    _truncate_history,
)


class TestHistoryLoaderRestrictedKnowledgeBase:
    def test_restricted_kb_context_is_not_injected_into_history(self):
        context = SimpleNamespace(
            id=10,
            name="KB",
            knowledge_id=123,
            extracted_text="sensitive text",
            type_data={"rag_result": {"restricted_mode": True}},
        )

        assert _build_knowledge_base_text_prefix(context) == ""


class TestExtractUserText:
    """Tests for _extract_user_text which extracts the user's plain text
    from a content block list, skipping context and system-reminder blocks."""

    def test_extracts_first_non_context_block(self):
        content = [
            {"type": "text", "text": "hello world"},
            {"type": "text", "text": "<attachment>file</attachment>"},
        ]
        assert _extract_user_text(content) == "hello world"

    def test_skips_attachment_block(self):
        content = [
            {"type": "text", "text": "<attachment>file content</attachment>"},
            {"type": "text", "text": "user question"},
        ]
        assert _extract_user_text(content) == "user question"

    def test_skips_knowledge_base_block(self):
        content = [
            {"type": "text", "text": "<knowledge_base>kb content</knowledge_base>"},
            {"type": "text", "text": "user question"},
        ]
        assert _extract_user_text(content) == "user question"

    def test_skips_selected_documents_block(self):
        content = [
            {"type": "text", "text": "<selected_documents>docs</selected_documents>"},
            {"type": "text", "text": "user question"},
        ]
        assert _extract_user_text(content) == "user question"

    def test_skips_system_reminder_block(self):
        content = [
            {"type": "text", "text": "user question"},
            {
                "type": "text",
                "text": "<system-reminder><CurrentTime>now</CurrentTime></system-reminder>",
            },
        ]
        assert _extract_user_text(content) == "user question"

    def test_skips_image_url_blocks(self):
        content = [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
            {"type": "text", "text": "describe this"},
        ]
        assert _extract_user_text(content) == "describe this"

    def test_skips_all_context_types(self):
        content = [
            {"type": "text", "text": "<attachment>file</attachment>"},
            {"type": "text", "text": "<knowledge_base>kb</knowledge_base>"},
            {"type": "text", "text": "<selected_documents>docs</selected_documents>"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
            {
                "type": "text",
                "text": "<system-reminder><CurrentTime>t</CurrentTime></system-reminder>",
            },
            {"type": "text", "text": "the actual question"},
        ]
        assert _extract_user_text(content) == "the actual question"

    def test_returns_none_when_no_user_text(self):
        content = [
            {"type": "text", "text": "<attachment>file</attachment>"},
            {"type": "text", "text": "<system-reminder>time</system-reminder>"},
        ]
        assert _extract_user_text(content) is None

    def test_empty_list(self):
        assert _extract_user_text([]) is None

    def test_user_text_with_group_chat_prefix(self):
        content = [
            {"type": "text", "text": "User[Alice]: hello everyone"},
            {"type": "text", "text": "<attachment>file</attachment>"},
        ]
        assert _extract_user_text(content) == "User[Alice]: hello everyone"


class TestTruncateHistory:
    def test_preserves_tool_call_groups_at_head_and_tail_boundaries(self, monkeypatch):
        monkeypatch.setattr(
            "chat_shell.history.loader.settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES", 2
        )
        monkeypatch.setattr(
            "chat_shell.history.loader.settings.GROUP_CHAT_HISTORY_LAST_MESSAGES", 2
        )

        history = [
            {"role": "user", "content": "User 0"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "search", "arguments": "{}"},
                    }
                ],
            },
            {"role": "tool", "content": "Result 1", "tool_call_id": "call_1"},
            {"role": "assistant", "content": "Assistant 1"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": "{}"},
                    }
                ],
            },
            {"role": "tool", "content": "Result 2", "tool_call_id": "call_2"},
            {"role": "assistant", "content": "Assistant 2"},
        ]

        truncated = _truncate_history(history)

        assert [msg["role"] for msg in truncated] == [
            "user",
            "assistant",
            "tool",
            "assistant",
            "tool",
            "assistant",
        ]
        assert truncated[1]["tool_calls"][0]["id"] == "call_1"
        assert truncated[2]["tool_call_id"] == "call_1"
        assert truncated[3]["tool_calls"][0]["id"] == "call_2"
        assert truncated[4]["tool_call_id"] == "call_2"
