# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for QueryExecutor service using reference mode."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knowledge_runtime.services.query_executor import QueryExecutor
from shared.models import (
    KnowledgeBaseReference,
    RemoteKnowledgeBaseQueryConfig,
    RemoteQueryRequest,
    RemoteQueryResponse,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


@pytest.fixture
def kb_references():
    """Create sample knowledge base references."""
    return [
        KnowledgeBaseReference(knowledge_base_id=1, user_id=7),
        KnowledgeBaseReference(knowledge_base_id=2, user_id=7),
    ]


@pytest.fixture
def resolved_kb_config_1():
    """Create a resolved KB config for KB 1 (returned by resolver)."""
    return RemoteKnowledgeBaseQueryConfig(
        knowledge_base_id=1,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-1",
            namespace="default",
            storage_config={
                "type": "qdrant",
                "url": "http://localhost:6333",
            },
        ),
        embedding_model_config=RuntimeEmbeddingModelConfig(
            model_name="text-embedding-3-small",
            model_namespace="default",
            resolved_config={
                "protocol": "openai",
                "api_key": "test-key",
            },
        ),
        retrieval_config=RuntimeRetrievalConfig(
            top_k=5,
            score_threshold=0.7,
        ),
    )


@pytest.fixture
def resolved_kb_config_2():
    """Create a resolved KB config for KB 2 (returned by resolver)."""
    return RemoteKnowledgeBaseQueryConfig(
        knowledge_base_id=2,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-2",
            namespace="default",
            storage_config={
                "type": "qdrant",
                "url": "http://localhost:6333",
            },
        ),
        embedding_model_config=RuntimeEmbeddingModelConfig(
            model_name="text-embedding-3-small",
            model_namespace="default",
            resolved_config={
                "protocol": "openai",
                "api_key": "test-key",
            },
        ),
        retrieval_config=RuntimeRetrievalConfig(
            top_k=5,
            score_threshold=0.7,
        ),
    )


@pytest.fixture
def query_request(kb_references):
    """Create a sample query request using reference mode."""
    return RemoteQueryRequest(
        knowledge_base_ids=[1, 2],
        query="test query",
        max_results=10,
        knowledge_base_references=kb_references,
        user_id=7,
    )


