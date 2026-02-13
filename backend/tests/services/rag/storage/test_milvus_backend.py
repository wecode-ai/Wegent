# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for MilvusBackend storage backend implementation.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.rag.storage.milvus_backend import MilvusBackend


class TestMilvusBackendInit:
    """Tests for MilvusBackend initialization."""

    def test_init_with_full_config(self):
        """Test initialization with username and password."""
        config = {
            "url": "http://localhost:19530/default",
            "username": "testuser",
            "password": "testpassword",
            "indexStrategy": {"mode": "per_user"},
            "ext": {"dim": 768},
        }
        backend = MilvusBackend(config)

        assert backend.url == "http://localhost:19530/default"
        assert backend.username == "testuser"
        assert backend.password == "testpassword"
        assert backend.token == "testuser:testpassword"
        assert backend.dim == 768

    def test_init_without_auth(self):
        """Test initialization without authentication credentials."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset"},
            "ext": {},
        }
        backend = MilvusBackend(config)

        assert backend.url == "http://localhost:19530/default"
        assert backend.username is None
        assert backend.password is None
        assert backend.token == ""
        assert backend.dim == 1024  # Default dimension (DEFAULT_EMBEDDING_DIM)

    def test_init_with_partial_auth(self):
        """Test initialization with only username (no password)."""
        config = {
            "url": "http://localhost:19530/default",
            "username": "testuser",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.token == ""  # Should be empty if password is missing

    def test_init_default_dim(self):
        """Test that default dimension is 1024 when not specified."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)
        assert backend.dim == 1024

    def test_init_db_name_from_url_path(self):
        """Test that db_name is extracted from URL path."""
        config = {
            "url": "http://localhost:19530/mydb",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.db_name == "mydb"
        assert backend.base_url == "http://localhost:19530"

    def test_init_db_name_default_when_no_path(self):
        """Test that db_name defaults to 'default' when URL has no path."""
        config = {
            "url": "http://localhost:19530",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.db_name == "default"
        assert backend.base_url == "http://localhost:19530"

    def test_init_db_name_from_ext_takes_priority(self):
        """Test that ext.db_name takes priority over URL path."""
        config = {
            "url": "http://localhost:19530/url_db",
            "indexStrategy": {"mode": "per_dataset"},
            "ext": {"db_name": "ext_db"},
        }
        backend = MilvusBackend(config)

        # ext.db_name should take priority
        assert backend.db_name == "ext_db"
        # URL should remain unchanged when ext.db_name is used
        assert backend.base_url == "http://localhost:19530/url_db"


class TestMilvusBackendClassAttributes:
    """Tests for class-level attributes."""

    def test_supported_retrieval_methods(self):
        """Test that all three retrieval methods are supported."""
        assert "vector" in MilvusBackend.SUPPORTED_RETRIEVAL_METHODS
        assert "keyword" in MilvusBackend.SUPPORTED_RETRIEVAL_METHODS
        assert "hybrid" in MilvusBackend.SUPPORTED_RETRIEVAL_METHODS
        assert len(MilvusBackend.SUPPORTED_RETRIEVAL_METHODS) == 3

    def test_index_prefix(self):
        """Test that INDEX_PREFIX is 'collection'."""
        assert MilvusBackend.INDEX_PREFIX == "collection"

    def test_get_supported_retrieval_methods(self):
        """Test get_supported_retrieval_methods class method."""
        methods = MilvusBackend.get_supported_retrieval_methods()
        assert methods == ["vector", "keyword", "hybrid"]


class TestCreateVectorStore:
    """Tests for create_vector_store method."""

    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_create_vector_store_basic(self, mock_milvus_vs):
        """Test creating a vector store with basic parameters.

        Verifies that db_name is extracted from URL path and passed as separate parameter.
        """
        config = {
            "url": "http://localhost:19530/mydb",
            "username": "user",
            "password": "pass",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        backend.create_vector_store("test_collection")

        # db_name should be extracted from URL path and passed separately
        mock_milvus_vs.assert_called_once_with(
            uri="http://localhost:19530",  # base URL without db_name path
            token="user:pass",
            db_name="mydb",  # db_name as separate parameter
            collection_name="test_collection",
            dim=1024,  # DEFAULT_EMBEDDING_DIM
            upsert_mode=True,
            overwrite=False,
            enable_sparse=True,
            hybrid_ranker="RRFRanker",
        )


class TestRetrieve:
    """Tests for retrieve method."""

    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_retrieve_vector_mode(self, mock_milvus_vs):
        """Test retrieval in vector mode."""
        # Setup mock
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_node = MagicMock()
        mock_node.text = "test content"
        mock_node.metadata = {"source_file": "test.txt", "knowledge_id": "kb_1"}
        mock_result.nodes = [mock_node]
        mock_result.similarities = [0.9]
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "vector",
            },
        )

        assert "records" in result
        assert len(result["records"]) == 1
        assert result["records"][0]["content"] == "test content"
        assert result["records"][0]["score"] == 0.9

    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_retrieve_keyword_mode(self, mock_milvus_vs):
        """Test retrieval in keyword mode."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_node = MagicMock()
        mock_node.text = "keyword result"
        mock_node.metadata = {"source_file": "doc.txt", "knowledge_id": "kb_1"}
        mock_result.nodes = [mock_node]
        mock_result.similarities = [0.8]
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "keyword",
            },
        )

        assert "records" in result
        # Keyword mode should not call get_query_embedding
        mock_embed_model.get_query_embedding.assert_not_called()

    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_retrieve_hybrid_mode(self, mock_milvus_vs):
        """Test retrieval in hybrid mode."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_node = MagicMock()
        mock_node.text = "hybrid result"
        mock_node.metadata = {"source_file": "hybrid.txt", "knowledge_id": "kb_1"}
        mock_result.nodes = [mock_node]
        mock_result.similarities = [0.85]
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "hybrid",
            },
        )

        assert "records" in result
        # Hybrid mode should call get_query_embedding
        mock_embed_model.get_query_embedding.assert_called_once()

    def test_retrieve_invalid_mode(self):
        """Test that invalid retrieval mode raises ValueError."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        mock_embed_model = MagicMock()

        with pytest.raises(
            ValueError, match="does not support 'invalid' retrieval mode"
        ):
            backend.retrieve(
                knowledge_id="kb_1",
                query="test query",
                embed_model=mock_embed_model,
                retrieval_setting={"retrieval_mode": "invalid"},
            )

    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_retrieve_score_threshold_filtering(self, mock_milvus_vs):
        """Test that results below score threshold are filtered out."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_node1 = MagicMock()
        mock_node1.text = "high score"
        mock_node1.metadata = {"source_file": "high.txt", "knowledge_id": "kb_1"}
        mock_node2 = MagicMock()
        mock_node2.text = "low score"
        mock_node2.metadata = {"source_file": "low.txt", "knowledge_id": "kb_1"}
        mock_result.nodes = [mock_node1, mock_node2]
        mock_result.similarities = [0.9, 0.3]
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "vector",
            },
        )

        # Only high score result should be returned
        assert len(result["records"]) == 1
        assert result["records"][0]["content"] == "high score"


