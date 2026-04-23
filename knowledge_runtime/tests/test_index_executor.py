# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for IndexExecutor service using reference mode."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knowledge_runtime.services.index_executor import IndexExecutor
from shared.models import (
    KnowledgeBaseReference,
    PresignedUrlContentRef,
    RemoteIndexRequest,
    RemoteKnowledgeBaseQueryConfig,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


@pytest.fixture
def kb_reference():
    """Create a sample knowledge base reference."""
    return KnowledgeBaseReference(knowledge_base_id=1, user_id=7)


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
def index_request(kb_reference):
    """Create a sample index request using reference mode."""
    return RemoteIndexRequest(
        knowledge_base_id=1,
        document_id=100,
        content_ref=PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/test.pdf",
        ),
        knowledge_base_reference=kb_reference,
    )


class TestIndexExecutor:
    """Tests for IndexExecutor using reference mode."""

    @pytest.mark.asyncio
    async def test_execute_success(self, index_request, resolved_kb_config) -> None:
        """Test successful index execution using reference mode."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_document_service = MagicMock()

        mock_document_service.index_document_from_binary = AsyncMock(
            return_value={
                "chunk_count": 5,
                "doc_ref": "100",
                "knowledge_id": "1",
                "source_file": "test.pdf",
                "index_name": "wegent_kb_1",
                "status": "success",
            }
        )

        with (
            patch.object(
                IndexExecutor()._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ),
            patch(
                "knowledge_runtime.services.index_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
            patch(
                "knowledge_runtime.services.index_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ),
            patch(
                "knowledge_runtime.services.index_executor.DocumentService",
                return_value=mock_document_service,
            ),
            patch("httpx.AsyncClient") as mock_client,
            patch("knowledge_runtime.config._settings", None),
        ):
            mock_response = MagicMock()
            mock_response.content = b"test content"
            mock_response.raise_for_status = MagicMock()
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            executor = IndexExecutor()
            result = await executor.execute(index_request)

        assert result["chunk_count"] == 5
        assert result["doc_ref"] == "100"
        mock_document_service.index_document_from_binary.assert_called_once()

    @pytest.mark.asyncio
    async def test_execute_resolves_reference(
        self, index_request, resolved_kb_config
    ) -> None:
        """Test that executor resolves KB reference correctly."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_document_service = MagicMock()

        mock_document_service.index_document_from_binary = AsyncMock(
            return_value={
                "chunk_count": 3,
                "doc_ref": "100",
            }
        )

        executor = IndexExecutor()

        with (
            patch.object(
                executor._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ) as mock_resolve,
            patch(
                "knowledge_runtime.services.index_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
            patch(
                "knowledge_runtime.services.index_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ),
            patch(
                "knowledge_runtime.services.index_executor.DocumentService",
                return_value=mock_document_service,
            ),
            patch("httpx.AsyncClient") as mock_client,
            patch("knowledge_runtime.config._settings", None),
        ):
            mock_response = MagicMock()
            mock_response.content = b"content"
            mock_response.raise_for_status = MagicMock()
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            await executor.execute(index_request)

        # Verify resolver was called with correct reference
        mock_resolve.assert_called_once_with(
            knowledge_base_id=1,
            user_id=7,
            user_name=None,
        )

    @pytest.mark.asyncio
    async def test_execute_content_fetch_error_propagates(self, index_request) -> None:
        """Test that content fetch errors propagate correctly."""
        from knowledge_runtime.services.content_fetcher import ContentFetchError

        with (
            patch("httpx.AsyncClient") as mock_client,
            patch("knowledge_runtime.config._settings", None),
        ):
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                side_effect=ContentFetchError("Fetch failed", retryable=True)
            )

            executor = IndexExecutor()

            with pytest.raises(ContentFetchError) as exc_info:
                await executor.execute(index_request)

            assert exc_info.value.retryable

    @pytest.mark.asyncio
    async def test_execute_storage_error_propagates(
        self, index_request, resolved_kb_config
    ) -> None:
        """Test that storage backend errors propagate correctly."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_document_service = MagicMock()

        mock_document_service.index_document_from_binary = AsyncMock(
            side_effect=ValueError("Storage connection failed")
        )

        with (
            patch.object(
                IndexExecutor()._resolver,
                "resolve_knowledge_base_query_config",
                return_value=resolved_kb_config,
            ),
            patch(
                "knowledge_runtime.services.index_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ),
            patch(
                "knowledge_runtime.services.index_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ),
            patch(
                "knowledge_runtime.services.index_executor.DocumentService",
                return_value=mock_document_service,
            ),
            patch("httpx.AsyncClient") as mock_client,
            patch("knowledge_runtime.config._settings", None),
        ):
            mock_response = MagicMock()
            mock_response.content = b"content"
            mock_response.raise_for_status = MagicMock()
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            executor = IndexExecutor()

            with pytest.raises(ValueError, match="Storage connection failed"):
                await executor.execute(index_request)
