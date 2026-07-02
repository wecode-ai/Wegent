# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for short-lived runtime config loading."""

from unittest.mock import MagicMock

import pytest
from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.config_resolver import (
    AdminResolvedConfig,
    ConfigResolutionError,
    IndexConfig,
    QueryConfig,
)

from shared.models import (
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


def _make_retriever_config() -> RuntimeRetrieverConfig:
    return RuntimeRetrieverConfig(
        name="test-retriever",
        namespace="default",
        storage_config={"type": "qdrant", "url": "http://localhost:6333"},
    )


def _make_embedding_model_config() -> RuntimeEmbeddingModelConfig:
    return RuntimeEmbeddingModelConfig(
        model_name="text-embedding-3-small",
        model_namespace="default",
        resolved_config={"protocol": "openai", "api_key": "test-key"},
    )


def _make_query_config(knowledge_base_id: int) -> QueryConfig:
    return QueryConfig(
        knowledge_base_id=knowledge_base_id,
        index_owner_user_id=7,
        retriever_config=_make_retriever_config(),
        embedding_model_config=_make_embedding_model_config(),
        retrieval_config=RuntimeRetrievalConfig(top_k=5, score_threshold=0.7),
    )


def test_resolve_index_config_closes_session_after_success() -> None:
    session = MagicMock()
    session_factory = MagicMock(return_value=session)
    resolver = MagicMock()
    expected_config = IndexConfig(
        index_owner_user_id=7,
        retriever_config=_make_retriever_config(),
        embedding_model_config=_make_embedding_model_config(),
    )
    resolver.resolve_index_config.return_value = expected_config

    loader = RuntimeConfigLoader(session_factory=session_factory, resolver=resolver)

    result = loader.resolve_index_config(
        knowledge_base_id=1,
        user_id=42,
        document_id=100,
    )

    assert result is expected_config
    session_factory.assert_called_once_with()
    resolver.resolve_index_config.assert_called_once_with(
        db=session,
        knowledge_base_id=1,
        user_id=42,
        document_id=100,
    )
    session.rollback.assert_called_once_with()
    session.close.assert_called_once_with()


def test_resolve_index_config_closes_session_after_error() -> None:
    session = MagicMock()
    session_factory = MagicMock(return_value=session)
    resolver = MagicMock()
    resolver.resolve_index_config.side_effect = ConfigResolutionError(
        "config_not_found",
        "Knowledge base 1 not found",
    )
    loader = RuntimeConfigLoader(session_factory=session_factory, resolver=resolver)

    with pytest.raises(ConfigResolutionError):
        loader.resolve_index_config(
            knowledge_base_id=1,
            user_id=42,
            document_id=None,
        )

    session.rollback.assert_called_once_with()
    session.close.assert_called_once_with()


def test_resolve_query_configs_uses_one_short_session() -> None:
    session = MagicMock()
    session_factory = MagicMock(return_value=session)
    resolver = MagicMock()
    config_1 = _make_query_config(1)
    config_2 = _make_query_config(2)
    resolver.resolve_query_config.side_effect = [config_1, config_2]
    loader = RuntimeConfigLoader(session_factory=session_factory, resolver=resolver)

    result = loader.resolve_query_configs(
        knowledge_base_ids=[1, 2],
        user_id=42,
    )

    assert result == {1: config_1, 2: config_2}
    session_factory.assert_called_once_with()
    assert resolver.resolve_query_config.call_count == 2
    resolver.resolve_query_config.assert_any_call(
        db=session,
        knowledge_base_id=1,
        user_id=42,
    )
    resolver.resolve_query_config.assert_any_call(
        db=session,
        knowledge_base_id=2,
        user_id=42,
    )
    session.rollback.assert_called_once_with()
    session.close.assert_called_once_with()


def test_resolve_admin_config_closes_session_after_success() -> None:
    session = MagicMock()
    session_factory = MagicMock(return_value=session)
    resolver = MagicMock()
    expected_config = AdminResolvedConfig(
        index_owner_user_id=7,
        retriever_config=_make_retriever_config(),
    )
    resolver.resolve_admin_config.return_value = expected_config
    loader = RuntimeConfigLoader(session_factory=session_factory, resolver=resolver)

    result = loader.resolve_admin_config(knowledge_base_id=1)

    assert result is expected_config
    resolver.resolve_admin_config.assert_called_once_with(
        db=session,
        knowledge_base_id=1,
    )
    session.rollback.assert_called_once_with()
    session.close.assert_called_once_with()