class TestDeleteDocument:
    """Tests for delete_document method."""

    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_delete_document(self, mock_milvus_vs):
        """Test deleting a document."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_node = MagicMock()
        mock_store.get_nodes.return_value = [mock_node, mock_node]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.delete_document(knowledge_id="kb_1", doc_ref="doc_123")

        assert result["doc_ref"] == "doc_123"
        assert result["knowledge_id"] == "kb_1"
        assert result["deleted_chunks"] == 2
        assert result["status"] == "deleted"
        mock_store.delete_nodes.assert_called_once()


class TestGetDocument:
    """Tests for get_document method."""

    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_get_document(self, mock_milvus_vs):
        """Test getting document details."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_node1 = MagicMock()
        mock_node1.text = "chunk 1"
        mock_node1.metadata = {"source_file": "test.txt", "chunk_index": 0}
        mock_node2 = MagicMock()
        mock_node2.text = "chunk 2"
        mock_node2.metadata = {"source_file": "test.txt", "chunk_index": 1}
        mock_store.get_nodes.return_value = [mock_node2, mock_node1]  # Out of order

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.get_document(knowledge_id="kb_1", doc_ref="doc_123")

        assert result["doc_ref"] == "doc_123"
        assert result["knowledge_id"] == "kb_1"
        assert result["source_file"] == "test.txt"
        assert result["chunk_count"] == 2
        # Verify chunks are sorted by chunk_index
        assert result["chunks"][0]["chunk_index"] == 0
        assert result["chunks"][1]["chunk_index"] == 1

    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_get_document_not_found(self, mock_milvus_vs):
        """Test getting a document that doesn't exist."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        mock_store.get_nodes.return_value = []

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        with pytest.raises(ValueError, match="not found"):
            backend.get_document(knowledge_id="kb_1", doc_ref="doc_nonexistent")


class TestListDocuments:
    """Tests for list_documents method."""

    @patch("app.services.rag.storage.milvus_backend.MilvusClient")
    def test_list_documents(self, mock_client_class):
        """Test listing documents with pagination."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = ["test_kb_kb_1"]

        # Simulate 3 chunks from 2 documents
        mock_client.query.return_value = [
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "created_at": "2024-01-01",
            },
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "created_at": "2024-01-01",
            },
            {
                "doc_ref": "doc_2",
                "source_file": "file2.txt",
                "created_at": "2024-01-02",
            },
        ]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.list_documents(knowledge_id="kb_1", page=1, page_size=10)

        assert result["total"] == 2
        assert len(result["documents"]) == 2
        assert result["page"] == 1
        assert result["page_size"] == 10
        # doc_2 should be first (newer created_at)
        assert result["documents"][0]["doc_ref"] == "doc_2"
        assert result["documents"][0]["chunk_count"] == 1
        assert result["documents"][1]["doc_ref"] == "doc_1"
        assert result["documents"][1]["chunk_count"] == 2
        # Verify client.close() is called to prevent resource leaks
        mock_client.close.assert_called_once()

    @patch("app.services.rag.storage.milvus_backend.MilvusClient")
    def test_list_documents_empty_collection(self, mock_client_class):
        """Test listing documents when collection doesn't exist."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = []  # Collection doesn't exist

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.list_documents(knowledge_id="kb_1", page=1, page_size=10)

        assert result["total"] == 0
        assert result["documents"] == []
        # Verify client.close() is called to prevent resource leaks
        mock_client.close.assert_called_once()


class TestTestConnection:
    """Tests for test_connection method."""

    @patch("app.services.rag.storage.milvus_backend.MilvusClient")
    def test_connection_success(self, mock_client_class):
        """Test successful connection."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = []

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.test_connection() is True
        # Verify client.close() is called to prevent resource leaks
        mock_client.close.assert_called_once()

    @patch("app.services.rag.storage.milvus_backend.MilvusClient")
    def test_connection_failure(self, mock_client_class):
        """Test failed connection."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.side_effect = Exception("Connection refused")

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.test_connection() is False
        # Verify client.close() is called even on failure to prevent resource leaks
        mock_client.close.assert_called_once()


class TestGetAllChunks:
    """Tests for get_all_chunks method."""

    @patch("app.services.rag.storage.milvus_backend.MilvusClient")
    def test_get_all_chunks(self, mock_client_class):
        """Test getting all chunks."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = ["test_kb_kb_1"]

        mock_client.query.return_value = [
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "chunk_index": 1,
                "text": "chunk 2 content",
            },
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "chunk_index": 0,
                "text": "chunk 1 content",
            },
        ]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.get_all_chunks(knowledge_id="kb_1", max_chunks=100)

        assert len(result) == 2
        # Verify sorted by doc_ref and chunk_index
        assert result[0]["chunk_id"] == 0
        assert result[1]["chunk_id"] == 1
        # Verify client.close() is called to prevent resource leaks
        mock_client.close.assert_called_once()

    @patch("app.services.rag.storage.milvus_backend.MilvusClient")
    def test_get_all_chunks_collection_not_exists(self, mock_client_class):
        """Test getting chunks when collection doesn't exist."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = []

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.get_all_chunks(knowledge_id="kb_1", max_chunks=100)

        assert result == []
        # Verify client.close() is called to prevent resource leaks
        mock_client.close.assert_called_once()


class TestIndexWithMetadata:
    """Tests for index_with_metadata method."""

    @patch("app.services.rag.storage.milvus_backend.VectorStoreIndex")
    @patch("app.services.rag.storage.milvus_backend.StorageContext")
    @patch("app.services.rag.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_index_with_metadata(self, mock_milvus_vs, mock_storage_ctx, mock_vs_index):
        """Test indexing nodes with metadata."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_ctx = MagicMock()
        mock_storage_ctx.from_defaults.return_value = mock_ctx

        # Create mock nodes
        mock_node1 = MagicMock()
        mock_node1.metadata = {}
        mock_node2 = MagicMock()
        mock_node2.metadata = {}

        mock_embed_model = MagicMock()

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.index_with_metadata(
            nodes=[mock_node1, mock_node2],
            knowledge_id="kb_1",
            doc_ref="doc_123",
            source_file="test.txt",
            created_at="2024-01-01T00:00:00",
            embed_model=mock_embed_model,
        )

        assert result["indexed_count"] == 2
        assert result["status"] == "success"
        assert "index_name" in result

        # Verify metadata was added to nodes
        assert mock_node1.metadata["knowledge_id"] == "kb_1"
        assert mock_node1.metadata["doc_ref"] == "doc_123"
        assert mock_node1.metadata["source_file"] == "test.txt"
        assert mock_node1.metadata["chunk_index"] == 0
        assert mock_node2.metadata["chunk_index"] == 1


