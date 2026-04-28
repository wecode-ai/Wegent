# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from decimal import Decimal
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def set_auto_direct_injection_enabled_by_default(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(
        settings,
        "RAG_AUTO_DISABLE_DIRECT_INJECTION",
        False,
        raising=False,
    )


@pytest.mark.asyncio
async def test_retrieve_for_chat_shell_no_longer_persists_subtask_context():
    from app.services.context.context_service import context_service
    from app.services.rag.retrieval_service import RetrievalService

    service = RetrievalService()
    service.retrieve_from_knowledge_base_internal = AsyncMock(
        return_value={
            "records": [
                {
                    "content": "retrieved chunk",
                    "score": 0.9,
                    "title": "doc.md",
                    "metadata": {"page": 1},
                }
            ]
        }
    )

    mock_get_context_map = MagicMock()
    mock_create_context = MagicMock()
    mock_update_context = MagicMock()

    with patch.multiple(
        context_service,
        get_knowledge_base_context_map_by_subtask=mock_get_context_map,
        create_knowledge_base_context_with_result=mock_create_context,
        update_knowledge_base_retrieval_result=mock_update_context,
    ):
        result = await service.retrieve_with_routing(
            query="test",
            knowledge_base_ids=[1],
            db=MagicMock(),
            user_id=20,
            route_mode="rag_retrieval",
        )

    assert result["mode"] == "rag_retrieval"
    assert result["total"] == 1
    mock_get_context_map.assert_not_called()
    mock_create_context.assert_not_called()
    mock_update_context.assert_not_called()


@pytest.mark.unit
class TestGetAllChunksFromKnowledgeBase:
    @pytest.mark.asyncio
    async def test_get_all_chunks_without_user_auth_check(self):
        """Internal all-chunks should work without passing a request user."""
        from app.services.rag import gateway_factory
        from app.services.rag.retrieval_service import RetrievalService
        from app.services.rag.runtime_specs import ListChunksRuntimeSpec
        from shared.models import RuntimeRetrieverConfig

        retriever_config = RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant", "url": "http://qdrant:6333"},
        )
        spec = ListChunksRuntimeSpec(
            knowledge_base_id=123,
            index_owner_user_id=42,
            retriever_config=retriever_config,
            max_chunks=50,
            query="debug query",
            metadata_condition=None,
        )

        mock_gateway = MagicMock()
        mock_gateway.list_chunks = AsyncMock(
            return_value={
                "chunks": [{"content": "chunk", "title": "doc-1", "doc_ref": "1"}],
                "total": 1,
            }
        )

        with (
            patch(
                "app.services.rag.retrieval_service.RagRuntimeResolver.build_public_list_chunks_runtime_spec",
                return_value=spec,
            ) as mock_build_spec,
            patch.object(
                gateway_factory,
                "get_list_chunks_gateway",
                return_value=mock_gateway,
            ) as mock_get_gateway,
        ):
            db_session = MagicMock()
            result = await RetrievalService().get_all_chunks_from_knowledge_base(
                knowledge_base_id=123,
                db=db_session,
                user_id=42,
                max_chunks=50,
                query="debug query",
            )

        assert result == [
            {
                "content": "chunk",
                "title": "doc-1",
                "chunk_id": None,
                "doc_ref": "1",
                "metadata": None,
            }
        ]
        mock_build_spec.assert_called_once_with(
            db=db_session,
            knowledge_base_id=123,
            user_id=42,
            user_name=None,
            max_chunks=50,
            query="debug query",
            metadata_condition=None,
        )
        mock_get_gateway.assert_called_once()
        mock_gateway.list_chunks.assert_awaited_once_with(spec, db=db_session)


