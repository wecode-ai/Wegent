# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the embedding dimension contract on the Milvus main path."""

import logging
from unittest.mock import MagicMock, patch

import pytest
from llama_index.core.schema import TextNode
from llama_index.core.vector_stores.simple import SimpleVectorStore
from milvus_contract_stubs import (
    StubEmbeddingModel,
    collection_description,
    patch_collection,
)

from knowledge_engine.embedding.errors import (
    CollectionDimensionMismatchError,
    EmbeddingDimensionMismatchError,
    EmbeddingResponseFormatError,
)
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.milvus_backend import MilvusBackend


class TestEmbeddingDimensionContract:
    """Tests for the embedding dimension contract on the Milvus main path."""

    @staticmethod
    def _backend() -> MilvusBackend:
        return MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "username": "milvus-user",
                "password": "milvus-secret-token",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

    @staticmethod
    def _chunk_metadata() -> ChunkMetadata:
        return ChunkMetadata(
            knowledge_id="kb_1",
            doc_ref="doc_1",
            source_file="test.txt",
            created_at="2026-01-01T00:00:00",
        )

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_index_fails_before_writing_when_the_stored_dimension_differs(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(5)

        embed_model = StubEmbeddingModel(declared_dimension=3, vector_dimension=3)

        with pytest.raises(CollectionDimensionMismatchError) as exc_info:
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=embed_model,
            )

        error = exc_info.value
        assert (error.model, error.expected, error.actual) == (
            "stub-embedding-model",
            3,
            5,
        )
        assert error.code == "embedding_dimension_mismatch"
        assert error.retryable is False
        assert "http://localhost:19530" not in str(error)
        assert "milvus-secret-token" not in str(error)

        client.delete.assert_not_called()
        client.create_collection.assert_not_called()
        mock_milvus_vs.assert_not_called()
        mock_vs_index.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_index_keeps_stored_vectors_when_the_dimension_differs(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(4)

        backend = self._backend()

        with pytest.raises(EmbeddingDimensionMismatchError):
            backend.index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=StubEmbeddingModel(
                    declared_dimension=8,
                    vector_dimension=8,
                ),
            )

        client.insert.assert_not_called()
        client.upsert.assert_not_called()
        client.delete.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_index_accepts_a_collection_with_the_declared_dimension(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(1536)

        result = self._backend().index_with_metadata(
            nodes=[TextNode(text="chunk one")],
            chunk_metadata=self._chunk_metadata(),
            embed_model=StubEmbeddingModel(
                declared_dimension=1536,
                vector_dimension=1536,
            ),
        )

        assert result["status"] == "success"
        assert mock_milvus_vs.call_args.kwargs["dim"] == 1536

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_first_real_batch_decides_the_dimension_of_a_new_collection(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = StubEmbeddingModel(
            declared_dimension=None,
            vector_dimension=8,
        )

        self._backend().index_with_metadata(
            nodes=[TextNode(text="chunk one"), TextNode(text="chunk two")],
            chunk_metadata=self._chunk_metadata(),
            embed_model=embed_model,
        )

        assert mock_milvus_vs.call_args.kwargs["dim"] == 8
        assert embed_model.text_batches == [["chunk one", "chunk two"]]

        written_nodes = mock_vs_index.call_args.args[0]
        assert [node.embedding for node in written_nodes] == [
            [0.5] * 8,
            [0.5] * 8,
        ]

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_compatibility_path_does_not_probe_or_persist_the_dimension(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = StubEmbeddingModel(
            declared_dimension=None,
            vector_dimension=8,
        )

        self._backend().index_with_metadata(
            nodes=[TextNode(text="chunk one")],
            chunk_metadata=self._chunk_metadata(),
            embed_model=embed_model,
        )

        assert embed_model.query_requests == []
        assert len(embed_model.text_batches) == 1
        assert not hasattr(embed_model, "_dimension")

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_real_llama_index_write_reuses_the_first_batch_vectors(
        self,
        mock_milvus_vs,
        mock_client_cls,
    ):
        """Let the real LlamaIndex write run to prove the vectors are reused."""
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False
        vector_store = SimpleVectorStore()
        mock_milvus_vs.return_value = vector_store

        embed_model = StubEmbeddingModel(
            declared_dimension=None,
            vector_dimension=4,
        )

        self._backend().index_with_metadata(
            nodes=[TextNode(text="chunk one"), TextNode(text="chunk two")],
            chunk_metadata=self._chunk_metadata(),
            embed_model=embed_model,
        )

        assert embed_model.text_batches[0] == ["chunk one", "chunk two"]
        # LlamaIndex never asks the provider again for texts it already has vectors for.
        assert [batch for batch in embed_model.text_batches[1:] if batch] == []
        stored_vectors = list(vector_store.data.embedding_dict.values())
        assert stored_vectors == [[0.5] * 4, [0.5] * 4]

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_compatibility_path_fails_on_a_mismatched_existing_collection(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(8)

        with pytest.raises(CollectionDimensionMismatchError):
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=StubEmbeddingModel(
                    declared_dimension=None,
                    vector_dimension=4,
                ),
            )

        mock_milvus_vs.assert_not_called()

    @pytest.mark.parametrize("retrieval_mode", ["vector", "hybrid"])
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_vector_queries_fail_when_the_stored_dimension_differs(
        self,
        mock_client_cls,
        mock_milvus_vs,
        retrieval_mode: str,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(5)

        embed_model = StubEmbeddingModel(declared_dimension=3, vector_dimension=3)

        with pytest.raises(CollectionDimensionMismatchError):
            self._backend().retrieve(
                knowledge_id="kb_1",
                query="test query",
                embed_model=embed_model,
                retrieval_setting={"top_k": 10, "retrieval_mode": retrieval_mode},
            )

        assert embed_model.query_requests == []
        mock_milvus_vs.assert_not_called()

    @pytest.mark.parametrize("retrieval_mode", ["vector", "hybrid"])
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_queries_of_a_model_without_declared_dimension_compare_the_real_vector(
        self,
        mock_client_cls,
        mock_milvus_vs,
        retrieval_mode: str,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(5)

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        embed_model = StubEmbeddingModel(
            declared_dimension=None,
            vector_dimension=3,
        )

        with pytest.raises(CollectionDimensionMismatchError) as exc_info:
            self._backend().retrieve(
                knowledge_id="kb_1",
                query="test query",
                embed_model=embed_model,
                retrieval_setting={"top_k": 10, "retrieval_mode": retrieval_mode},
            )

        assert (exc_info.value.expected, exc_info.value.actual) == (3, 5)
        assert embed_model.query_requests == ["test query"]
        mock_store.query.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_existing_collection_without_a_vector_dimension_fails_closed(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = {
            "fields": [{"name": "pk", "params": {}}]
        }

        with pytest.raises(CollectionDimensionMismatchError) as exc_info:
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=StubEmbeddingModel(
                    declared_dimension=1024,
                    vector_dimension=1024,
                ),
            )

        assert exc_info.value.actual == 0
        assert "dense vector" in str(exc_info.value)
        mock_milvus_vs.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_keyword_queries_ignore_the_stored_dimension(
        self,
        mock_client_cls,
        mock_milvus_vs,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(5)

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        node = MagicMock()
        node.text = "keyword result"
        node.metadata = {"source_file": "doc.txt", "knowledge_id": "kb_1"}
        mock_store.query.return_value = MagicMock(nodes=[node], similarities=[0.8])

        embed_model = StubEmbeddingModel(declared_dimension=3, vector_dimension=3)

        result = self._backend().retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=embed_model,
            retrieval_setting={"top_k": 10, "retrieval_mode": "keyword"},
        )

        assert result["records"][0]["content"] == "keyword result"
        assert embed_model.query_requests == []

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_query_does_not_create_a_missing_collection(
        self,
        mock_client_cls,
        mock_milvus_vs,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = StubEmbeddingModel(
            declared_dimension=1536,
            vector_dimension=1536,
        )

        result = self._backend().retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=embed_model,
            retrieval_setting={"top_k": 10, "retrieval_mode": "vector"},
        )

        assert result == {"records": []}
        assert embed_model.query_requests == []
        client.create_collection.assert_not_called()
        mock_milvus_vs.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_declared_model_uses_the_first_batch_as_build_evidence(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = StubEmbeddingModel(
            declared_dimension=1536,
            vector_dimension=1536,
        )

        self._backend().index_with_metadata(
            nodes=[TextNode(text="chunk one"), TextNode(text="chunk two")],
            chunk_metadata=self._chunk_metadata(),
            embed_model=embed_model,
        )

        assert embed_model.text_batches == [["chunk one", "chunk two"]]
        assert mock_milvus_vs.call_args.kwargs["dim"] == 1536

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_declared_model_fails_before_creating_a_collection(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = StubEmbeddingModel(
            declared_dimension=1536,
            vector_dimension=768,
        )

        with pytest.raises(EmbeddingDimensionMismatchError) as exc_info:
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=embed_model,
            )

        assert (exc_info.value.expected, exc_info.value.actual) == (1536, 768)
        mock_milvus_vs.assert_not_called()
        client.create_collection.assert_not_called()

    @pytest.mark.parametrize(
        "vectors",
        [
            [[0.5] * 4],
            [],
            [[0.5] * 4, [0.5] * 6],
        ],
    )
    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_malformed_provider_batch_fails_before_any_write(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
        vectors,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = StubEmbeddingModel(
            declared_dimension=None,
            vector_dimension=4,
        )
        embed_model.batch_response = vectors

        with pytest.raises(EmbeddingResponseFormatError):
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one"), TextNode(text="chunk two")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=embed_model,
            )

        mock_milvus_vs.assert_not_called()
        client.create_collection.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_compatibility_path_logs_a_warning(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
        caplog,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        with caplog.at_level(
            logging.WARNING,
            logger="knowledge_engine.storage.milvus_backend",
        ):
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=StubEmbeddingModel(
                    declared_dimension=None,
                    vector_dimension=8,
                ),
            )

        assert "Compatibility path" in caplog.text
        assert "8 dimensions" in caplog.text

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_delete_document_still_runs_when_the_stored_dimension_differs(
        self,
        mock_client_cls,
        mock_milvus_vs,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(5)

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        mock_store.get_nodes.return_value = [MagicMock(), MagicMock()]

        result = self._backend().delete_document(
            knowledge_id="kb_1",
            doc_ref="doc_1",
        )

        assert result["deleted_chunks"] == 2
        mock_store.delete_nodes.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_reindex_delete_fails_before_deleting_on_a_dimension_mismatch(
        self,
        mock_client_cls,
        mock_milvus_vs,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = collection_description(5)

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        with pytest.raises(CollectionDimensionMismatchError) as exc_info:
            self._backend().delete_document(
                knowledge_id="kb_1",
                doc_ref="doc_1",
                expected_embedding_dimension=1536,
                expected_embedding_model="embedding-model",
            )

        assert exc_info.value.model == "embedding-model"
        assert (exc_info.value.expected, exc_info.value.actual) == (1536, 5)
        mock_store.delete_nodes.assert_not_called()

    @pytest.mark.parametrize("value", [float("nan"), float("inf")])
    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_non_finite_provider_values_fail_before_any_write(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
        value: float,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = StubEmbeddingModel(declared_dimension=None, vector_dimension=4)
        embed_model.batch_response = [[0.5, value, 0.5, 0.5]]

        with pytest.raises(EmbeddingResponseFormatError, match="non-finite"):
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=embed_model,
            )

        mock_milvus_vs.assert_not_called()
        client.create_collection.assert_not_called()
