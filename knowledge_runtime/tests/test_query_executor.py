# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for QueryExecutor service."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from knowledge_runtime.services.config_resolver import QueryConfig
from knowledge_runtime.services.query_executor import QueryExecutor

from shared.models import (
    RemoteKnowledgeBaseRetrievalOverride,
    RemoteQueryRequest,
    RemoteQueryResponse,
    RetrievalScope,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


def _make_query_config(knowledge_base_id: int = 1) -> QueryConfig:
    """Create a sample resolved QueryConfig."""
    return QueryConfig(
        knowledge_base_id=knowledge_base_id,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="test-retriever",
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
def query_request():
    """Create a sample query request (reference mode)."""
    return RemoteQueryRequest(
        knowledge_base_ids=[1, 2],
        user_id=42,
        query="test query",
        max_results=10,
    )


class TestQueryExecutor:
    """Tests for QueryExecutor."""

    @pytest.mark.asyncio
    async def test_execute_uses_planned_backend_query(self, query_request) -> None:
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        with (
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
            query_request.query = "  红包   520 发送   金额 规则 "
            query_request.knowledge_base_ids = [1]
            executor = QueryExecutor(db=MagicMock())
            config = _make_query_config(1)
            executor._config_resolver.resolve_query_config = MagicMock(
                return_value=config
            )

            await executor.execute(query_request)

        mock_kb_executor.execute.assert_awaited_once_with(
            knowledge_id="1",
            query="红包 520 发送 金额 规则",
            query_plan={
                "dense_query": "红包 520 发送 金额 规则",
                "sparse_query": "红包 520 发送 金额 规则",
                "keywords": [],
                "phrases": [],
                "hint_source": "fallback",
            },
            retrieval_config=config.retrieval_config,
            scope=None,
            metadata_condition=None,
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_execute_passes_search_hints_to_knowledge_engine(
        self, query_request
    ) -> None:
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        with (
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
            query_request.search_hints = {
                "semantic_query": "How to verify the release checklist?",
                "keywords": ["release", "checklist"],
                "phrases": ["release checklist"],
            }
            query_request.knowledge_base_ids = [1]
            executor = QueryExecutor(db=MagicMock())
            config = _make_query_config(1)
            executor._config_resolver.resolve_query_config = MagicMock(
                return_value=config
            )

            await executor.execute(query_request)

        mock_kb_executor.execute.assert_awaited_once_with(
            knowledge_id="1",
            query="test query",
            query_plan={
                "dense_query": "How to verify the release checklist?",
                "sparse_query": "release checklist release checklist",
                "keywords": ["release", "checklist"],
                "phrases": ["release checklist"],
                "hint_source": "explicit_hints",
            },
            retrieval_config=config.retrieval_config,
            scope=None,
            metadata_condition=None,
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_execute_converts_compatible_document_ids_to_scope(
        self, query_request
    ) -> None:
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        with (
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
            query_request.knowledge_base_ids = [1]
            query_request.document_ids = [10, 11]
            query_request.metadata_condition = {
                "operator": "and",
                "conditions": [{"key": "source", "operator": "==", "value": "kb"}],
            }
            executor = QueryExecutor(db=MagicMock())
            config = _make_query_config(1)
            executor._config_resolver.resolve_query_config = MagicMock(
                return_value=config
            )

            await executor.execute(query_request)

        mock_kb_executor.execute.assert_awaited_once_with(
            knowledge_id="1",
            query="test query",
            query_plan={
                "dense_query": "test query",
                "sparse_query": "test query",
                "keywords": [],
                "phrases": [],
                "hint_source": "fallback",
            },
            retrieval_config=config.retrieval_config,
            scope=RetrievalScope(document_ids=[10, 11]),
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "source", "operator": "==", "value": "kb"}],
            },
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_execute_keeps_scope_when_compatible_document_ids_match(
        self, query_request
    ) -> None:
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        with (
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
            query_request.knowledge_base_ids = [1]
            query_request.scope = RetrievalScope(document_ids=[20])
            query_request.document_ids = [20]
            executor = QueryExecutor(db=MagicMock())
            config = _make_query_config(1)
            executor._config_resolver.resolve_query_config = MagicMock(
                return_value=config
            )

            await executor.execute(query_request)

        assert mock_kb_executor.execute.await_args.kwargs["scope"] == RetrievalScope(
            document_ids=[20]
        )

    @pytest.mark.asyncio
    async def test_execute_returns_aggregated_results(self, query_request) -> None:
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

        mock_db = MagicMock()
        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)

        with (
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
            executor = QueryExecutor(db=mock_db)
            executor._config_resolver.resolve_query_config = MagicMock(
                side_effect=[config_1, config_2]
            )

            result = await executor.execute(query_request)

        assert isinstance(result, RemoteQueryResponse)
        assert result.total == 2  # 1 from each KB
        assert len(result.records) == 2

    @pytest.mark.asyncio
    async def test_execute_applies_request_retrieval_override(
        self, query_request
    ) -> None:
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        with (
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
            executor = QueryExecutor(db=MagicMock())
            executor._config_resolver.resolve_query_config = MagicMock(
                return_value=_make_query_config(1)
            )
            query_request.knowledge_base_ids = [1]
            query_request.knowledge_base_retrieval_overrides = [
                RemoteKnowledgeBaseRetrievalOverride(
                    knowledge_base_id=1,
                    retrieval_config=RuntimeRetrievalConfig(
                        top_k=9,
                        score_threshold=0.2,
                        retrieval_mode="hybrid",
                        vector_weight=0.8,
                        keyword_weight=0.2,
                    ),
                )
            ]

            await executor.execute(query_request)

        mock_kb_executor.execute.assert_awaited_once_with(
            knowledge_id="1",
            query="test query",
            query_plan={
                "dense_query": "test query",
                "sparse_query": "test query",
                "keywords": [],
                "phrases": [],
                "hint_source": "fallback",
            },
            retrieval_config=RuntimeRetrievalConfig(
                top_k=9,
                score_threshold=0.2,
                retrieval_mode="hybrid",
                vector_weight=0.8,
                keyword_weight=0.2,
            ),
            scope=None,
            metadata_condition=None,
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_execute_rejects_duplicate_retrieval_overrides(
        self, query_request
    ) -> None:
        executor = QueryExecutor(db=MagicMock())
        query_request.knowledge_base_ids = [1]
        query_request.knowledge_base_retrieval_overrides = [
            RemoteKnowledgeBaseRetrievalOverride(
                knowledge_base_id=1,
                retrieval_config=RuntimeRetrievalConfig(top_k=5),
            ),
            RemoteKnowledgeBaseRetrievalOverride(
                knowledge_base_id=1,
                retrieval_config=RuntimeRetrievalConfig(top_k=6),
            ),
        ]

        with pytest.raises(
            ValueError,
            match="duplicate knowledge_base_id",
        ):
            await executor.execute(query_request)

    @pytest.mark.asyncio
    async def test_execute_rejects_unknown_retrieval_override_kb_id(
        self, query_request
    ) -> None:
        executor = QueryExecutor(db=MagicMock())
        query_request.knowledge_base_ids = [1]
        query_request.knowledge_base_retrieval_overrides = [
            RemoteKnowledgeBaseRetrievalOverride(
                knowledge_base_id=999,
                retrieval_config=RuntimeRetrievalConfig(top_k=5),
            )
        ]

        with pytest.raises(
            ValueError,
            match="unknown knowledge_base_id",
        ):
            await executor.execute(query_request)

    @pytest.mark.asyncio
    async def test_execute_sorts_by_score_descending(self, query_request) -> None:
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

        mock_db = MagicMock()
        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)

        with (
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
            executor = QueryExecutor(db=mock_db)
            executor._config_resolver.resolve_query_config = MagicMock(
                side_effect=[config_1, config_2]
            )

            result = await executor.execute(query_request)

        # Should be sorted by score descending
        assert result.records[0].score == 0.95
        assert result.records[1].score == 0.5

    @pytest.mark.asyncio
    async def test_execute_respects_max_results(self, query_request) -> None:
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

        mock_db = MagicMock()
        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)

        with (
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
            executor = QueryExecutor(db=mock_db)
            executor._config_resolver.resolve_query_config = MagicMock(
                side_effect=[config_1, config_2]
            )

            result = await executor.execute(query_request)

        assert len(result.records) == 1
        assert result.total == 4  # Total from all KBs before limiting

    @pytest.mark.asyncio
    async def test_execute_empty_results(self, query_request) -> None:
        """Test handling of empty query results."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()

        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        mock_db = MagicMock()
        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)

        with (
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
            executor = QueryExecutor(db=mock_db)
            executor._config_resolver.resolve_query_config = MagicMock(
                side_effect=[config_1, config_2]
            )

            result = await executor.execute(query_request)

        assert result.total == 0
        assert len(result.records) == 0
        assert result.total_estimated_tokens == 0

    @pytest.mark.asyncio
    async def test_execute_resolves_config_for_each_kb(self, query_request) -> None:
        """Test that ConfigResolver is called for each knowledge_base_id."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()

        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(return_value={"records": []})

        mock_db = MagicMock()
        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)

        with (
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
            executor = QueryExecutor(db=mock_db)
            mock_resolve = MagicMock(side_effect=[config_1, config_2])
            executor._config_resolver.resolve_query_config = mock_resolve

            await executor.execute(query_request)

        # ConfigResolver should be called twice, once for each KB
        assert mock_resolve.call_count == 2
        mock_resolve.assert_any_call(
            db=mock_db,
            knowledge_base_id=1,
            user_id=42,
        )
        mock_resolve.assert_any_call(
            db=mock_db,
            knowledge_base_id=2,
            user_id=42,
        )

    @pytest.mark.asyncio
    async def test_extract_document_id_from_doc_ref(self) -> None:
        """Test document ID extraction from various doc_ref formats."""
        mock_db = MagicMock()
        executor = QueryExecutor(db=mock_db)

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
        mock_db = MagicMock()
        executor = QueryExecutor(db=mock_db)

        # ~4 characters per token
        assert executor._estimate_tokens("test") == 1  # 4 chars
        assert executor._estimate_tokens("test test test test") == 4  # 19 chars
        assert executor._estimate_tokens("") == 0
