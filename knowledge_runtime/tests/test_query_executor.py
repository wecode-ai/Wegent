# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for QueryExecutor service."""

import asyncio
import re
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knowledge_runtime.services.config_resolver import QueryConfig
from knowledge_runtime.services.query_executor import QueryExecutor
from shared.models import (
    RemoteAuthorizedRetrievalResources,
    RemoteKnowledgeBaseRetrievalOverride,
    RemoteQueryRequest,
    RemoteQueryResponse,
    RemoteRetrievalResourceRef,
    RetrievalScope,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from shared.telemetry.context.span import get_request_id, request_context


def _authorized(knowledge_base_id: int) -> RemoteAuthorizedRetrievalResources:
    """Authorize one knowledge base's stored retrieval resources."""
    return RemoteAuthorizedRetrievalResources(
        operation="query",
        knowledge_base_id=knowledge_base_id,
        index_owner_user_id=7,
        retriever=RemoteRetrievalResourceRef(
            kind="Retriever", name="test-retriever", namespace="default"
        ),
        embedding_model=RemoteRetrievalResourceRef(
            kind="Model", name="text-embedding-3-small", namespace="default"
        ),
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


def _make_config_loader(*configs: QueryConfig) -> MagicMock:
    """Create a fake RuntimeConfigLoader returning configs by knowledge base ID."""
    config_loader = MagicMock()
    config_loader.resolve_query_configs.return_value = {
        config.knowledge_base_id: config for config in configs
    }
    return config_loader


@pytest.fixture
def query_request():
    """Create a sample query request (reference mode)."""
    return RemoteQueryRequest(
        knowledge_base_ids=[1, 2],
        user_id=42,
        query="test query",
        max_results=10,
        authorized_resources=[_authorized(1), _authorized(2)],
    )


class TestQueryExecutor:
    """Tests for QueryExecutor."""

    @pytest.mark.asyncio
    async def test_execute_uses_planned_backend_query(
        self, query_request, caplog
    ) -> None:
        caplog.set_level("INFO", logger="knowledge_runtime.services.query_executor")
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
            config = _make_query_config(1)
            config_loader = _make_config_loader(config)
            executor = QueryExecutor(config_loader=config_loader)

            await executor.execute(query_request)

        assert (
            "kb_id=1 top_k=5 score_threshold=0.7 retrieval_mode=vector" in caplog.text
        )
        assert "test-key" not in caplog.text

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
            config = _make_query_config(1)
            config_loader = _make_config_loader(config)
            executor = QueryExecutor(config_loader=config_loader)

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
            config = _make_query_config(1)
            config.scoped_document_ids = [10, 11]
            config_loader = _make_config_loader(config)
            executor = QueryExecutor(config_loader=config_loader)

            await executor.execute(query_request)

        assert config_loader.resolve_query_configs.call_args.kwargs[
            "scope"
        ] == RetrievalScope(document_ids=[10, 11])
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
            config = _make_query_config(1)
            config.scoped_document_ids = [20]
            config_loader = _make_config_loader(config)
            executor = QueryExecutor(config_loader=config_loader)

            await executor.execute(query_request)

        assert config_loader.resolve_query_configs.call_args.kwargs[
            "scope"
        ] == RetrievalScope(document_ids=[20])
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

        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)
        config_loader = _make_config_loader(config_1, config_2)

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
            executor = QueryExecutor(config_loader=config_loader)

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
            config = _make_query_config(1)
            config_loader = _make_config_loader(config)
            executor = QueryExecutor(config_loader=config_loader)
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

        # The override is handed to config resolution, which applies it through
        # the module; the executor executes whatever the resolver returned.
        assert config_loader.resolve_query_configs.call_args.kwargs[
            "retrieval_overrides"
        ] == {
            1: {
                "top_k": 9,
                "score_threshold": 0.2,
                "retrieval_mode": "hybrid",
                "vector_weight": 0.8,
                "keyword_weight": 0.2,
            }
        }
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
            scope=None,
            metadata_condition=None,
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_execute_rejects_duplicate_retrieval_overrides(
        self, query_request
    ) -> None:
        executor = QueryExecutor(config_loader=MagicMock())
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
        executor = QueryExecutor(config_loader=MagicMock())
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
    async def test_execute_rejects_query_without_authorized_resources(
        self, query_request
    ) -> None:
        """Backend must authorize the retrieval resources before the query runs."""
        query_request.authorized_resources = None
        executor = QueryExecutor(config_loader=MagicMock())

        with pytest.raises(ValueError, match="authorized retrieval resources"):
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

        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)
        config_loader = _make_config_loader(config_1, config_2)

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
            executor = QueryExecutor(config_loader=config_loader)

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

        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)
        config_loader = _make_config_loader(config_1, config_2)

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
            executor = QueryExecutor(config_loader=config_loader)

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

        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)
        config_loader = _make_config_loader(config_1, config_2)

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
            executor = QueryExecutor(config_loader=config_loader)

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

        config_1 = _make_query_config(1)
        config_2 = _make_query_config(2)
        config_loader = _make_config_loader(config_1, config_2)

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
            executor = QueryExecutor(config_loader=config_loader)

            await executor.execute(query_request)

        config_loader.resolve_query_configs.assert_called_once_with(
            knowledge_base_ids=[1, 2],
            user_id=42,
            authorized={1: _authorized(1), 2: _authorized(2)},
            retrieval_overrides={},
            scope=None,
        )

    @pytest.mark.asyncio
    async def test_execute_returns_knowledge_base_and_document_reference(
        self, query_request
    ) -> None:
        """A scoped query returns its knowledge base and document reference."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_kb_executor = MagicMock()
        mock_kb_executor.execute = AsyncMock(
            return_value={
                "records": [
                    {
                        "content": "Release checklist",
                        "title": "release-notes",
                        "score": 0.9,
                        "metadata": {"doc_ref": "100"},
                    }
                ]
            }
        )
        config = _make_query_config(1)
        config.scoped_document_ids = [100]
        config_loader = _make_config_loader(config)
        query_request.knowledge_base_ids = [1]
        query_request.scope = RetrievalScope(document_ids=[100])

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
            result = await QueryExecutor(config_loader=config_loader).execute(
                query_request
            )

        assert config_loader.resolve_query_configs.call_args.kwargs[
            "scope"
        ] == RetrievalScope(document_ids=[100])
        assert mock_kb_executor.execute.await_args.kwargs["scope"] == RetrievalScope(
            document_ids=[100]
        )
        assert result.records[0].knowledge_base_id == 1
        assert result.records[0].document_id == 100


@pytest.mark.asyncio
async def test_runtime_generates_distinct_ids_and_propagates_to_worker(mocker, caplog):
    caplog.set_level("INFO")
    caplog.set_level("INFO", logger="knowledge_engine.diagnostics")
    storage = MagicMock()
    storage.retrieve.return_value = {"records": []}
    mocker.patch(
        "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
        return_value=storage,
    )
    mocker.patch(
        "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config"
    )

    async def query(kb_id):
        request = RemoteQueryRequest(
            knowledge_base_ids=[kb_id],
            user_id=42,
            query="fixture",
            authorized_resources=[_authorized(kb_id)],
        )
        executor = QueryExecutor(
            config_loader=_make_config_loader(_make_query_config(kb_id))
        )
        return await executor.execute(request, task_id=17042430385152 + kb_id)

    before = get_request_id()
    results = await asyncio.gather(query(1), query(2))

    assert all(result.records == [] for result in results)
    assert get_request_id() == before
    worker_logs = [m for m in caplog.messages if "stage=worker_queue" in m]
    assert len(worker_logs) == 2
    request_ids = {
        re.search(r"request_id=(\S+)", message).group(1) for message in worker_logs
    }
    assert len(request_ids) == 2
    assert "-" not in request_ids
    for request_id in request_ids:
        logs = [m for m in caplog.messages if f"request_id={request_id} " in m]
        assert not any("event=start" in m for m in logs)
        assert any("stage=query_total event=end" in m for m in logs)
        assert any("stage=config_resolution event=end" in m for m in logs)
        for stage in (
            "embedding_model_init",
            "retrieval_total",
            "storage_retrieve",
            "hierarchical_merge",
        ):
            assert not any(f"stage={stage} " in m for m in logs)
    for kb_id in (1, 2):
        logs = [
            record.getMessage()
            for record in caplog.records
            if record.name == "knowledge_engine.diagnostics"
            and f"kb_id={kb_id} " in record.getMessage()
        ]
        assert logs
        assert all(f"task_id={17042430385152 + kb_id} " in m for m in logs)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_type", [RuntimeError, asyncio.CancelledError])
async def test_runtime_restores_request_context_on_failure(
    failure_type, mocker, caplog
):
    caplog.set_level("INFO", logger="knowledge_engine.diagnostics")
    failure = failure_type("private-provider-response")
    loader = _make_config_loader(_make_query_config())
    loader.resolve_query_configs.side_effect = failure
    request = RemoteQueryRequest(
        knowledge_base_ids=[1],
        user_id=42,
        query="fixture",
        authorized_resources=[_authorized(1)],
    )

    with request_context("caller-request"):
        with pytest.raises(failure_type) as caught:
            await QueryExecutor(config_loader=loader).execute(
                request, task_id=17042430385152
            )
        assert get_request_id() == "caller-request"

    assert caught.value is failure
    assert "request_id=caller-request" in caplog.text
    assert "stage=query_total event=error" in caplog.text
    assert f"error_type={failure_type.__name__}" in caplog.text
    assert "private-provider-response" not in caplog.text
    from knowledge_engine.diagnostics import log_timing

    log_timing("outside", "start")
    assert "task_id=-" in caplog.messages[-1]


@pytest.mark.asyncio
@pytest.mark.parametrize("task_id", [None, 17042430385152])
async def test_query_header_reaches_worker_logs_without_changing_body(
    task_id, mocker, caplog
):
    import httpx
    from fastapi import FastAPI

    from knowledge_runtime.api.endpoints.query import router

    caplog.set_level("INFO", logger="knowledge_engine.diagnostics")
    storage = MagicMock()
    storage.retrieve.return_value = {"records": []}
    mocker.patch(
        "knowledge_runtime.services.query_executor.RuntimeConfigLoader",
        return_value=_make_config_loader(_make_query_config(1)),
    )
    mocker.patch(
        "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
        return_value=storage,
    )
    mocker.patch(
        "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config"
    )
    app = FastAPI()
    app.include_router(router)
    payload = RemoteQueryRequest(
        knowledge_base_ids=[1],
        user_id=42,
        query="fixture",
        authorized_resources=[_authorized(1)],
    ).model_dump(mode="json")
    headers = {} if task_id is None else {"X-Task-ID": str(task_id)}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runtime"
    ) as client:
        response = await client.post("/query", json=payload, headers=headers)

    assert response.status_code == 200
    assert response.json()["records"] == []
    assert storage.retrieve.call_args.kwargs["user_id"] == 7
    assert "task_id" not in storage.retrieve.call_args.kwargs
    logs = [m for m in caplog.messages if "[KnowledgeTiming]" in m]
    assert any("stage=worker_queue" in m for m in logs)
    assert all(f"task_id={task_id if task_id is not None else '-'} " in m for m in logs)
