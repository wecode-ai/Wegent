# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pytest configuration for knowledge_runtime tests."""

from collections.abc import Iterator
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from knowledge_runtime.services.config_resolver import ConfigResolver
from shared.models.db import Kind, User
from shared.testing import capability_reference_database

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


_SHARED_KB_RETRIEVAL_CONFIG = {
    "retriever_name": "test-retriever",
    "retriever_namespace": "default",
    "embedding_config": {
        "model_name": "shared-embedding",
        "model_namespace": "search-team",
    },
}
_SHARED_RETRIEVER_SPEC = {
    "storageConfig": {
        "type": "qdrant",
        "url": "http://qdrant:6333",
    }
}
_SHARED_EMBEDDING_SPEC = {
    "protocol": "openai",
    "modelConfig": {
        "env": {
            "base_url": "http://embedding:8000/v1",
            "model_id": "provider-embedding-id",
        }
    },
    "embeddingConfig": {"dimensions": 1024},
}


def _persisted_kind(
    *,
    kind_id: int,
    user_id: int,
    kind: str,
    name: str,
    namespace: str,
    spec: dict,
) -> Kind:
    return Kind(
        id=kind_id,
        user_id=user_id,
        kind=kind,
        name=name,
        namespace=namespace,
        is_active=True,
        json={"spec": spec},
    )


def _shared_model_kinds() -> list[Kind]:
    return [
        _persisted_kind(
            kind_id=1,
            user_id=42,
            kind="KnowledgeBase",
            name="team-kb",
            namespace="search-team",
            spec={"retrievalConfig": _SHARED_KB_RETRIEVAL_CONFIG},
        ),
        _persisted_kind(
            kind_id=2,
            user_id=42,
            kind="Retriever",
            name="test-retriever",
            namespace="default",
            spec=_SHARED_RETRIEVER_SPEC,
        ),
        _persisted_kind(
            kind_id=3,
            user_id=77,
            kind="Model",
            name="shared-embedding",
            namespace="default",
            spec=_SHARED_EMBEDDING_SPEC,
        ),
    ]


@pytest.fixture
def shared_model_db() -> Iterator[Session]:
    """Create a KB whose embedding Model is referenced into its group."""
    with capability_reference_database(additional_tables=(User.__table__,)) as database:
        database.session.add(User(id=42, user_name="kb-owner", password_hash="unused"))
        database.session.add_all(_shared_model_kinds())
        database.session.execute(
            database.namespace.insert().values(
                id=7,
                name="search-team",
                is_active=True,
            )
        )
        database.session.execute(
            database.resource_members.insert().values(
                id=1,
                resource_type="Model",
                resource_id=3,
                entity_type="namespace",
                entity_id="7",
                status="approved",
            )
        )
        database.session.commit()
        yield database.session


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
