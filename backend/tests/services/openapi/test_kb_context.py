# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for KnowledgeBaseContextCreator.
"""

from unittest.mock import MagicMock, call, patch

import pytest

from app.services.openapi.kb_context import (
    KnowledgeBaseContextCreator,
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
        mock_db.commit.assert_called_once()

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
