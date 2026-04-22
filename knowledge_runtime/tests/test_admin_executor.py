# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for AdminExecutor service."""

from unittest.mock import MagicMock, patch

import pytest

from knowledge_runtime.services.admin_executor import AdminExecutor
from shared.models import (
    RemoteDeleteDocumentIndexRequest,
    RemoteDropKnowledgeIndexRequest,
    RemoteListChunksRequest,
    RemotePurgeKnowledgeIndexRequest,
    RemoteTestConnectionRequest,
    RuntimeRetrieverConfig,
)


@pytest.fixture
def retriever_config():
    """Create a sample retriever config."""
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
    """Tests for AdminExecutor."""

    @pytest.mark.asyncio
    async def test_delete_document_index_success(
        self, admin_executor, retriever_config
    ) -> None:
        """Test successful document index deletion."""
        request = RemoteDeleteDocumentIndexRequest(
            knowledge_base_id=1,
            document_ref="doc_123",
            index_owner_user_id=7,
            retriever_config=retriever_config,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.delete_document.return_value = {
            "status": "success",
            "deleted_chunks": 5,
        }

        with patch(
            "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
            return_value=mock_storage_backend,
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
        self, admin_executor, retriever_config
    ) -> None:
        """Test successful knowledge base purge."""
        request = RemotePurgeKnowledgeIndexRequest(
            knowledge_base_id=1,
            index_owner_user_id=7,
            retriever_config=retriever_config,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.delete_knowledge.return_value = {
            "status": "success",
            "deleted_count": 100,
        }

        with patch(
            "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
            return_value=mock_storage_backend,
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
        self, admin_executor, retriever_config
    ) -> None:
        """Test successful knowledge base index drop."""
        request = RemoteDropKnowledgeIndexRequest(
            knowledge_base_id=1,
            index_owner_user_id=7,
            retriever_config=retriever_config,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.drop_knowledge_index.return_value = {"status": "success"}

        with patch(
            "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
            return_value=mock_storage_backend,
        ):
            result = await admin_executor.drop_knowledge_index(request)

        assert result["status"] == "success"
        mock_storage_backend.drop_knowledge_index.assert_called_once_with(
            knowledge_id="1",
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_list_chunks_success(self, admin_executor, retriever_config) -> None:
        """Test successful chunk listing."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            index_owner_user_id=7,
            retriever_config=retriever_config,
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

        with patch(
            "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
            return_value=mock_storage_backend,
        ):
            result = await admin_executor.list_chunks(request)

        assert result.total == 2
        assert len(result.chunks) == 2
        assert result.chunks[0].content == "Chunk 1 content"
        assert result.chunks[0].title == "Doc1"
        assert result.chunks[1].content == "Chunk 2 content"

    @pytest.mark.asyncio
    async def test_list_chunks_empty(self, admin_executor, retriever_config) -> None:
        """Test empty chunk listing."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            index_owner_user_id=7,
            retriever_config=retriever_config,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.get_all_chunks.return_value = []
        mock_storage_backend.extract_chunk_text = lambda x: x

        with patch(
            "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
            return_value=mock_storage_backend,
        ):
            result = await admin_executor.list_chunks(request)

        assert result.total == 0
        assert len(result.chunks) == 0

    @pytest.mark.asyncio
    async def test_test_connection_success(
        self, admin_executor, retriever_config
    ) -> None:
        """Test successful connection test."""
        request = RemoteTestConnectionRequest(retriever_config=retriever_config)

        mock_storage_backend = MagicMock()
        mock_storage_backend.test_connection.return_value = True

        with patch(
            "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
            return_value=mock_storage_backend,
        ):
            result = await admin_executor.test_connection(request)

        assert result["success"] is True
        assert result["message"] == "Connection successful"

    @pytest.mark.asyncio
    async def test_test_connection_failure(
        self, admin_executor, retriever_config
    ) -> None:
        """Test failed connection test."""
        request = RemoteTestConnectionRequest(retriever_config=retriever_config)

        mock_storage_backend = MagicMock()
        mock_storage_backend.test_connection.side_effect = Exception(
            "Connection refused"
        )

        with patch(
            "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
            return_value=mock_storage_backend,
        ):
            result = await admin_executor.test_connection(request)

        assert result["success"] is False
        assert "Connection refused" in result["message"]

    @pytest.mark.asyncio
    async def test_list_chunks_with_metadata_condition(
        self, admin_executor, retriever_config
    ) -> None:
        """Test chunk listing with metadata condition filter."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            index_owner_user_id=7,
            retriever_config=retriever_config,
            metadata_condition={"doc_ref": "doc_123"},
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.get_all_chunks.return_value = []
        mock_storage_backend.extract_chunk_text = lambda x: x

        with patch(
            "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
            return_value=mock_storage_backend,
        ):
            await admin_executor.list_chunks(request)

        mock_storage_backend.get_all_chunks.assert_called_once()
        call_kwargs = mock_storage_backend.get_all_chunks.call_args.kwargs
        assert call_kwargs["metadata_condition"] == {"doc_ref": "doc_123"}
