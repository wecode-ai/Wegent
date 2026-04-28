# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for IndexExecutor service."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knowledge_runtime.services.config_resolver import IndexConfig
from knowledge_runtime.services.index_executor import IndexExecutor
from shared.models import (
    PresignedUrlContentRef,
    RemoteIndexRequest,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrieverConfig,
)


@pytest.fixture
def mock_index_config():
    """Create a sample resolved IndexConfig."""
    return IndexConfig(
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
        splitter_config={"chunk_size": 500, "chunk_overlap": 50},
    )


@pytest.fixture
def index_request():
    """Create a sample index request (reference mode)."""
    return RemoteIndexRequest(
        knowledge_base_id=1,
        user_id=42,
        document_id=100,
        content_ref=PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/bucket/test.pdf",
        ),
        source_file="test.pdf",
        file_extension=".pdf",
    )


class TestIndexExecutor:
    """Tests for IndexExecutor."""

    @pytest.mark.asyncio
    async def test_execute_success(self, index_request, mock_index_config) -> None:
        """Test successful index execution."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_document_service = MagicMock()
        mock_db = MagicMock()

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
            executor = IndexExecutor(db=mock_db)
            executor._config_resolver.resolve_index_config = MagicMock(
                return_value=mock_index_config
            )

            mock_response = MagicMock()
            mock_response.content = b"test content"
            mock_response.raise_for_status = MagicMock()
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            result = await executor.execute(index_request)

        assert result["chunk_count"] == 5
        assert result["doc_ref"] == "100"
        mock_document_service.index_document_from_binary.assert_called_once()

        # Verify ConfigResolver was called with correct args
        executor._config_resolver.resolve_index_config.assert_called_once_with(
            db=mock_db,
            knowledge_base_id=1,
            user_id=42,
            document_id=100,
        )

    @pytest.mark.asyncio
    async def test_execute_uses_request_metadata_over_fetched(
        self, index_request, mock_index_config
    ) -> None:
        """Test that request metadata overrides fetched content metadata."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_document_service = MagicMock()
        mock_db = MagicMock()

        mock_document_service.index_document_from_binary = AsyncMock(
            return_value={
                "chunk_count": 3,
                "doc_ref": "100",
            }
        )

        with (
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
            executor = IndexExecutor(db=mock_db)
            executor._config_resolver.resolve_index_config = MagicMock(
                return_value=mock_index_config
            )

            mock_response = MagicMock()
            # Content from fetch has different filename
            mock_response.content = b"content"
            mock_response.raise_for_status = MagicMock()
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            await executor.execute(index_request)

        call_kwargs = mock_document_service.index_document_from_binary.call_args.kwargs
        # Should use request metadata, not fetched
        assert call_kwargs["source_file"] == "test.pdf"
        assert call_kwargs["file_extension"] == ".pdf"

    @pytest.mark.asyncio
    async def test_execute_uses_resolved_configs(
        self, index_request, mock_index_config
    ) -> None:
        """Test that resolved configs are passed to storage/embedding factories."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_document_service = MagicMock()
        mock_db = MagicMock()

        mock_document_service.index_document_from_binary = AsyncMock(
            return_value={"chunk_count": 1, "doc_ref": "100"}
        )

        with (
            patch(
                "knowledge_runtime.services.index_executor.create_storage_backend_from_runtime_config",
                return_value=mock_storage_backend,
            ) as mock_create_storage,
            patch(
                "knowledge_runtime.services.index_executor.create_embedding_model_from_runtime_config",
                return_value=mock_embed_model,
            ) as mock_create_embed,
            patch(
                "knowledge_runtime.services.index_executor.DocumentService",
                return_value=mock_document_service,
            ),
            patch("httpx.AsyncClient") as mock_client,
            patch("knowledge_runtime.config._settings", None),
        ):
            executor = IndexExecutor(db=mock_db)
            executor._config_resolver.resolve_index_config = MagicMock(
                return_value=mock_index_config
            )

            mock_response = MagicMock()
            mock_response.content = b"content"
            mock_response.raise_for_status = MagicMock()
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            await executor.execute(index_request)

        # Verify factories were called with resolved configs
        mock_create_storage.assert_called_once_with(mock_index_config.retriever_config)
        mock_create_embed.assert_called_once_with(
            mock_index_config.embedding_model_config
        )

        # Verify document service was called with resolved user_id and splitter_config
        call_kwargs = mock_document_service.index_document_from_binary.call_args.kwargs
        assert call_kwargs["user_id"] == 7
        assert call_kwargs["splitter_config"] == {
            "chunk_size": 500,
            "chunk_overlap": 50,
        }

    @pytest.mark.asyncio
    async def test_execute_content_fetch_error_propagates(
        self, index_request, mock_index_config
    ) -> None:
        """Test that content fetch errors propagate correctly."""
        from knowledge_runtime.services.content_fetcher import ContentFetchError

        mock_db = MagicMock()

        with (
            patch("httpx.AsyncClient") as mock_client,
            patch("knowledge_runtime.config._settings", None),
        ):
            executor = IndexExecutor(db=mock_db)
            executor._config_resolver.resolve_index_config = MagicMock(
                return_value=mock_index_config
            )

            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                side_effect=ContentFetchError("Fetch failed", retryable=True)
            )

            with pytest.raises(ContentFetchError) as exc_info:
                await executor.execute(index_request)

            assert exc_info.value.retryable

    @pytest.mark.asyncio
    async def test_execute_storage_error_propagates(
        self, index_request, mock_index_config
    ) -> None:
        """Test that storage backend errors propagate correctly."""
        mock_storage_backend = MagicMock()
        mock_embed_model = MagicMock()
        mock_document_service = MagicMock()
        mock_db = MagicMock()

        mock_document_service.index_document_from_binary = AsyncMock(
            side_effect=ValueError("Storage connection failed")
        )

        with (
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
            executor = IndexExecutor(db=mock_db)
            executor._config_resolver.resolve_index_config = MagicMock(
                return_value=mock_index_config
            )

            mock_response = MagicMock()
            mock_response.content = b"content"
            mock_response.raise_for_status = MagicMock()
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            with pytest.raises(ValueError, match="Storage connection failed"):
                await executor.execute(index_request)

    @pytest.mark.asyncio
    async def test_execute_config_resolution_error_propagates(
        self, index_request
    ) -> None:
        """Test that config resolution errors propagate correctly."""
        from knowledge_runtime.services.config_resolver import ConfigResolutionError

        mock_db = MagicMock()

        executor = IndexExecutor(db=mock_db)
        executor._config_resolver.resolve_index_config = MagicMock(
            side_effect=ConfigResolutionError(
                "config_not_found", "Knowledge base 1 not found"
            )
        )

        with pytest.raises(ConfigResolutionError) as exc_info:
            await executor.execute(index_request)

        assert exc_info.value.code == "config_not_found"
