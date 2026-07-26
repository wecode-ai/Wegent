# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock

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


def test_selected_documents_accept_one_usable_knowledge_base_scope():
    db = _db_with_document_ids([101, 102])

    result = _resolve_usable_selected_document_ids(
        db,
        knowledge_base_id=12,
        document_ids=[101, 102],
    )

    assert result == [101, 102]


def test_selected_documents_reject_ids_outside_the_usable_scope():
    db = _db_with_document_ids([101])

    with pytest.raises(HTTPException, match="must belong to the knowledge base"):
        _resolve_usable_selected_document_ids(
            db,
            knowledge_base_id=12,
            document_ids=[101, 999],
        )


def test_selected_documents_reject_duplicate_ids():
    db = MagicMock()

    with pytest.raises(HTTPException, match="must be unique positive integers"):
        _resolve_usable_selected_document_ids(
            db,
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

    with pytest.raises(HTTPException, match="must belong to the knowledge base"):
        _prepare_contexts_for_creation(
            contexts=[context],
            subtask_id=21,
            user_id=7,
            db=db,
        )
