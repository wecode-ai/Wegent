# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.unit
class TestGetAllChunksFromKnowledgeBase:
    @pytest.mark.asyncio
    async def test_get_all_chunks_without_user_auth_check(self):
        """Internal all-chunks should work without passing a request user."""
        from app.services.rag.retrieval_service import RetrievalService

        kb = MagicMock()
        kb.id = 123
        kb.name = "KB"
        kb.namespace = "team-a"
        kb.user_id = 42
        kb.json = {
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-a",
                    "retriever_namespace": "default",
                }
            }
        }

        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = kb

        mock_backend = MagicMock()
        mock_backend.get_index_name.return_value = "kb-index"
        mock_backend.get_all_chunks.return_value = [
            {"content": "chunk", "title": "doc-1", "doc_ref": "1"}
        ]

        with patch(
            "app.services.rag.retrieval_service.retriever_kinds_service.get_retriever",
            return_value=MagicMock(),
        ):
            with patch(
                "app.services.rag.retrieval_service.create_storage_backend",
                return_value=mock_backend,
            ):
                result = await RetrievalService().get_all_chunks_from_knowledge_base(
                    knowledge_base_id=123,
                    db=db,
                    max_chunks=50,
                    query="debug query",
                )

        assert result == [{"content": "chunk", "title": "doc-1", "doc_ref": "1"}]
        mock_backend.get_index_name.assert_called_once_with("123", user_id=42)
        mock_backend.get_all_chunks.assert_called_once_with(
            knowledge_id="123",
            max_chunks=50,
            user_id=42,
        )


@pytest.mark.unit
class TestRetrieveForChatShell:
    @pytest.mark.asyncio
    async def test_auto_route_returns_direct_injection_records(self):
        """Backend should route to all-chunks when KB estimate fits context."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ) as mock_estimate:
            service = RetrievalService()
            service.get_all_chunks_from_knowledge_base = AsyncMock(
                return_value=[
                    {
                        "content": "chunk",
                        "title": "doc-1",
                        "doc_ref": "1",
                        "metadata": {"page": 1},
                    }
                ]
            )

            result = await service.retrieve_for_chat_shell(
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
        assert result["records"][0]["score"] is None
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
            service.get_all_chunks_from_knowledge_base = AsyncMock(
                return_value=[
                    {
                        "content": "This is a direct injection candidate chunk with enough text to exceed the runtime budget.",
                        "title": "doc-1",
                        "doc_ref": "1",
                        "metadata": {"page": 1},
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

            result = await service.retrieve_for_chat_shell(
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
        """Forced direct route should still fallback when chunk cap is exceeded."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        service = RetrievalService()
        service.get_all_chunks_from_knowledge_base = AsyncMock(
            return_value=[
                {
                    "content": "chunk-1",
                    "title": "doc-1",
                    "doc_ref": "1",
                    "metadata": {"page": 1},
                },
                {
                    "content": "chunk-2",
                    "title": "doc-2",
                    "doc_ref": "2",
                    "metadata": {"page": 2},
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

        result = await service.retrieve_for_chat_shell(
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
        service.get_all_chunks_from_knowledge_base = AsyncMock(
            return_value=[
                {
                    "content": "chunk",
                    "title": "doc-1",
                    "doc_ref": "1",
                    "metadata": {"page": 1},
                }
            ]
        )

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ) as mock_estimate:
            result = await service.retrieve_for_chat_shell(
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

        result = await service.retrieve_for_chat_shell(
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

        result = await service.retrieve_for_chat_shell(
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
    async def test_persists_retrieve_results_when_subtask_context_is_provided(self):
        """Backend should own SubtaskContext persistence for chat_shell retrieval."""
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

        with patch(
            "app.services.rag.retrieval_service.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist:
            result = await service.retrieve_for_chat_shell(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                max_results=5,
                route_mode="rag_retrieval",
                user_id=7,
                user_subtask_id=8,
                restricted_mode=True,
            )

        assert result["mode"] == "rag_retrieval"
        mock_persist.assert_called_once()
        persist_kwargs = mock_persist.call_args.kwargs
        assert persist_kwargs["user_id"] == 7
        assert persist_kwargs["user_subtask_id"] == 8
        assert persist_kwargs["restricted_mode"] is True
        assert persist_kwargs["records"][0]["knowledge_base_id"] == 123