class TestQueryExecutor:
    """Tests for QueryExecutor using reference mode."""

    @pytest.mark.asyncio
    async def test_execute_returns_aggregated_results(
        self, query_request, resolved_kb_config_1, resolved_kb_config_2
    ) -> None:
        """Test that execute returns aggregated results from all KBs."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()

        # Mock the knowledge engine query executor
        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(
            return_value={
                "records": [
                    {
                        "content": "Result from KB",
                        "title": "Doc1",
                        "score": 0.95,
                        "metadata": {"doc_ref": "doc_100"},
                    }
                ]
            }
        )

        executor = QueryExecutor()

        with (
            patch.object(
                executor._resolver,
                "resolve_knowledge_base_query_config",
                side_effect=[resolved_kb_config_1, resolved_kb_config_2],
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ),
            patch(
                "knowledge_runtime.services.query_executor.KnowledgeQueryExecutor",
                return_value=mock_kb_executor,
            ),
        ):
            result = await executor.execute(query_request)

        assert isinstance(result, RemoteQueryResponse)
        assert result.total == 2  # 1 from each KB
        assert len(result.records) == 2

    @pytest.mark.asyncio
    async def test_execute_sorts_by_score_descending(
        self, query_request, resolved_kb_config_1, resolved_kb_config_2
    ) -> None:
        """Test that results are sorted by score descending."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()

        # Create executor that returns different scores for each KB
        call_count = [0]

        async def mock_execute(**kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return {
                    "records": [{"content": "Low score", "title": "Doc1", "score": 0.5}]
                }
            else:
                return {
                    "records": [
                        {"content": "High score", "title": "Doc2", "score": 0.95}
                    ]
                }

        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = mock_execute

        executor = QueryExecutor()

        with (
            patch.object(
                executor._resolver,
                "resolve_knowledge_base_query_config",
                side_effect=[resolved_kb_config_1, resolved_kb_config_2],
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ),
            patch(
                "knowledge_runtime.services.query_executor.KnowledgeQueryExecutor",
                return_value=mock_kb_executor,
            ),
        ):
            result = await executor.execute(query_request)

        # Should be sorted by score descending
        assert result.records[0].score == 0.95
        assert result.records[1].score == 0.5

    @pytest.mark.asyncio
    async def test_execute_respects_max_results(
        self, query_request, resolved_kb_config_1, resolved_kb_config_2
    ) -> None:
        """Test that max_results limit is respected."""
        query_request.max_results = 1  # Only return top result

        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()

        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(
            return_value={
                "records": [
                    {"content": "Result 1", "title": "Doc1", "score": 0.9},
                    {"content": "Result 2", "title": "Doc2", "score": 0.8},
                ]
            }
        )

        executor = QueryExecutor()

        with (
            patch.object(
                executor._resolver,
                "resolve_knowledge_base_query_config",
                side_effect=[resolved_kb_config_1, resolved_kb_config_2],
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ),
            patch(
                "knowledge_runtime.services.query_executor.KnowledgeQueryExecutor",
                return_value=mock_kb_executor,
            ),
        ):
            result = await executor.execute(query_request)

        assert len(result.records) == 1
        assert result.total == 4  # Total from all KBs before limiting

    @pytest.mark.asyncio
    async def test_execute_empty_results(
        self, query_request, resolved_kb_config_1, resolved_kb_config_2
    ) -> None:
        """Test handling of empty query results."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()

        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        executor = QueryExecutor()

        with (
            patch.object(
                executor._resolver,
                "resolve_knowledge_base_query_config",
                side_effect=[resolved_kb_config_1, resolved_kb_config_2],
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ),
            patch(
                "knowledge_runtime.services.query_executor.KnowledgeQueryExecutor",
                return_value=mock_kb_executor,
            ),
        ):
            result = await executor.execute(query_request)

        assert result.total == 0
        assert len(result.records) == 0
        assert result.total_estimated_tokens == 0

    @pytest.mark.asyncio
    async def test_execute_resolves_references(
        self, query_request, resolved_kb_config_1, resolved_kb_config_2
    ) -> None:
        """Test that executor resolves KB references correctly."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()

        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        executor = QueryExecutor()

        with (
            patch.object(
                executor._resolver,
                "resolve_knowledge_base_query_config",
                side_effect=[resolved_kb_config_1, resolved_kb_config_2],
            ) as mock_resolve,
            patch(
                "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
            patch(
                "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ),
            patch(
                "knowledge_runtime.services.query_executor.KnowledgeQueryExecutor",
                return_value=mock_kb_executor,
            ),
        ):
            await executor.execute(query_request)

        # Verify resolver was called with correct references
        assert mock_resolve.call_count == 2
        mock_resolve.assert_any_call(
            knowledge_base_id=1,
            user_id=7,
            user_name=None,
        )
        mock_resolve.assert_any_call(
            knowledge_base_id=2,
            user_id=7,
            user_name=None,
        )

    @pytest.mark.asyncio
    async def test_extract_document_id_from_doc_ref(self) -> None:
        """Test document ID extraction from various doc_ref formats."""
        executor = QueryExecutor()

        # Test "doc_XXX" format
        assert (
            executor._extract_document_id({"metadata": {"doc_ref": "doc_123"}}) == 123
        )

        # Test numeric string
        assert executor._extract_document_id({"metadata": {"doc_ref": "456"}}) == 456

        # Test invalid format
        assert executor._extract_document_id({"metadata": {"doc_ref": "abc"}}) is None

        # Test missing doc_ref
        assert executor._extract_document_id({"metadata": {}}) is None
        assert executor._extract_document_id({}) is None

    def test_estimate_tokens(self) -> None:
        """Test token estimation heuristic."""
        executor = QueryExecutor()

        # ~4 characters per token
        assert executor._estimate_tokens("test") == 1  # 4 chars
        assert executor._estimate_tokens("test test test test") == 4  # 19 chars
        assert executor._estimate_tokens("") == 0
