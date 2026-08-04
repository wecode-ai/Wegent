# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for KnowledgeBaseContextCreator.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.openapi.kb_context import (
    KnowledgeBaseContextCreator,
    get_task_knowledge_base_scope_refs,
)
from app.services.openapi.kb_resolver import ResolvedKnowledgeBase


class TestKnowledgeBaseContextCreator:
    """Test cases for KnowledgeBaseContextCreator."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        db = MagicMock()
        db.add_all = MagicMock()
        db.commit = MagicMock()
        db.refresh = MagicMock()
        return db

    @pytest.fixture
    def mock_resolver(self):
        """Create a mock KnowledgeBaseNameResolver."""
        with patch(
            "app.services.openapi.kb_context.KnowledgeBaseNameResolver"
        ) as mock_resolver_class:
            mock_resolver = MagicMock()
            mock_resolver_class.return_value = mock_resolver
            yield mock_resolver

    @pytest.fixture
    def mock_context_class(self):
        """Mock SubtaskContext class."""
        with patch("app.services.openapi.kb_context.SubtaskContext") as mock_ctx:
            yield mock_ctx

    @pytest.fixture
    def creator(self, mock_db, mock_resolver):
        """Create a KnowledgeBaseContextCreator instance."""
        return KnowledgeBaseContextCreator(mock_db, user_id=1)

    def test_create_contexts_success(
        self, creator, mock_resolver, mock_db, mock_context_class
    ):
        """Test creating contexts for resolved knowledge bases."""
        # Arrange
        resolved_kb = ResolvedKnowledgeBase(
            kb_id=123, namespace="default", name="my_kb", display_name="My KB"
        )
        mock_resolution_result = MagicMock()
        mock_resolution_result.resolved = [resolved_kb]
        mock_resolution_result.not_found = []
        mock_resolution_result.no_access = []
        mock_resolver.resolve.return_value = mock_resolution_result

        # Mock context instance
        mock_context = MagicMock()
        mock_context_class.return_value = mock_context

        kb_names = [{"namespace": "default", "name": "my_kb"}]

        # Act
        contexts = creator.create_contexts(subtask_id=456, kb_names=kb_names)

        # Assert
        assert len(contexts) == 1
        mock_context_class.assert_called_once()
        mock_db.add_all.assert_called_once()
        mock_db.flush.assert_called_once()
        mock_db.commit.assert_not_called()

    def test_create_contexts_empty_list(self, creator):
        """Test creating contexts with empty KB names list."""
        # Act
        contexts = creator.create_contexts(subtask_id=456, kb_names=[])

        # Assert
        assert len(contexts) == 0

    def test_create_contexts_no_resolution(self, creator, mock_resolver):
        """Test creating contexts when no KBs are resolved."""
        # Arrange
        mock_resolution_result = MagicMock()
        mock_resolution_result.resolved = []
        mock_resolution_result.not_found = [{"namespace": "default", "name": "missing"}]
        mock_resolution_result.no_access = []
        mock_resolver.resolve.return_value = mock_resolution_result

        kb_names = [{"namespace": "default", "name": "missing"}]

        # Act
        contexts = creator.create_contexts(subtask_id=456, kb_names=kb_names)

        # Assert
        assert len(contexts) == 0

    def test_create_contexts_multiple_kbs(
        self, creator, mock_resolver, mock_db, mock_context_class
    ):
        """Test creating contexts for multiple knowledge bases."""
        # Arrange
        resolved_kbs = [
            ResolvedKnowledgeBase(1, "default", "kb1", "KB 1"),
            ResolvedKnowledgeBase(2, "org", "kb2", "KB 2"),
        ]
        mock_resolution_result = MagicMock()
        mock_resolution_result.resolved = resolved_kbs
        mock_resolution_result.not_found = []
        mock_resolution_result.no_access = []
        mock_resolver.resolve.return_value = mock_resolution_result

        # Mock context instances
        mock_contexts = [MagicMock(), MagicMock()]
        mock_context_class.side_effect = mock_contexts

        kb_names = [
            {"namespace": "default", "name": "kb1"},
            {"namespace": "org", "name": "kb2"},
        ]

        # Act
        contexts = creator.create_contexts(subtask_id=789, kb_names=kb_names)

        # Assert
        assert len(contexts) == 2
        assert mock_context_class.call_count == 2
        mock_db.add_all.assert_called_once()

    def test_create_contexts_upserts_selection_to_task(
        self,
        creator,
        mock_resolver,
        mock_db,
        mock_context_class,
    ):
        """OpenAPI selections use the shared Task binding service."""
        resolved_kb = ResolvedKnowledgeBase(
            kb_id=123, namespace="default", name="my_kb", display_name="My KB"
        )
        mock_resolution_result = MagicMock()
        mock_resolution_result.resolved = [resolved_kb]
        mock_resolution_result.not_found = []
        mock_resolution_result.no_access = []
        mock_resolver.resolve.return_value = mock_resolution_result

        mock_context = MagicMock()
        mock_context.type_data = {"knowledge_id": 123}
        mock_context_class.return_value = mock_context
        task = MagicMock(id=71)
        with patch(
            "app.services.chat.task_knowledge_binding_service."
            "upsert_message_knowledge_bindings",
            return_value=task,
        ) as upsert_bindings:
            creator.create_contexts(
                subtask_id=789,
                kb_names=[{"namespace": "default", "name": "my_kb"}],
                task=task,
            )

        mock_db.flush.assert_called_once()
        mock_db.commit.assert_not_called()
        upsert_bindings.assert_called_once_with(
            mock_db,
            task,
            [mock_context],
            [],
            1,
        )

    def test_create_contexts_scoped_kb_stores_scope_on_context_only(
        self,
        creator,
        mock_resolver,
        mock_context_class,
    ):
        """Scoped KBs should not be promoted to legacy knowledgeBaseRefs."""
        resolved_kb = ResolvedKnowledgeBase(
            kb_id=123,
            namespace="default",
            name="my_kb",
            display_name="My KB",
            scope_restricted=True,
            folder_ids=[9],
            explicit_document_ids=[101],
            include_subfolders=False,
            resolved_document_ids=[101, 102],
        )
        mock_resolution_result = MagicMock()
        mock_resolution_result.resolved = [resolved_kb]
        mock_resolution_result.not_found = []
        mock_resolution_result.no_access = []
        mock_resolver.resolve.return_value = mock_resolution_result

        mock_context = MagicMock()
        mock_context_class.return_value = mock_context
        creator.create_contexts(
            subtask_id=789,
            kb_names=[
                {
                    "namespace": "default",
                    "name": "my_kb",
                    "folder_ids": [9],
                    "document_ids": [101],
                    "include_subfolders": False,
                    "scope_specified": True,
                }
            ],
        )

        call_kwargs = mock_context_class.call_args.kwargs
        assert call_kwargs["type_data"]["scope_restricted"] is True
        assert call_kwargs["type_data"]["document_ids"] == [101, 102]

    def test_create_kb_context_private_method(self, creator, mock_context_class):
        """Test the _create_kb_context private method."""
        # Arrange
        kb = ResolvedKnowledgeBase(
            kb_id=999, namespace="default", name="test_kb", display_name="Test KB"
        )
        mock_context = MagicMock()
        mock_context_class.return_value = mock_context

        # Act
        context = creator._create_kb_context(subtask_id=100, kb=kb)

        # Assert
        assert context == mock_context
        mock_context_class.assert_called_once()
        call_kwargs = mock_context_class.call_args.kwargs
        assert call_kwargs["subtask_id"] == 100
        assert call_kwargs["user_id"] == 1
        assert call_kwargs["name"] == "Test KB"
        assert "knowledge_id" not in call_kwargs
        assert call_kwargs["type_data"]["knowledge_id"] == 999


class TestKnowledgeBaseContextCreatorErrorHandling:
    """Test error handling in KnowledgeBaseContextCreator."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        db = MagicMock()
        db.add_all = MagicMock()
        db.commit = MagicMock()
        db.refresh = MagicMock()
        return db

    @pytest.fixture
    def mock_resolver(self):
        """Create a mock KnowledgeBaseNameResolver."""
        with patch(
            "app.services.openapi.kb_context.KnowledgeBaseNameResolver"
        ) as mock_resolver_class:
            mock_resolver = MagicMock()
            mock_resolver_class.return_value = mock_resolver
            yield mock_resolver

    def test_resolver_raises_exception(self, mock_db, mock_resolver):
        """Test handling when resolver raises an exception."""
        # Arrange
        from fastapi import HTTPException

        mock_resolver.resolve.side_effect = HTTPException(
            status_code=404, detail="Knowledge base not found"
        )

        creator = KnowledgeBaseContextCreator(mock_db, user_id=1)
        kb_names = [{"namespace": "default", "name": "nonexistent"}]

        # Act & Assert
        with pytest.raises(HTTPException) as exc_info:
            creator.create_contexts(subtask_id=456, kb_names=kb_names)

        assert exc_info.value.status_code == 404


