# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for KnowledgeFolderService.resolve_document_ids_for_scope guards.

Regression coverage for folder-only scoped knowledge base bindings: a scope
that selects folders but no explicit documents must resolve without raising
``document_ids must not be empty``.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.knowledge.folder_service import KnowledgeFolderService


def _db_returning_document_ids(document_ids):
    """Build a mock session whose document query yields ``document_ids``."""
    db = MagicMock()
    query = db.query.return_value
    query.filter.return_value.order_by.return_value.all.return_value = [
        (doc_id,) for doc_id in document_ids
    ]
    return db


@patch.object(KnowledgeFolderService, "_check_kb_access")
def test_folder_only_scope_resolves_without_document_guard(_mock_access):
    """folder_ids set + document_ids=None resolves via the folder documents."""
    db = _db_returning_document_ids([11, 12])

    resolved = KnowledgeFolderService.resolve_document_ids_for_scope(
        db,
        knowledge_base_id=107,
        user_id=1,
        folder_ids=[0],  # root sentinel avoids folder-existence lookups
        document_ids=None,
    )

    assert resolved == [11, 12]


@patch.object(KnowledgeFolderService, "_check_kb_access")
def test_folder_only_scope_with_empty_folder_returns_empty(_mock_access):
    """An empty folder resolves to [] rather than raising."""
    db = _db_returning_document_ids([])

    resolved = KnowledgeFolderService.resolve_document_ids_for_scope(
        db,
        knowledge_base_id=107,
        user_id=1,
        folder_ids=[0],
        document_ids=None,
    )

    assert resolved == []


@patch.object(KnowledgeFolderService, "_check_kb_access")
def test_scope_without_any_selection_is_rejected(_mock_access):
    """A scope that selects neither folders nor documents is invalid."""
    db = MagicMock()

    with pytest.raises(ValueError, match="at least one folder or document"):
        KnowledgeFolderService.resolve_document_ids_for_scope(
            db,
            knowledge_base_id=107,
            user_id=1,
            folder_ids=None,
            document_ids=None,
        )