class TestIndexNameGeneration:
    """Tests for index name generation based on different strategies."""

    def test_per_dataset_index_name(self):
        """Test per_dataset index name generation."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "milvus"},
        }
        backend = MilvusBackend(config)

        index_name = backend.get_index_name("kb_123")
        assert index_name == "milvus_kb_kb_123"

    def test_per_user_index_name(self):
        """Test per_user index name generation."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_user", "prefix": "milvus"},
        }
        backend = MilvusBackend(config)

        index_name = backend.get_index_name("kb_123", user_id="user_456")
        assert index_name == "milvus_user_user_456"

    def test_fixed_index_name(self):
        """Test fixed index name generation."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "fixed", "fixedName": "my_fixed_collection"},
        }
        backend = MilvusBackend(config)

        index_name = backend.get_index_name("kb_123")
        assert index_name == "my_fixed_collection"

    def test_rolling_index_name(self):
        """Test rolling index name generation."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {
                "mode": "rolling",
                "prefix": "milvus",
                "rollingStep": 100,
            },
        }
        backend = MilvusBackend(config)

        # kb_id 1-100 should go to bucket 0
        assert backend.get_index_name("1") == "milvus_collection_0"
        assert backend.get_index_name("100") == "milvus_collection_0"
        # kb_id 101-200 should go to bucket 100
        assert backend.get_index_name("101") == "milvus_collection_100"