class TestGetTaskKnowledgeBaseScopeRefs:
    """Tests for get_task_knowledge_base_scope_refs merging both Task fields."""

    @staticmethod
    def _make_task(spec: dict) -> MagicMock:
        task = MagicMock()
        task.json = {"spec": spec}
        return task

    def test_legacy_refs_only_scope_is_inherited(self):
        """Old Task data with scoped binding only in knowledgeBaseRefs runs scoped."""
        task = self._make_task(
            {
                "knowledgeBaseRefs": [
                    {
                        "id": 7,
                        "name": "KB",
                        "namespace": "default",
                        "scopeRestricted": True,
                        "explicitDocumentIds": [101, 102],
                        "folderIds": [9],
                        "includeSubfolders": False,
                    }
                ]
            }
        )
        refs = get_task_knowledge_base_scope_refs(task)
        assert len(refs) == 1
        assert refs[0]["id"] == 7
        assert refs[0]["scope_specified"] is True
        assert refs[0]["document_ids"] == [101, 102]
        assert refs[0]["folder_ids"] == [9]
        assert refs[0]["include_subfolders"] is False

    def test_scopes_only_scope_is_inherited(self):
        """New Task data with scoped binding only in knowledgeBaseScopes runs scoped."""
        task = self._make_task(
            {
                "knowledgeBaseScopes": [
                    {
                        "id": 8,
                        "name": "KB",
                        "namespace": "default",
                        "scopeRestricted": True,
                        "explicitDocumentIds": [201],
                    }
                ]
            }
        )
        refs = get_task_knowledge_base_scope_refs(task)
        assert len(refs) == 1
        assert refs[0]["id"] == 8
        assert refs[0]["scope_specified"] is True
        assert refs[0]["document_ids"] == [201]

    def test_both_fields_scope_is_merged(self):
        """Scoped bindings in both fields are deduplicated by stable ID."""
        task = self._make_task(
            {
                "knowledgeBaseScopes": [
                    {
                        "id": 9,
                        "name": "KB",
                        "namespace": "default",
                        "scopeRestricted": True,
                        "explicitDocumentIds": [301],
                    }
                ],
                "knowledgeBaseRefs": [
                    {
                        "id": 9,
                        "name": "KB",
                        "namespace": "default",
                        "scopeRestricted": True,
                        "explicitDocumentIds": [302],
                    }
                ],
            }
        )
        refs = get_task_knowledge_base_scope_refs(task)
        assert len(refs) == 1
        assert refs[0]["id"] == 9
        assert refs[0]["scope_specified"] is True

    def test_whole_binding_wins_over_scope(self):
        """An explicit whole binding overrides a scoped binding for the same KB."""
        task = self._make_task(
            {
                "knowledgeBaseScopes": [
                    {
                        "id": 10,
                        "name": "KB",
                        "namespace": "default",
                        "scopeRestricted": True,
                        "explicitDocumentIds": [401],
                    }
                ],
                "knowledgeBaseRefs": [
                    {
                        "id": 10,
                        "name": "KB",
                        "namespace": "default",
                    }
                ],
            }
        )
        refs = get_task_knowledge_base_scope_refs(task)
        assert len(refs) == 1
        assert refs[0]["id"] == 10
        assert refs[0]["scope_specified"] is False
        assert refs[0]["document_ids"] == []

    def test_unbind_clears_both_fields(self):
        """After unbinding, neither field contributes scope refs."""
        task = self._make_task(
            {
                "knowledgeBaseScopes": [],
                "knowledgeBaseRefs": [],
            }
        )
        refs = get_task_knowledge_base_scope_refs(task)
        assert refs == []

    def test_legacy_snake_case_scope_fields(self):
        """Refs using snake_case scope fields are recognized."""
        task = self._make_task(
            {
                "knowledgeBaseRefs": [
                    {
                        "id": 11,
                        "name": "KB",
                        "namespace": "default",
                        "scope_restricted": True,
                        "document_ids": [501],
                        "folder_ids": [99],
                        "include_subfolders": True,
                    }
                ]
            }
        )
        refs = get_task_knowledge_base_scope_refs(task)
        assert len(refs) == 1
        assert refs[0]["scope_specified"] is True
        assert refs[0]["document_ids"] == [501]
        assert refs[0]["folder_ids"] == [99]
