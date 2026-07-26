# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.chat.preprocessing.contexts import (
    _prepare_contexts_for_creation,
    _resolve_usable_selected_document_ids,
)


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
