# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for AdminExecutor service using reference mode."""

from unittest.mock import MagicMock, patch

import pytest

from knowledge_runtime.services.admin_executor import AdminExecutor
from shared.models import (
    KnowledgeBaseReference,
    RemoteDeleteDocumentIndexRequest,
    RemoteDropKnowledgeIndexRequest,
    RemoteKnowledgeBaseQueryConfig,
    RemoteListChunksRequest,
    RemotePurgeKnowledgeIndexRequest,
    RemoteTestConnectionRequest,
    RetrieverReference,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


@pytest.fixture
def kb_reference():
    """Create a sample knowledge base reference."""
    return KnowledgeBaseReference(knowledge_base_id=1, user_id=7)


@pytest.fixture
def retriever_reference():
    """Create a sample retriever reference."""
    return RetrieverReference(name="test-retriever", namespace="default", user_id=7)


@pytest.fixture
def resolved_kb_config():
    """Create a resolved KB config (returned by resolver)."""
    return RemoteKnowledgeBaseQueryConfig(
        knowledge_base_id=1,
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
def resolved_retriever_config():
    """Create a resolved retriever config (returned by resolver)."""
    return RuntimeRetrieverConfig(
        name="test-retriever",
        namespace="default",
        storage_config={
            "type": "qdrant",
            "url": "http://localhost:6333",
        },
    )


@pytest.fixture
def admin_executor():
    """Create an AdminExecutor instance."""
    return AdminExecutor()


class TestAdminExecutor:
    """Tests for AdminExecutor using reference mode."""

    @pytest.mark.asyncio
    async def test_delete_document_index_success(
        self, admin_executor, kb_reference, resolved_kb_config
    ) -> None:
        """Test successful document index deletion using reference mode."""
        request = RemoteDeleteDocumentIndexRequest(
            knowledge_base_id=1,
            document_ref="doc_123",
            knowledge_base_reference=kb_reference,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.delete_document.return_value = {
            "status": "success",
            "deleted_chunks": 5,
        }

        with (
            patch.object(
                admin_executor._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            result = await admin_executor.delete_document_index(request)

        assert result["status"] == "success"
        assert result["deleted_chunks"] == 5
        mock_storage_backend.delete_document.assert_called_once_with(
            knowledge_id="1",
            doc_ref="doc_123",
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_purge_knowledge_index_success(
        self, admin_executor, kb_reference, resolved_kb_config
    ) -> None:
        """Test successful knowledge base purge using reference mode."""
        request = RemotePurgeKnowledgeIndexRequest(
            knowledge_base_id=1,
            knowledge_base_reference=kb_reference,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.delete_knowledge.return_value = {
            "status": "success",
            "deleted_count": 100,
        }

        with (
            patch.object(
                admin_executor._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            result = await admin_executor.purge_knowledge_index(request)

        assert result["status"] == "success"
        assert result["deleted_count"] == 100
        mock_storage_backend.delete_knowledge.assert_called_once_with(
            knowledge_id="1",
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_drop_knowledge_index_success(
        self, admin_executor, kb_reference, resolved_kb_config
    ) -> None:
        """Test successful knowledge base index drop using reference mode."""
        request = RemoteDropKnowledgeIndexRequest(
            knowledge_base_id=1,
            knowledge_base_reference=kb_reference,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.drop_knowledge_index.return_value = {"status": "success"}

        with (
            patch.object(
                admin_executor._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            result = await admin_executor.drop_knowledge_index(request)

        assert result["status"] == "success"
        mock_storage_backend.drop_knowledge_index.assert_called_once_with(
            knowledge_id="1",
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_list_chunks_success(
        self, admin_executor, kb_reference, resolved_kb_config
    ) -> None:
        """Test successful chunk listing using reference mode."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            knowledge_base_reference=kb_reference,
            max_chunks=100,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.get_all_chunks.return_value = [
            {
                "content": "Chunk 1 content",
                "title": "Doc1",
                "chunk_id": 0,
                "doc_ref": "doc_1",
                "metadata": {"key": "value"},
            },
            {
                "content": "Chunk 2 content",
                "title": "Doc2",
                "chunk_id": 1,
                "doc_ref": "doc_2",
                "metadata": {},
            },
        ]
        mock_storage_backend.extract_chunk_text = lambda x: x

        with (
            patch.object(
                admin_executor._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            result = await admin_executor.list_chunks(request)

        assert result.total == 2
        assert len(result.chunks) == 2
        assert result.chunks[0].content == "Chunk 1 content"
        assert result.chunks[0].title == "Doc1"
        assert result.chunks[1].content == "Chunk 2 content"

    @pytest.mark.asyncio
    async def test_list_chunks_empty(
        self, admin_executor, kb_reference, resolved_kb_config
    ) -> None:
        """Test empty chunk listing using reference mode."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            knowledge_base_reference=kb_reference,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.get_all_chunks.return_value = []
        mock_storage_backend.extract_chunk_text = lambda x: x

        with (
            patch.object(
                admin_executor._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            result = await admin_executor.list_chunks(request)

        assert result.total == 0
        assert len(result.chunks) == 0

    @pytest.mark.asyncio
    async def test_test_connection_success(
        self, admin_executor, retriever_reference, resolved_retriever_config
    ) -> None:
        """Test successful connection test using reference mode."""
        request = RemoteTestConnectionRequest(
            retriever_reference=retriever_reference,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.test_connection.return_value = True

        with (
            patch.object(
                admin_executor._resolver,
                "resolve_retriever_config_for_test",
                return_value=resolved_retriever_config,
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            result = await admin_executor.test_connection(request)

        assert result["success"] is True
        assert result["message"] == "Connection successful"

    @pytest.mark.asyncio
    async def test_test_connection_failure(
        self, admin_executor, retriever_reference, resolved_retriever_config
    ) -> None:
        """Test failed connection test using reference mode."""
        request = RemoteTestConnectionRequest(
            retriever_reference=retriever_reference,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.test_connection.side_effect = Exception(
            "Connection refused"
        )

        with (
            patch.object(
                admin_executor._resolver,
                "resolve_retriever_config_for_test",
                return_value=resolved_retriever_config,
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            result = await admin_executor.test_connection(request)

        assert result["success"] is False
        assert "Connection refused" in result["message"]

    @pytest.mark.asyncio
    async def test_list_chunks_with_metadata_condition(
        self, admin_executor, kb_reference, resolved_kb_config
    ) -> None:
        """Test chunk listing with metadata condition filter using reference mode."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            knowledge_base_reference=kb_reference,
            metadata_condition={"doc_ref": "doc_123"},
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.get_all_chunks.return_value = []
        mock_storage_backend.extract_chunk_text = lambda x: x

        with (
            patch.object(
                admin_executor._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            await admin_executor.list_chunks(request)

        mock_storage_backend.get_all_chunks.assert_called_once()
        call_kwargs = mock_storage_backend.get_all_chunks.call_args.kwargs
        assert call_kwargs["metadata_condition"] == {"doc_ref": "doc_123"}
