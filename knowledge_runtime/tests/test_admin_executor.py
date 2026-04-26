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
def mock_retriever_config():
    """Create a sample resolved retriever config."""
    return RuntimeRetrieverConfig(
        name="test-retriever",
        namespace="default",
        storage_config={
            "type": "qdrant",
            "url": "http://localhost:6333",
        },
    )


@pytest.fixture
def mock_kb():
    """Create a mock KnowledgeBase Kind record."""
    kb = MagicMock()
    kb.id = 1
    kb.user_id = 7
    kb.kind = "KnowledgeBase"
    kb.is_active = True
    return kb


@pytest.fixture
def admin_executor():
    """Create an AdminExecutor instance."""
    return AdminExecutor()


class TestAdminExecutor:
    """Tests for AdminExecutor."""

    @pytest.mark.asyncio
    async def test_delete_document_index_success(
        self, admin_executor, mock_retriever_config, mock_kb
    ) -> None:
        """Test successful document index deletion."""
        request = RemoteDeleteDocumentIndexRequest(
            knowledge_base_id=1,
            user_id=42,
            document_ref="doc_123",
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.delete_document.return_value = {
            "status": "success",
            "deleted_chunks": 5,
        }

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                return_value=mock_retriever_config
            )
            admin_executor._config_resolver._get_knowledge_base = MagicMock(
                return_value=mock_kb
            )

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
        self, admin_executor, mock_retriever_config, mock_kb
    ) -> None:
        """Test successful knowledge base purge."""
        request = RemotePurgeKnowledgeIndexRequest(
            knowledge_base_id=1,
            user_id=42,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.delete_knowledge.return_value = {
            "status": "success",
            "deleted_count": 100,
        }

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                return_value=mock_retriever_config
            )
            admin_executor._config_resolver._get_knowledge_base = MagicMock(
                return_value=mock_kb
            )

            result = await admin_executor.purge_knowledge_index(request)

        assert result["status"] == "success"
        assert result["deleted_count"] == 100
        mock_storage_backend.delete_knowledge.assert_called_once_with(
            knowledge_id="1",
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_drop_knowledge_index_success(
        self, admin_executor, mock_retriever_config, mock_kb
    ) -> None:
        """Test successful knowledge base index drop."""
        request = RemoteDropKnowledgeIndexRequest(
            knowledge_base_id=1,
            user_id=42,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.drop_knowledge_index.return_value = {"status": "success"}

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                return_value=mock_retriever_config
            )
            admin_executor._config_resolver._get_knowledge_base = MagicMock(
                return_value=mock_kb
            )

            result = await admin_executor.drop_knowledge_index(request)

        assert result["status"] == "success"
        mock_storage_backend.drop_knowledge_index.assert_called_once_with(
            knowledge_id="1",
            user_id=7,
        )

    @pytest.mark.asyncio
    async def test_list_chunks_success(
        self, admin_executor, mock_retriever_config, mock_kb
    ) -> None:
        """Test successful chunk listing."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            user_id=42,
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

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                return_value=mock_retriever_config
            )
            admin_executor._config_resolver._get_knowledge_base = MagicMock(
                return_value=mock_kb
            )

            result = await admin_executor.list_chunks(request)

        assert result.total == 2
        assert len(result.chunks) == 2
        assert result.chunks[0].content == "Chunk 1 content"
        assert result.chunks[0].title == "Doc1"
        assert result.chunks[1].content == "Chunk 2 content"

    @pytest.mark.asyncio
    async def test_list_chunks_empty(
        self, admin_executor, mock_retriever_config, mock_kb
    ) -> None:
        """Test empty chunk listing."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            user_id=42,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.get_all_chunks.return_value = []
        mock_storage_backend.extract_chunk_text = lambda x: x

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                return_value=mock_retriever_config
            )
            admin_executor._config_resolver._get_knowledge_base = MagicMock(
                return_value=mock_kb
            )

            result = await admin_executor.list_chunks(request)

        assert result.total == 0
        assert len(result.chunks) == 0

    @pytest.mark.asyncio
    async def test_test_connection_success(
        self, admin_executor, mock_retriever_config
    ) -> None:
        """Test successful connection test."""
        request = RemoteTestConnectionRequest(
            knowledge_base_id=1,
            user_id=42,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.test_connection.return_value = True

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                return_value=mock_retriever_config
            )

            result = await admin_executor.test_connection(request)

        assert result["success"] is True
        assert result["message"] == "Connection successful"

    @pytest.mark.asyncio
    async def test_test_connection_failure(
        self, admin_executor, mock_retriever_config
    ) -> None:
        """Test failed connection test."""
        request = RemoteTestConnectionRequest(
            knowledge_base_id=1,
            user_id=42,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.test_connection.side_effect = Exception(
            "Connection refused"
        )

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                return_value=mock_retriever_config
            )

            result = await admin_executor.test_connection(request)

        assert result["success"] is False
        assert "Connection refused" in result["message"]

    @pytest.mark.asyncio
    async def test_list_chunks_with_metadata_condition(
        self, admin_executor, mock_retriever_config, mock_kb
    ) -> None:
        """Test chunk listing with metadata condition filter."""
        request = RemoteListChunksRequest(
            knowledge_base_id=1,
            user_id=42,
            metadata_condition={"doc_ref": "doc_123"},
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.get_all_chunks.return_value = []
        mock_storage_backend.extract_chunk_text = lambda x: x

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                return_value=mock_retriever_config
            )
            admin_executor._config_resolver._get_knowledge_base = MagicMock(
                return_value=mock_kb
            )

            await admin_executor.list_chunks(request)

        mock_storage_backend.get_all_chunks.assert_called_once()
        call_kwargs = mock_storage_backend.get_all_chunks.call_args.kwargs
        assert call_kwargs["metadata_condition"] == {"doc_ref": "doc_123"}

    @pytest.mark.asyncio
    async def test_delete_document_db_closed_on_error(self, admin_executor) -> None:
        """Test that db session is closed even when config resolution fails."""
        from knowledge_runtime.services.config_resolver import ConfigResolutionError

        request = RemoteDeleteDocumentIndexRequest(
            knowledge_base_id=1,
            user_id=42,
            document_ref="doc_123",
        )

        mock_db = MagicMock()

        with patch(
            "knowledge_runtime.services.admin_executor.get_session",
            return_value=iter([mock_db]),
        ):
            admin_executor._config_resolver.resolve_retriever_config = MagicMock(
                side_effect=ConfigResolutionError("config_not_found", "KB not found")
            )

            with pytest.raises(ConfigResolutionError):
                await admin_executor.delete_document_index(request)

        # DB session should be closed even on error
        mock_db.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_test_connection_resolves_retriever_from_db(
        self, admin_executor, mock_retriever_config
    ) -> None:
        """Test that test_connection resolves retriever config from database."""
        request = RemoteTestConnectionRequest(
            knowledge_base_id=1,
            user_id=42,
        )

        mock_storage_backend = MagicMock()
        mock_storage_backend.test_connection.return_value = True

        mock_db = MagicMock()

        with (
            patch(
                "knowledge_runtime.services.admin_executor.get_session",
                return_value=iter([mock_db]),
            ),
            patch(
                "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
        ):
            mock_resolve = MagicMock(return_value=mock_retriever_config)
            admin_executor._config_resolver.resolve_retriever_config = mock_resolve

            await admin_executor.test_connection(request)

        # Verify resolver was called with correct args
        mock_resolve.assert_called_once_with(
            db=mock_db,
            knowledge_base_id=1,
            user_id=42,
        )
