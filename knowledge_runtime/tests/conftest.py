# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pytest configuration for knowledge_runtime tests."""

import pytest


@pytest.fixture
def mock_storage_backend():
    """Create a mock storage backend for testing."""
    from unittest.mock import MagicMock

    backend = MagicMock()
    backend.test_connection.return_value = True
    backend.retrieve.return_value = {"records": []}
    backend.delete_document.return_value = {"status": "success", "deleted_chunks": 0}
    backend.delete_knowledge.return_value = {"status": "success", "deleted_count": 0}
    backend.drop_knowledge_index.return_value = {"status": "success"}
    backend.get_all_chunks.return_value = []
    return backend


@pytest.fixture
def mock_embed_model():
    """Create a mock embedding model for testing."""
    from unittest.mock import MagicMock

    model = MagicMock()
    return model
