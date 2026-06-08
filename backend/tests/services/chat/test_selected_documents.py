# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for notebook selected document context injection."""

from unittest.mock import MagicMock, patch

import pytest


@pytest.mark.unit
class TestSelectedDocumentsContext:
    def test_selected_documents_direct_injection_keeps_full_content_when_attachment_preview_is_small(
        self, monkeypatch
    ):
        """Notebook selected documents should not use large attachment prompt previews."""
        from app.services.chat.preprocessing.selected_documents import (
            process_selected_documents_contexts,
        )
        from app.services.context.context_service import settings

        monkeypatch.setattr(settings, "LARGE_ATTACHMENT_PREVIEW_THRESHOLD", 20)
        monkeypatch.setattr(settings, "LARGE_ATTACHMENT_PREVIEW_LENGTH", 5)

        long_content = "A" * 30 + "FULL_DOCUMENT_TAIL"
        selected_context = MagicMock(
            type_data={"knowledge_base_id": 101, "document_ids": [501]}
        )

        with (
            patch(
                "app.services.chat.preprocessing.selected_documents."
                "_check_user_kb_access_for_selected_docs",
                return_value=(True, ""),
            ),
            patch(
                "app.services.chat.preprocessing.selected_documents."
                "_load_documents_content",
                return_value=[
                    {
                        "id": 501,
                        "name": "notebook.md",
                        "content": long_content,
                        "file_extension": ".md",
                    }
                ],
            ),
        ):
            final_message, system_prompt, extra_tools = (
                process_selected_documents_contexts(
                    db=MagicMock(),
                    selected_docs_contexts=[selected_context],
                    user_id=1,
                    message="Summarize it",
                    base_system_prompt="base system",
                    extra_tools=[],
                    context_window=128000,
                )
            )

        assert system_prompt == "base system"
        assert extra_tools == []
        assert isinstance(final_message, list)
        selected_docs_block = final_message[0]["text"]
        assert "<selected_documents>" in selected_docs_block
        assert "notebook.md" in selected_docs_block
        assert "FULL_DOCUMENT_TAIL" in selected_docs_block
        assert "Content preview" not in selected_docs_block
        assert final_message[-1]["text"] == "Summarize it"
