# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for shared_task service prompt sanitization.

Verifies that system-injected metadata blocks (<system-reminder>) stored in
Subtask.prompt are stripped before being returned via the public shared-task
API endpoint (get_public_shared_task).
"""

import json
from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session

from shared.prompts.constants import parse_prompt_blocks


class TestParsePromptBlocksForPublicShare:
    """
    Pure-unit tests for parse_prompt_blocks — the function used by
    get_public_shared_task to sanitize prompt values before returning them
    to unauthenticated viewers.
    """

    def test_plain_text_returned_unchanged(self):
        """Plain text prompts pass through parse_prompt_blocks unchanged."""
        text = "What is the meaning of life?"
        result, extra = parse_prompt_blocks(text)
        assert result == text
        assert extra == []

    def test_empty_string_returns_empty(self):
        """Empty string is handled gracefully."""
        result, extra = parse_prompt_blocks("")
        assert result == ""
        assert extra == []

    def test_json_array_extracts_first_text_block(self):
        """JSON array with system-reminder returns only the user text."""
        raw = json.dumps(
            [
                {"type": "text", "text": "Show me the project structure"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-01-01</CurrentTime></system-reminder>",
                },
            ]
        )
        result, extra = parse_prompt_blocks(raw)
        assert result == "Show me the project structure"
        assert len(extra) > 0  # system-reminder was extracted as extra

    def test_json_array_multiple_system_blocks(self):
        """Multiple system-reminder blocks are all captured in extra."""
        raw = json.dumps(
            [
                {"type": "text", "text": "Explain this code"},
                {
                    "type": "text",
                    "text": "<system-reminder><Attachment>main.py</Attachment></system-reminder>",
                },
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-06-01</CurrentTime></system-reminder>",
                },
            ]
        )
        result, extra = parse_prompt_blocks(raw)
        assert result == "Explain this code"
        assert len(extra) == 2

    def test_clean_prompt_used_in_public_subtask_data(self):
        """
        Simulate the get_public_shared_task logic:
        clean_prompt, _ = parse_prompt_blocks(sub.prompt or "")
        PublicSubtaskData(prompt=clean_prompt, ...)

        The resulting prompt field must not contain any system-reminder content.
        """
        from app.schemas.shared_task import PublicSubtaskData

        raw_prompt = json.dumps(
            [
                {"type": "text", "text": "Review the codebase"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-01-01</CurrentTime></system-reminder>",
                },
            ]
        )

        clean_prompt, _ = parse_prompt_blocks(raw_prompt or "")
        subtask_data = PublicSubtaskData(
            id=1,
            role="USER",
            prompt=clean_prompt,
            status="COMPLETED",
            created_at=datetime(2025, 1, 1),
            updated_at=datetime(2025, 1, 1),
        )

        assert subtask_data.prompt == "Review the codebase"
        assert "<system-reminder>" not in subtask_data.prompt
        assert "CurrentTime" not in subtask_data.prompt

    def test_none_like_empty_string_for_missing_prompt(self):
        """sub.prompt or '' pattern: None equivalent (empty string) handled cleanly."""
        result, extra = parse_prompt_blocks("")
        assert result == ""
        assert extra == []


class TestPublicSharedTaskContexts:
    """Public shared tasks must not expose knowledge base runtime metadata."""

    def test_keeps_attachments_and_filters_knowledge_base_contexts(
        self,
        test_db: Session,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services import shared_task as shared_task_module

        task = SimpleNamespace(
            id=200,
            name="Shared task",
            created_at=datetime(2025, 1, 1),
        )
        subtask = SimpleNamespace(
            id=300,
            role="USER",
            prompt="Question",
            result=None,
            status="COMPLETED",
            created_at=datetime(2025, 1, 1),
            updated_at=datetime(2025, 1, 1),
            sender_type=None,
            sender_user_id=None,
            reply_to_subtask_id=None,
        )
        test_db.add_all(
            [
                SubtaskContext(
                    subtask_id=subtask.id,
                    user_id=1,
                    context_type=ContextType.ATTACHMENT.value,
                    name="brief.txt",
                    status=ContextStatus.READY.value,
                    type_data={
                        "file_extension": "txt",
                        "file_size": 7,
                        "mime_type": "text/plain",
                    },
                ),
                SubtaskContext(
                    subtask_id=subtask.id,
                    user_id=1,
                    context_type=ContextType.KNOWLEDGE_BASE.value,
                    name="Private knowledge base",
                    status=ContextStatus.READY.value,
                    type_data={"knowledge_id": 42, "document_count": 3},
                ),
            ]
        )
        test_db.flush()

        service = shared_task_module.shared_task_service
        monkeypatch.setattr(service, "_aes_decrypt", lambda _: "1#200")
        monkeypatch.setattr(
            shared_task_module.task_store,
            "get_task_by_states",
            lambda *args, **kwargs: task,
        )
        monkeypatch.setattr(
            shared_task_module.subtask_store,
            "list_by_task_ordered",
            lambda *args, **kwargs: [subtask],
        )

        response = service.get_public_shared_task(test_db, "share-token")

        assert len(response.subtasks) == 1
        assert len(response.subtasks[0].contexts) == 1
        context = response.subtasks[0].contexts[0]
        assert context.context_type == ContextType.ATTACHMENT.value
        assert context.name == "brief.txt"
        assert "Private knowledge base" not in response.model_dump_json()
