# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document reads and lifecycle of the legacy Milvus adapter.

The legacy adapter owns no document replacement of its own: the business layer
deletes a document's previous rows before the write, and these are the tests
the online main branch shipped for the reads, the deletes, the parent sidecar
and the drop - split by behaviour domain instead of one oversized module, and
importing that module as they always did.
"""

from unittest.mock import MagicMock, patch

import pytest

from knowledge_engine.storage.milvus_backend import MilvusBackend


class TestDeleteDocument:
    """Tests for delete_document method."""

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_delete_document(self, mock_client_class, mock_milvus_vs):
        """Test deleting a document."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.return_value = True

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
        mock_client.delete.assert_called_once_with(
            collection_name="test_kb_kb_1__parents",
            filter='knowledge_id == "kb_1" and doc_ref == "doc_123"',
        )
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_delete_document_skips_an_absent_parent_sidecar(
        self, mock_client_class, mock_milvus_vs
    ):
        """A document delete needs no parent sidecar to exist.

        The chunks live in the collection the LlamaIndex store owns; the
        sidecar only appears once a document stored parent bodies, so a
        knowledge base without one still deletes its document.
        """
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.return_value = False

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        mock_store.get_nodes.return_value = [MagicMock()]

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_document(knowledge_id="kb_1", doc_ref="doc_123")

        assert result["doc_ref"] == "doc_123"
        assert result["deleted_chunks"] == 1
        assert result["status"] == "deleted"
        mock_store.delete_nodes.assert_called_once()
        mock_client.delete.assert_not_called()


class TestDeleteKnowledge:
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_delete_knowledge_removes_all_chunks_for_one_knowledge_id(
        self, mock_client_class
    ):
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.side_effect = [True, True]
        mock_client.query.side_effect = [
            [{"doc_ref": "doc_1"}, {"doc_ref": "doc_2"}],
            [{"doc_ref": "doc_1"}],
        ]

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_knowledge(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "deleted_chunks": 2,
            "deleted_parent_nodes": 1,
            "status": "deleted",
        }
        mock_client.delete.assert_any_call(
            collection_name="test_kb_kb_1",
            filter='knowledge_id == "kb_1"',
        )
        mock_client.delete.assert_any_call(
            collection_name="test_kb_kb_1__parents",
            filter='knowledge_id == "kb_1"',
        )
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_delete_knowledge_reports_nothing_without_the_collections(
        self, mock_client_class
    ):
        """A knowledge base the server does not have deletes nothing."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.return_value = False

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_knowledge(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "deleted_chunks": 0,
            "deleted_parent_nodes": 0,
            "status": "deleted",
        }
        mock_client.delete.assert_not_called()


class TestDropKnowledgeIndex:
    def test_drop_knowledge_index_rejects_shared_index_strategy(self) -> None:
        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "rolling", "prefix": "test"},
            }
        )

        with pytest.raises(ValueError, match="Physical index drop is only allowed"):
            backend.drop_knowledge_index(knowledge_id="kb_1", user_id=7)

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_drop_knowledge_index_drops_dedicated_kb_collection_and_parent_store(
        self, mock_client_class
    ):
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.side_effect = [True, True]

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.drop_knowledge_index(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "collection_name": "test_kb_kb_1",
            "dropped_parent_collection": True,
            "status": "dropped",
        }
        mock_client.drop_collection.assert_any_call(collection_name="test_kb_kb_1")
        mock_client.drop_collection.assert_any_call(
            collection_name="test_kb_kb_1__parents"
        )
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_drop_knowledge_index_is_idempotent_without_the_collections(
        self, mock_client_class
    ):
        """A drop of a knowledge base the server does not have answers dropped.

        A dedicated collection is the only thing a drop removes, so a
        knowledge base that was never indexed - or whose drop already ran -
        leaves nothing to remove and nothing to fail.
        """
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.return_value = False

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.drop_knowledge_index(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "collection_name": "test_kb_kb_1",
            "dropped_parent_collection": False,
            "status": "dropped",
        }
        mock_client.drop_collection.assert_not_called()


class TestSaveParentNodes:
    """Tests for parent-node persistence."""

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_save_parent_nodes_replaces_existing_rows(self, mock_client_class):
        """Test parent-node writes are idempotent for retries."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.return_value = True

        parent_node = MagicMock()
        parent_node.node_id = "parent-1"
        parent_node.text = "parent content"
        parent_node.metadata = {
            "doc_ref": "doc_123",
            "source_file": "test.txt",
            "chunk_strategy": "hierarchical",
        }

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        backend.save_parent_nodes(
            knowledge_id="kb_1",
            parent_nodes=[parent_node],
        )
        backend.save_parent_nodes(
            knowledge_id="kb_1",
            parent_nodes=[parent_node],
        )

        assert mock_client.delete.call_count == 2
        assert mock_client.insert.call_count == 2
        mock_client.delete.assert_called_with(
            collection_name="test_kb_kb_1__parents",
            filter='knowledge_id == "kb_1" and doc_ref == "doc_123"',
        )
        assert mock_client.close.call_count == 2


class TestGetDocument:
    """Tests for get_document method."""

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
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
        mock_store.get_nodes.return_value = [mock_node2, mock_node1]

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
        assert result["chunks"][0]["chunk_index"] == 0
        assert result["chunks"][1]["chunk_index"] == 1

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
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

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_list_documents(self, mock_client_class):
        """Test listing documents with pagination."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = ["test_kb_kb_1"]

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
        assert result["documents"][0]["doc_ref"] == "doc_2"
        assert result["documents"][0]["chunk_count"] == 1
        assert result["documents"][1]["doc_ref"] == "doc_1"
        assert result["documents"][1]["chunk_count"] == 2
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_list_documents_empty_collection(self, mock_client_class):
        """Test listing documents when collection doesn't exist."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = []

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.list_documents(knowledge_id="kb_1", page=1, page_size=10)

        assert result["total"] == 0
        assert result["documents"] == []
        mock_client.close.assert_called_once()


class TestGetAllChunks:
    """Tests for get_all_chunks method."""

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
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
        assert result[0]["chunk_id"] == 0
        assert result[1]["chunk_id"] == 1
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
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
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_get_all_chunks_applies_metadata_condition(self, mock_client_class):
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = ["test_kb_kb_1"]
        mock_client.query.return_value = [
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "chunk_index": 0,
                "text": "chunk 1 content",
                "lang": "zh",
            },
            {
                "doc_ref": "doc_2",
                "source_file": "file2.txt",
                "chunk_index": 1,
                "text": "chunk 2 content",
                "lang": "en",
            },
        ]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.get_all_chunks(
            knowledge_id="kb_1",
            max_chunks=100,
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "lang", "operator": "eq", "value": "zh"}],
            },
        )

        assert [chunk["doc_ref"] for chunk in result] == ["doc_1"]
        mock_client.close.assert_called_once()
