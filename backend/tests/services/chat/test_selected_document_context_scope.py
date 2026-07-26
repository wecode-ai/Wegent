# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.chat.preprocessing.contexts import (
    _prepare_contexts_for_creation,
    _resolve_usable_selected_document_ids,
    prepare_contexts_for_chat,
)
from shared.models.knowledge import KnowledgeBaseScope, KnowledgeBaseToolsResult


def _db_with_document_ids(document_ids: list[int]) -> MagicMock:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = [
        (document_id,) for document_id in document_ids
    ]
    return db


def _allow_knowledge_base_access():
    return patch(
        "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
        return_value=(SimpleNamespace(id=12), True),
    )


def test_selected_documents_accept_one_usable_knowledge_base_scope():
    db = _db_with_document_ids([101, 102])

    with _allow_knowledge_base_access():
        result = _resolve_usable_selected_document_ids(
            db,
            user_id=7,
            knowledge_base_id=12,
            document_ids=[101, 102],
        )

    assert result == [101, 102]


def test_selected_documents_reject_inaccessible_knowledge_base():
    db = MagicMock()

    with (
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
            return_value=(None, False),
        ),
        pytest.raises(HTTPException) as exc_info,
    ):
        _resolve_usable_selected_document_ids(
            db,
            user_id=7,
            knowledge_base_id=12,
            document_ids=[101],
        )

    assert exc_info.value.status_code == 404
    db.query.assert_not_called()


def test_selected_documents_reject_ids_outside_the_usable_scope():
    db = _db_with_document_ids([101])

    with (
        _allow_knowledge_base_access(),
        pytest.raises(HTTPException, match="must belong to the knowledge base"),
    ):
        _resolve_usable_selected_document_ids(
            db,
            user_id=7,
            knowledge_base_id=12,
            document_ids=[101, 999],
        )


def test_selected_documents_reject_duplicate_ids():
    db = MagicMock()

    with (
        _allow_knowledge_base_access(),
        pytest.raises(HTTPException, match="must be unique positive integers"),
    ):
        _resolve_usable_selected_document_ids(
            db,
            user_id=7,
            knowledge_base_id=12,
            document_ids=[101, 101],
        )

    db.query.assert_not_called()


def test_selected_document_context_is_validated_before_creation():
    db = _db_with_document_ids([101])
    context = SimpleNamespace(
        type="selected_documents",
        data={"knowledge_base_id": 12, "document_ids": [101, 999]},
    )

    with (
        _allow_knowledge_base_access(),
        pytest.raises(HTTPException, match="must belong to the knowledge base"),
    ):
        _prepare_contexts_for_creation(
            contexts=[context],
            subtask_id=21,
            user_id=7,
            db=db,
        )


@pytest.mark.asyncio
async def test_selected_documents_replace_whole_kb_scope_in_runtime_request():
    selected_context = SimpleNamespace(
        context_type="selected_documents",
        status="ready",
        type_data={"knowledge_base_id": 12, "document_ids": [101]},
    )
    kb_result = KnowledgeBaseToolsResult(
        extra_tools=[],
        enhanced_system_prompt="system",
        kb_meta_prompt="",
        knowledge_base_ids=[12],
        knowledge_base_scopes=[KnowledgeBaseScope(knowledge_base_id=12)],
    )

    with (
        patch(
            "app.services.chat.preprocessing.contexts.context_service.get_by_subtask",
            return_value=[selected_context],
        ),
        patch(
            "app.services.chat.preprocessing.contexts._process_attachment_contexts_for_message",
            new=AsyncMock(return_value="prompt"),
        ),
        patch(
            "app.services.chat.preprocessing.contexts._prepare_kb_tools_from_contexts",
            return_value=kb_result,
        ),
        patch(
            "app.services.chat.preprocessing.selected_documents.process_selected_documents_contexts",
            return_value=("prompt", "system", []),
        ),
    ):
        result = await prepare_contexts_for_chat(
            db=MagicMock(),
            user_subtask_id=21,
            user_id=7,
            message="prompt",
            base_system_prompt="system",
            task_id=31,
        )

    assert result.kb.document_ids == [101]
    assert result.kb.knowledge_base_scopes == []
