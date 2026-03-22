# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from chat_shell.history.loader import _build_knowledge_base_text_prefix


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
