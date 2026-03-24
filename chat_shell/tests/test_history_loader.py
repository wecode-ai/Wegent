# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from chat_shell.history.loader import (
    _build_knowledge_base_text_prefix,
    _extract_user_text,
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
