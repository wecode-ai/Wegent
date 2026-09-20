# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Construction, connection, indexing and naming of the legacy adapter.

The legacy Milvus adapter is a frozen snapshot of the module the online main
branch shipped, so these are the tests that branch shipped - split by behaviour
domain instead of one oversized module, and importing that module as they
always did.
"""

from unittest.mock import MagicMock, patch

from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.milvus_backend import MilvusBackend


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


class TestTestConnection:
    """Tests for test_connection method."""

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
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
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
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
        mock_client.close.assert_called_once()


class TestIndexWithMetadata:
    """Tests for index_with_metadata method.

    Note: Metadata is now applied by the indexer layer via chunk_metadata.apply_to_nodes()
    before calling index_with_metadata. The storage backend no longer applies metadata
    to nodes - it only uses ChunkMetadata for index name generation.
    """

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_index_with_metadata(self, mock_milvus_vs, mock_storage_ctx, mock_vs_index):
        """Test indexing nodes with metadata."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_ctx = MagicMock()
        mock_storage_ctx.from_defaults.return_value = mock_ctx

        mock_node1 = MagicMock()
        mock_node1.metadata = {
            "knowledge_id": "kb_1",
            "doc_ref": "doc_123",
            "source_file": "test.txt",
            "chunk_index": 0,
            "created_at": "2024-01-01T00:00:00",
        }
        mock_node2 = MagicMock()
        mock_node2.metadata = {
            "knowledge_id": "kb_1",
            "doc_ref": "doc_123",
            "source_file": "test.txt",
            "chunk_index": 1,
            "created_at": "2024-01-01T00:00:00",
        }

        mock_embed_model = MagicMock()

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        chunk_metadata = ChunkMetadata(
            knowledge_id="kb_1",
            doc_ref="doc_123",
            source_file="test.txt",
            created_at="2024-01-01T00:00:00",
        )

        result = backend.index_with_metadata(
            nodes=[mock_node1, mock_node2],
            chunk_metadata=chunk_metadata,
            embed_model=mock_embed_model,
        )

        assert result["indexed_count"] == 2
        assert result["status"] == "success"
        assert result["index_name"] == "test_kb_kb_1"

        mock_vs_index.assert_called_once()
        call_args = mock_vs_index.call_args
        assert call_args[0][0] == [mock_node1, mock_node2]
        assert call_args[1]["storage_context"] == mock_ctx
        assert call_args[1]["embed_model"] == mock_embed_model
        assert call_args[1]["show_progress"] is True


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

        assert backend.get_index_name("1") == "milvus_collection_0"
        assert backend.get_index_name("100") == "milvus_collection_0"
        assert backend.get_index_name("101") == "milvus_collection_100"