@pytest.mark.unit
class TestRetrieveForChatShell:
    def test_internal_retrieve_endpoint_uses_gateway_runtime_spec(self, test_client):
        payload = {
            "query": "test",
            "knowledge_base_ids": [123],
            "max_results": 5,
            "route_mode": "auto",
            "runtime_context": {
                "context_window": 10000,
                "used_context_tokens": 100,
                "reserved_output_tokens": 4096,
                "context_buffer_ratio": 0.1,
                "max_direct_chunks": 500,
            },
        }

        with (
            patch(
                "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
                return_value=object(),
            ) as mock_resolve,
            patch(
                "app.api.endpoints.internal.rag.LocalRagGateway.query",
                new_callable=AsyncMock,
                return_value={
                    "mode": "rag_retrieval",
                    "records": [],
                    "total": 0,
                    "total_estimated_tokens": 0,
                },
            ) as mock_query,
        ):
            response = test_client.post("/api/internal/rag/retrieve", json=payload)

        assert response.status_code == 200
        mock_resolve.assert_called_once()
        mock_query.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_auto_route_returns_direct_injection_records(self):
        """Backend should route to original documents when KB estimate fits context."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ) as mock_estimate:
            service = RetrievalService()
            service.get_original_documents_from_knowledge_base = AsyncMock(
                return_value=[
                    {
                        "content": "full document content",
                        "score": 1.0,
                        "title": "doc-1",
                        "metadata": {"document_id": 1, "total_length": 100},
                        "knowledge_base_id": 123,
                    }
                ]
            )

            result = await service.retrieve_with_routing(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                max_results=5,
                context_window=10000,
                user_id=7,
            )

        mock_estimate.assert_called_once_with(
            db=db,
            knowledge_base_ids=[123],
            document_ids=None,
        )
        assert result["mode"] == "direct_injection"
        assert result["total"] == 1
        assert result["records"][0]["score"] == 1.0
        assert result["records"][0]["knowledge_base_id"] == 123

    @pytest.mark.asyncio
    async def test_auto_route_falls_back_to_rag_when_runtime_budget_is_insufficient(
        self,
    ):
        """Backend should own the final fit check when runtime budget is provided."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ):
            service = RetrievalService()
            service.get_original_documents_from_knowledge_base = AsyncMock(
                return_value=[
                    {
                        "content": "This is a full document with enough text to exceed the runtime budget.",
                        "score": 1.0,
                        "title": "doc-1",
                        "metadata": {"document_id": 1, "total_length": 100},
                        "knowledge_base_id": 123,
                    }
                ]
            )
            service.retrieve_from_knowledge_base_internal = AsyncMock(
                return_value={
                    "records": [
                        {
                            "content": "retrieved",
                            "score": 0.9,
                            "title": "doc-1",
                            "metadata": {"page": 2},
                        }
                    ]
                }
            )

            result = await service.retrieve_with_routing(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                max_results=5,
                context_window=10000,
                used_context_tokens=9990,
                reserved_output_tokens=0,
                context_buffer_ratio=0.0,
                user_id=7,
            )

        assert result["mode"] == "rag_retrieval"
        assert result["records"][0]["score"] == 0.9
        assert result["records"][0]["knowledge_base_id"] == 123

    @pytest.mark.asyncio
    async def test_force_direct_route_respects_max_direct_chunks(self):
        """Forced direct route should still fallback when document cap is exceeded."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        service = RetrievalService()
        service.get_original_documents_from_knowledge_base = AsyncMock(
            return_value=[
                {
                    "content": "document-1",
                    "score": 1.0,
                    "title": "doc-1",
                    "metadata": {"document_id": 1, "total_length": 100},
                    "knowledge_base_id": 123,
                },
                {
                    "content": "document-2",
                    "score": 1.0,
                    "title": "doc-2",
                    "metadata": {"document_id": 2, "total_length": 100},
                    "knowledge_base_id": 123,
                },
            ]
        )
        service.retrieve_from_knowledge_base_internal = AsyncMock(
            return_value={
                "records": [
                    {
                        "content": "retrieved",
                        "score": 0.9,
                        "title": "doc-1",
                        "metadata": {"page": 2},
                    }
                ]
            }
        )

        result = await service.retrieve_with_routing(
            query="test",
            knowledge_base_ids=[123],
            db=db,
            max_results=5,
            route_mode="direct_injection",
            max_direct_chunks=1,
        )

        assert result["mode"] == "rag_retrieval"
        service.retrieve_from_knowledge_base_internal.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_auto_route_estimates_only_filtered_documents(self):
        """Document-scoped requests should pass document_ids into the estimate path."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        service = RetrievalService()
        service.get_original_documents_from_knowledge_base = AsyncMock(
            return_value=[
                {
                    "content": "full document content",
                    "score": 1.0,
                    "title": "doc-1",
                    "metadata": {"document_id": 1, "total_length": 100},
                    "knowledge_base_id": 123,
                }
            ]
        )

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ) as mock_estimate:
            result = await service.retrieve_with_routing(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                max_results=5,
                context_window=10000,
                document_ids=[1],
                user_id=7,
            )

        mock_estimate.assert_called_once_with(
            db=db,
            knowledge_base_ids=[123],
            document_ids=[1],
        )
        assert result["mode"] == "direct_injection"
        assert result["records"][0]["knowledge_base_id"] == 123

    def test_decide_route_mode_for_chat_shell_returns_rag_retrieval_without_budget(
        self,
    ):
        from app.services.rag.retrieval_service import RetrievalService

        service = RetrievalService()
        db = MagicMock()

        result = service.decide_route_mode_for_chat_shell(
            query="test",
            knowledge_base_ids=[123],
            db=db,
            route_mode="auto",
            context_window=None,
        )

        assert result == "rag_retrieval"

    def test_decide_route_mode_for_chat_shell_returns_direct_injection_when_auto_fits(
        self,
    ):
        from app.services.rag.retrieval_service import RetrievalService

        service = RetrievalService()
        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ) as mock_estimate:
            result = service.decide_route_mode_for_chat_shell(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                route_mode="auto",
                context_window=10000,
                metadata_condition=None,
            )

        mock_estimate.assert_called_once_with(
            db=db,
            knowledge_base_ids=[123],
            document_ids=None,
        )
        assert result == "direct_injection"

    def test_decide_route_mode_for_chat_shell_skips_direct_injection_when_auto_disabled(
        self, monkeypatch
    ):
        from app.core.config import settings
        from app.services.rag.retrieval_service import RetrievalService

        monkeypatch.setattr(
            settings,
            "RAG_AUTO_DISABLE_DIRECT_INJECTION",
            True,
            raising=False,
        )

        service = RetrievalService()
        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ) as mock_estimate:
            result = service.decide_route_mode_for_chat_shell(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                route_mode="auto",
                context_window=10000,
            )

        mock_estimate.assert_not_called()
        assert result == "rag_retrieval"

    def test_decide_route_mode_for_chat_shell_uses_live_runtime_budget(self):
        from app.services.rag.retrieval_service import RetrievalService

        service = RetrievalService()
        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ):
            result = service.decide_route_mode_for_chat_shell(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                route_mode="auto",
                context_window=10000,
                used_context_tokens=9990,
                reserved_output_tokens=0,
                context_buffer_ratio=0.0,
            )

        assert result == "rag_retrieval"

    def test_decide_route_mode_for_chat_shell_forces_rag_when_metadata_filter_exists(
        self,
    ):
        from app.services.rag.retrieval_service import RetrievalService

        service = RetrievalService()

        result = service.decide_route_mode_for_chat_shell(
            query="test",
            knowledge_base_ids=[123],
            db=MagicMock(),
            route_mode="direct_injection",
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "source", "operator": "eq", "value": "kb"}],
            },
        )

        assert result == "rag_retrieval"

    def test_estimate_total_tokens_supports_decimal_aggregate_result(self):
        """Aggregate text-length queries may return Decimal depending on the driver."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        query = MagicMock()
        query.select_from.return_value = query
        query.join.return_value = query
        query.filter.return_value = query
        query.scalar.return_value = Decimal("100")
        db.query.return_value = query

        estimated_tokens = RetrievalService._estimate_total_tokens_for_knowledge_bases(
            db=db,
            knowledge_base_ids=[123],
            document_ids=None,
        )

        assert estimated_tokens == 150

    @pytest.mark.asyncio
    async def test_force_rag_route_uses_standard_retrieval(self):
        """Forced rag route should bypass direct injection candidate path."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        service = RetrievalService()
        service.retrieve_from_knowledge_base_internal = AsyncMock(
            return_value={
                "records": [
                    {
                        "content": "retrieved",
                        "score": 0.9,
                        "title": "doc-1",
                        "metadata": {"page": 2},
                    }
                ]
            }
        )

        result = await service.retrieve_with_routing(
            query="test",
            knowledge_base_ids=[123],
            db=db,
            max_results=5,
            route_mode="rag_retrieval",
        )

        assert result["mode"] == "rag_retrieval"
        assert result["records"][0]["score"] == 0.9
        assert result["records"][0]["knowledge_base_id"] == 123

    @pytest.mark.asyncio
    async def test_metadata_filter_disables_direct_injection_and_uses_rag_path(self):
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        service = RetrievalService()
        service.get_all_chunks_from_knowledge_base = AsyncMock()
        service.retrieve_from_knowledge_base_internal = AsyncMock(
            return_value={
                "records": [
                    {
                        "content": "retrieved",
                        "score": 0.9,
                        "title": "doc-1",
                        "metadata": {"source": "kb"},
                    }
                ]
            }
        )

        result = await service.retrieve_with_routing(
            query="test",
            knowledge_base_ids=[123],
            db=db,
            max_results=5,
            route_mode="direct_injection",
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "source", "operator": "eq", "value": "kb"}],
            },
        )

        assert result["mode"] == "rag_retrieval"
        service.get_all_chunks_from_knowledge_base.assert_not_called()
        service.retrieve_from_knowledge_base_internal.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_package_mode_resolves_document_names_before_retrieval(self):
        """Package mode should resolve document_names before calling retrieval service."""
        from chat_shell.tools.builtin import KnowledgeBaseTool

        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            db_session=MagicMock(),
            user_id=7,
        )

        with (
            patch.object(
                tool,
                "_get_kb_info",
                AsyncMock(
                    return_value={
                        "items": [
                            {
                                "id": 1,
                                "name": "Test KB",
                                "rag_enabled": True,
                                "max_calls_per_conversation": 10,
                                "exempt_calls_before_check": 5,
                            }
                        ]
                    }
                ),
            ),
            patch(
                "app.services.knowledge.KnowledgeService.resolve_document_ids_by_names",
                return_value=[301],
                create=True,
            ) as mock_resolve,
            patch(
                "app.services.rag.retrieval_service.RetrievalService.retrieve_with_routing",
                new_callable=AsyncMock,
                return_value={
                    "mode": "rag_retrieval",
                    "records": [
                        {
                            "content": "match",
                            "score": 0.9,
                            "title": "release.md",
                            "knowledge_base_id": 1,
                        }
                    ],
                    "total": 1,
                    "total_estimated_tokens": 0,
                },
            ) as mock_retrieve,
        ):
            await tool._arun(
                query="release checklist",
                document_names=["release.md"],
            )

        mock_resolve.assert_called_once_with(
            db=tool.db_session,
            knowledge_base_ids=[1],
            document_names=["release.md"],
        )
        assert mock_retrieve.await_args.kwargs["document_ids"] == [301]

    @pytest.mark.asyncio
    async def test_force_rag_route_sorts_and_limits_results_globally(self):
        """Backend should return the final globally ranked RAG records."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        service = RetrievalService()
        service.retrieve_from_knowledge_base_internal = AsyncMock(
            side_effect=[
                {
                    "records": [
                        {
                            "content": "kb1-low",
                            "score": 0.3,
                            "title": "doc-1",
                            "metadata": {"page": 1},
                        },
                        {
                            "content": "kb1-high",
                            "score": 0.9,
                            "title": "doc-2",
                            "metadata": {"page": 2},
                        },
                    ]
                },
                {
                    "records": [
                        {
                            "content": "kb2-top",
                            "score": 0.95,
                            "title": "doc-3",
                            "metadata": {"page": 3},
                        }
                    ]
                },
            ]
        )

        result = await service.retrieve_with_routing(
            query="test",
            knowledge_base_ids=[123, 456],
            db=db,
            max_results=2,
            route_mode="rag_retrieval",
        )

        assert result["mode"] == "rag_retrieval"
        assert len(result["records"]) == 2
        assert [record["score"] for record in result["records"]] == [0.95, 0.9]
        assert [record["knowledge_base_id"] for record in result["records"]] == [
            456,
            123,
        ]

    @pytest.mark.asyncio
    async def test_force_rag_route_uses_knowledge_engine_query_executor_when_runtime_configs_are_available(
        self,
    ):
        """Resolved runtime configs should drive the engine query seam in local mode."""
        from app.services.rag.retrieval_service import RetrievalService
        from shared.models import (
            RemoteKnowledgeBaseQueryConfig,
            RuntimeEmbeddingModelConfig,
            RuntimeRetrievalConfig,
            RuntimeRetrieverConfig,
        )

        db = MagicMock()
        storage_backend = MagicMock()
        embed_model = object()
        kb_config = RemoteKnowledgeBaseQueryConfig(
            knowledge_base_id=123,
            index_owner_user_id=7,
            retriever_config=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant", "url": "http://qdrant:6333"},
            ),
            embedding_model_config=RuntimeEmbeddingModelConfig(
                model_name="embed-a",
                model_namespace="default",
                resolved_config={"protocol": "openai"},
            ),
            retrieval_config=RuntimeRetrievalConfig(
                top_k=8,
                score_threshold=0.45,
                retrieval_mode="hybrid",
                vector_weight=0.8,
                keyword_weight=0.2,
            ),
        )

        with (
            patch(
                "app.services.rag.retrieval_service.create_storage_backend_from_runtime_config",
                return_value=storage_backend,
            ) as mock_storage,
            patch(
                "app.services.rag.retrieval_service.create_embedding_model_from_runtime_config",
                return_value=embed_model,
            ) as mock_embedding,
            patch(
                "app.services.rag.retrieval_service.QueryExecutor.execute",
                new_callable=AsyncMock,
                return_value={
                    "records": [
                        {
                            "content": "release checklist",
                            "score": 0.91,
                            "title": "Checklist",
                            "metadata": {"doc_ref": "9"},
                        }
                    ]
                },
            ) as mock_execute,
        ):
            result = await RetrievalService().retrieve_with_routing(
                query="release checklist",
                knowledge_base_ids=[123],
                db=db,
                max_results=5,
                route_mode="rag_retrieval",
                document_ids=[9],
                knowledge_base_configs=[kb_config],
            )

        assert result["mode"] == "rag_retrieval"
        assert result["records"] == [
            {
                "content": "release checklist",
                "score": 0.91,
                "title": "Checklist",
                "metadata": {"doc_ref": "9"},
                "knowledge_base_id": 123,
            }
        ]
        mock_storage.assert_called_once_with(kb_config.retriever_config)
        mock_embedding.assert_called_once_with(kb_config.embedding_model_config)
        mock_execute.assert_awaited_once_with(
            knowledge_id="123",
            query="release checklist",
            retrieval_config=kb_config.retrieval_config,
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "doc_ref", "operator": "in", "value": ["9"]}],
            },
            user_id=7,
        )
