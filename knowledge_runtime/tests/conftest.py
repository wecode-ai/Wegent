# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pytest configuration for knowledge_runtime tests."""

from unittest.mock import MagicMock

import pytest

from knowledge_runtime.services.config_resolver import ConfigResolver

# ---------------------------------------------------------------------------
# Fixtures for admin/other tests
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_storage_backend():
    """Create a mock storage backend for testing."""
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
    model = MagicMock()
    return model


# ---------------------------------------------------------------------------
# Fixtures for ConfigResolver tests
# ---------------------------------------------------------------------------


@pytest.fixture
def resolver() -> ConfigResolver:
    """Create a ConfigResolver instance."""
    return ConfigResolver()


@pytest.fixture
def mock_db() -> MagicMock:
    """Create a mock database session."""
    return MagicMock()


# ---------------------------------------------------------------------------
# Factory helpers for ConfigResolver tests
# ---------------------------------------------------------------------------

_SENTINEL = object()


def _make_kb_kind(
    knowledge_base_id: int = 1,
    user_id: int = 42,
    retrieval_config: dict | None = None,
) -> MagicMock:
    """Create a mock KnowledgeBase Kind record."""
    if retrieval_config is None:
        retrieval_config = {
            "retriever_name": "test-retriever",
            "retriever_namespace": "default",
            "embedding_config": {
                "model_name": "text-embedding-3-small",
                "model_namespace": "default",
            },
            "top_k": 10,
            "score_threshold": 0.8,
            "retrieval_mode": "vector",
        }
    kb = MagicMock()
    kb.id = knowledge_base_id
    kb.user_id = user_id
    kb.kind = "KnowledgeBase"
    kb.is_active = True
    kb.json = {"spec": {"retrievalConfig": retrieval_config}}
    return kb


def _make_retriever_kind(
    name: str = "test-retriever",
    namespace: str = "default",
    storage_config: dict | None = None,
) -> MagicMock:
    """Create a mock Retriever Kind record."""
    if storage_config is None:
        storage_config = {
            "type": "qdrant",
            "url": "http://localhost:6333",
            "username": "admin",
            "password": "encrypted_password",
            "apiKey": "encrypted_api_key",
            "indexStrategy": {"mode": "per_dataset"},
            "ext": {},
        }
    retriever = MagicMock()
    retriever.name = name
    retriever.namespace = namespace
    retriever.kind = "Retriever"
    retriever.json = {"spec": {"storageConfig": storage_config}}
    return retriever


def _make_model_kind(
    model_name: str = "text-embedding-3-small",
    model_namespace: str = "default",
    spec: dict | None = None,
) -> MagicMock:
    """Create a mock Model Kind record."""
    if spec is None:
        spec = {
            "protocol": "openai",
            "modelConfig": {
                "env": {
                    "api_key": "sk-encrypted-key",
                    "base_url": "https://api.openai.com/v1",
                    "model_id": "text-embedding-3-small",
                    "custom_headers": {},
                },
            },
            "embeddingConfig": {"dimensions": 1536},
        }
    model = MagicMock()
    model.name = model_name
    model.namespace = model_namespace
    model.kind = "Model"
    model.json = {"spec": spec}
    return model


def _make_document(
    document_id: int = 100, splitter_config: dict | None = _SENTINEL
) -> MagicMock:
    """Create a mock KnowledgeDocument record."""
    doc = MagicMock()
    doc.id = document_id
    if splitter_config is _SENTINEL:
        splitter_config = {"chunk_size": 512}
    doc.splitter_config = splitter_config
    return doc


def _make_user(user_id: int = 42, user_name: str = "testuser") -> MagicMock:
    """Create a mock User record."""
    user = MagicMock()
    user.id = user_id
    user.user_name = user_name
    return user
