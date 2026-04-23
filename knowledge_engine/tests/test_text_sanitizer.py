# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest
from llama_index.core import Document
from llama_index.core.schema import NodeRelationship, RelatedNodeInfo, TextNode

from knowledge_engine.index.indexer import DocumentIndexer, sanitize_documents
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.text_sanitizer import sanitize_text_for_indexing


class _FakeStorageBackend(BaseStorageBackend):
    SUPPORTED_RETRIEVAL_METHODS = ("vector",)

    def __init__(self):
        super().__init__({})
        self.indexed_nodes = None

    def create_vector_store(self, index_name: str):
        return None

    def index_with_metadata(self, nodes, chunk_metadata, embed_model, **kwargs):
        self.indexed_nodes = nodes
        return {
            "indexed_count": len(nodes),
            "index_name": "test-index",
            "status": "success",
        }

    def retrieve(
        self,
        knowledge_id,
        query,
        embed_model,
        retrieval_setting,
        metadata_condition=None,
        **kwargs,
    ):
        return {"records": []}

    def delete_document(self, knowledge_id, doc_ref, **kwargs):
        return {"status": "success"}

    def delete_knowledge(self, knowledge_id: str, **kwargs):
        return {"status": "success"}

    def drop_knowledge_index(self, knowledge_id: str, **kwargs):
        return {"status": "success"}

    def get_document(self, knowledge_id, doc_ref, **kwargs):
        return {}

    def list_documents(self, knowledge_id, page=1, page_size=20, **kwargs):
        return {}

    def test_connection(self) -> bool:
        return True

    def get_all_chunks(self, knowledge_id, max_chunks=10000, **kwargs):
        return []


@pytest.mark.unit
class TestTextSanitizer:
    def test_replaces_markdown_image_data_url_with_alt_placeholder(self) -> None:
        text = "Before ![architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA) after"

        result = sanitize_text_for_indexing(text)

        assert result.text == "Before ![architecture]([inline image omitted]) after"
        assert result.replacement_summary["inline_image"] == 1

    def test_replaces_markdown_image_without_alt_with_placeholder(self) -> None:
        text = "![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)"

        result = sanitize_text_for_indexing(text)

        assert result.text == "[inline image omitted]"
        assert result.replacements_count == 1

    def test_replaces_pdf_data_url_with_pdf_placeholder(self) -> None:
        text = "See data:application/pdf;base64,JVBERi0xLjQKJcTl8uXr and continue"

        result = sanitize_text_for_indexing(text)

        assert result.text == "See [inline pdf omitted] and continue"
        assert result.replacement_summary["inline_pdf"] == 1

    def test_replaces_generic_data_url_with_binary_placeholder(self) -> None:
        text = "payload=data:application/octet-stream;base64,QUJDREVGR0g="

        result = sanitize_text_for_indexing(text)

        assert result.text == "payload=[embedded binary content omitted]"
        assert result.replacement_summary["embedded_binary"] == 1

    def test_replaces_url_safe_base64_data_url_with_binary_placeholder(self) -> None:
        text = "payload=data:application/octet-stream;base64,QUJDREVG-_8="

        result = sanitize_text_for_indexing(text)

        assert result.text == "payload=[embedded binary content omitted]"
        assert result.replacement_summary["embedded_binary"] == 1

    def test_replaces_line_wrapped_markdown_image_data_url(self) -> None:
        text = (
            "![architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA\n"
            " iVBORw0KGgoAAAANSUhEUgAAAAUB)"
        )

        result = sanitize_text_for_indexing(text)

        assert result.text == "![architecture]([inline image omitted])"
        assert result.replacement_summary["inline_image"] == 1

    def test_replaces_line_wrapped_pdf_data_url_with_pdf_placeholder(self) -> None:
        text = "See data:application/pdf;base64,JVBERi0xLjQK\n JcTl8uXr and continue"

        result = sanitize_text_for_indexing(text)

        assert result.text == "See [inline pdf omitted] and continue"
        assert result.replacement_summary["inline_pdf"] == 1

    def test_keeps_long_bare_base64_blob(self) -> None:
        blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" * 12

        result = sanitize_text_for_indexing(f"prefix {blob} suffix")

        assert result.text == f"prefix {blob} suffix"
        assert result.replacements_count == 0

    def test_keeps_normal_text_and_short_base64_like_tokens(self) -> None:
        text = "Keep token QUJDREVGR0g= and url https://example.com intact"

        result = sanitize_text_for_indexing(text)

        assert result.text == text
        assert result.replacements_count == 0

    def test_preserves_inline_image_data_url_for_image_capable_embedder(self) -> None:
        text = "![architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)"

        result = sanitize_text_for_indexing(text, sanitize_inline_images=False)

        assert result.text == text
        assert result.replacements_count == 0

    def test_sanitize_documents_updates_existing_document_in_place(self) -> None:
        document = Document(
            text="![architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)",
            relationships={
                NodeRelationship.SOURCE: RelatedNodeInfo(node_id="source-node")
            },
        )

        sanitized_documents = sanitize_documents(
            [document],
            sanitize_inline_images=True,
        )

        assert sanitized_documents == [document]
        assert sanitized_documents[0].text == "![architecture]([inline image omitted])"
        assert sanitized_documents[0].relationships == {
            NodeRelationship.SOURCE: RelatedNodeInfo(node_id="source-node")
        }

    def test_indexer_sanitizes_documents_before_splitter(self) -> None:
        storage_backend = _FakeStorageBackend()
        splitter = MagicMock()
        splitter.split_documents.return_value = [TextNode(text="chunk")]
        with patch(
            "knowledge_engine.index.indexer.prepare_ingestion",
        ) as mock_prepare:
            mock_prepare.return_value = MagicMock(
                normalized_splitter_config=MagicMock(
                    model_dump=lambda **kw: {"chunk_strategy": "semantic"}
                )
            )
            indexer = DocumentIndexer(
                storage_backend=storage_backend,
                embed_model=MagicMock(),
                splitter_config={},
                file_extension=".md",
            )
        documents = [
            Document(
                text="![architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)"
            )
        ]
        chunk_metadata = ChunkMetadata(
            knowledge_id="1",
            doc_ref="doc_1",
            source_file="test.md",
            created_at="2026-03-31T00:00:00+00:00",
        )

        # Mock the build_ingestion_result to capture sanitized documents
        with patch(
            "knowledge_engine.index.indexer.build_ingestion_result"
        ) as mock_build:
            mock_build.return_value = MagicMock(
                index_nodes=[TextNode(text="chunk")],
                parent_nodes=None,
                parser_subtype=None,
            )
            indexer._index_documents(documents=documents, chunk_metadata=chunk_metadata)

        # Check that documents were sanitized before build_ingestion_result was called
        call_args = mock_build.call_args
        sanitized_docs = call_args.kwargs.get("documents") or call_args.args[0]
        assert sanitized_docs[0].text == "![architecture]([inline image omitted])"

    def test_indexer_keeps_inline_images_for_image_capable_embedder(self) -> None:
        storage_backend = _FakeStorageBackend()
        embed_model = MagicMock()
        embed_model._additional_input_modalities = ["image"]
        with patch(
            "knowledge_engine.index.indexer.prepare_ingestion",
        ) as mock_prepare:
            mock_prepare.return_value = MagicMock(
                normalized_splitter_config=MagicMock(
                    model_dump=lambda **kw: {"chunk_strategy": "semantic"}
                )
            )
            indexer = DocumentIndexer(
                storage_backend=storage_backend,
                embed_model=embed_model,
                splitter_config={},
                file_extension=".md",
            )

        original_text = (
            "![architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)"
        )
        documents = [Document(text=original_text)]
        chunk_metadata = ChunkMetadata(
            knowledge_id="1",
            doc_ref="doc_1",
            source_file="test.md",
            created_at="2026-03-31T00:00:00+00:00",
        )

        with patch(
            "knowledge_engine.index.indexer.build_ingestion_result"
        ) as mock_build:
            mock_build.return_value = MagicMock(
                index_nodes=[TextNode(text="chunk")],
                parent_nodes=None,
                parser_subtype=None,
            )
            indexer._index_documents(documents=documents, chunk_metadata=chunk_metadata)

        call_args = mock_build.call_args
        sanitized_docs = call_args.kwargs.get("documents") or call_args.args[0]
        assert sanitized_docs[0].text == original_text
